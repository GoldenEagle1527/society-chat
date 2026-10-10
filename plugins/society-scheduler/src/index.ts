/**
 * society-scheduler — Wake recording + bounded LLM auto-reply + heartbeat ticks.
 * Cordis service name: `societyScheduler`
 *
 * Modes:
 * - enableAutoReply: event-driven wakes (chat-smoke / society-smoke / tools-smoke)
 * - runTick: score-based drain + idle thoughts (society-run daemon)
 *
 * Guards:
 * - global exchange counter (SOCIETY_MAX_EXCHANGES)
 * - onlyAgents allowlist
 * - same agent cannot reply twice in a row unless @mentioned or replyTo their message
 * - per-agent cooldown + global cooldown
 * - each inbox message id handled at most once
 * - LLM call counters in memory.json are display-only (no daily hard cap)
 * - limited parallel replies (SOCIETY_MAX_PARALLEL_REPLIES default 5, prefer different LLM providers)
 * - at most MAX_ROOM_REPLIES_PER_TICK room replies per tick (idle/DM still parallel) to reduce same-room blindness
 * - prefer @mention / replyTo-me unread; skip stale room stimuli (>STALE_NEWER_COUNT newer msgs or age)
 * - room replies auto-set replyTo to the stimulus room message id
 * - agents may ACTION:SILENT; replies may be multi-bubble (|||)
 * - idle self-loop: mix diary with ROOM/DM; news personas often web_search then share
 * - idle DIARY/SELF: private-only prompts + remap/split outbound chat voice to ROOM
 * - idle tools: occasionally actAsAgent; search idle path has per-agent cooldown
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, InboxMessage, RoomId } from '../../../src/types.ts'
import { sleep } from '../../../src/llm-http.ts'
import { parseAgentTurn } from '../../society-llm/src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyScheduler: SocietySchedulerService
  }
  interface Events {
    'society/agent-replied'(payload: {
      agentId: AgentId
      kind: 'room' | 'direct' | 'diary' | 'idle-skip' | 'silent'
      body: string
      roomId?: string
      to?: AgentId
      stimulusId: string
    }): void
  }
}

export interface WakeRecord {
  agentId: AgentId
  reason: string
  at: string
  messageId: string
}

export interface AutoReplyOptions {
  /**
   * Max successful auto-replies in this boot.
   * Default: SOCIETY_MAX_EXCHANGES (0 = unlimited)
   */
  maxExchanges?: number
  /** If set, only these agents auto-reply. Default: all. */
  onlyAgents?: AgentId[]
  /** Min ms between any two successful exchanges (default 50). */
  cooldownMs?: number
  /** Per-agent min ms between acts (default 0 for smoke; society-run sets higher). */
  agentCooldownMs?: number
  /** Idle thought if last act older than this (default SOCIETY_IDLE_STALE_MS || 2500). */
  idleStaleMs?: number
  /** @deprecated Ignored — free models have no daily hard cap; counters remain for display. */
  dailyLlmBudget?: number
  /** Gap between multi-bubble posts (default SOCIETY_BUBBLE_GAP_MS || 400). */
  bubbleGapMs?: number
  /** Default plaza room for idle ROOM acts. */
  defaultRoomId?: RoomId
  /**
   * Max agents whose LLM calls may run at once (default SOCIETY_MAX_PARALLEL_REPLIES || 5, clamp 1–8).
   * Prefer picking agents on different providers when > 1.
   */
  maxParallelReplies?: number
  /** Min ms between search-steered idle acts per agent (default SOCIETY_IDLE_SEARCH_COOLDOWN_MS || 120000). */
  idleSearchCooldownMs?: number
}

export interface TickActionResult {
  action:
    | 'reply'
    | 'silent'
    | 'idle-room'
    | 'idle-dm'
    | 'idle-diary'
    | 'idle-self'
    | 'idle-search'
    | 'idle-none'
    | 'skip'
    | 'capped'
    | 'none'
  agentId?: AgentId
  body?: string
  provider?: string
}

export interface TickResult extends TickActionResult {
  tick: number
  exchanges: number
  maxExchanges: number
  /** When parallel > 1, every sub-act in this tick (includes the primary). */
  parallel?: TickActionResult[]
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw && /^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10))
  return fallback
}

function defaultMaxExchanges(): number {
  // 0 = unlimited
  return envInt('SOCIETY_MAX_EXCHANGES', 0)
}

/** true when a hard exchange cap is hit. maxExchanges<=0 means unlimited. */
function exchangesCapped(exchangeCount: number, maxExchanges: number): boolean {
  return maxExchanges > 0 && exchangeCount >= maxExchanges
}


/** Max room (plaza) LLM replies started in one runTick — idle/DM still parallel. */
const MAX_ROOM_REPLIES_PER_TICK = 2
/** Skip room stimulus if this many newer room messages already exist. */
const STALE_NEWER_COUNT = 8
/** Skip room stimulus older than this (ms). Default ~4 min. */
const STALE_AGE_MS = 4 * 60_000

/** Whether this inbox item @mentions the agent (or @everyone → mentioned flag on their copy). */
export function mailMentionsAgent(message: InboxMessage, agentId: AgentId): boolean {
  if (message.mentions?.includes(agentId)) return true
  // `mentioned` is set only on that recipient's fan-out copy
  if (message.mentioned && message.to === agentId) return true
  return false
}

/** Whether message.replyTo points at a room message authored by agentId. */
export function mailRepliesToAgent(
  message: InboxMessage,
  agentId: AgentId,
  findMessage: (id: string, roomId?: string) => { from: string } | undefined,
): boolean {
  if (!message.replyTo) return false
  const target = findMessage(message.replyTo, message.roomId)
  return !!target && target.from === agentId
}

/** Stale room stimulus: too many newer posts or too old. */
export function isStaleRoomStimulus(
  message: InboxMessage,
  opts: {
    messagesAfter: (roomId: string, sourceId: string) => number
    now?: number
  },
): boolean {
  if (message.kind !== 'room' || !message.roomId) return false
  const sourceId = message.sourceMessageId
  if (sourceId) {
    const newer = opts.messagesAfter(message.roomId, sourceId)
    if (newer >= STALE_NEWER_COUNT) return true
  }
  const created = Date.parse(message.createdAt)
  if (Number.isFinite(created)) {
    const now = opts.now ?? Date.now()
    if (now - created > STALE_AGE_MS) return true
  }
  return false
}

/** Score an unread for picking (higher = better). */
export function scoreUnreadForAgent(
  message: InboxMessage,
  agentId: AgentId,
  findMessage: (id: string, roomId?: string) => { from: string } | undefined,
): number {
  let score = 0
  if (message.kind === 'direct') score += 5_000
  if (mailMentionsAgent(message, agentId)) score += 20_000
  if (mailRepliesToAgent(message, agentId, findMessage)) score += 15_000
  // Prefer fresher mail slightly
  const created = Date.parse(message.createdAt)
  if (Number.isFinite(created)) score += Math.min(1_000, created / 1e10)
  return score
}

function localDayStamp(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function localClock(d = new Date()): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Interests / persona that should chase news with web_search. */
const NEWS_INTEREST_RE = /时政|新闻|辩论|政治|热点|公共议题|时事|debate|news|politics/i

function caresAboutCurrentAffairs(agentId: string, interests: string[], persona: string): boolean {
  if (agentId === 'xingchen_news') return true
  const blob = `${interests.join(' ')} ${persona}`
  return NEWS_INTEREST_RE.test(blob)
}

/** Soft per-agent idle bias (seed cast + hardcoded). Higher socialPrefer → more ROOM/DM nudges. */
function idleBiasFor(agentId: string): { preferSearch: boolean; socialPrefer: number; toolPrefer: number } {
  switch (agentId) {
    case 'xingchen_news':
      return { preferSearch: true, socialPrefer: 0.55, toolPrefer: 0.85 }
    case 'xingchen_lit':
      return { preferSearch: false, socialPrefer: 0.4, toolPrefer: 0.22 }
    case 'agnes':
      return { preferSearch: false, socialPrefer: 0.45, toolPrefer: 0.28 }
    case 'glm':
      return { preferSearch: false, socialPrefer: 0.35, toolPrefer: 0.3 }
    default:
      return { preferSearch: false, socialPrefer: 0.4, toolPrefer: 0.25 }
  }
}

/** Loose ACTION control line (optional trailing junk on same line). */
const ACTION_LINE_LOOSE_RE =
  /^ACTION:\s*(ROOM|DM:(\S+)|DIARY|SELF|NONE|SILENT|SEARCH|REPLY)\b/i

export interface IdleActionParse {
  body: string
  act: 'room' | 'dm' | 'diary' | 'self' | 'none'
  to?: string
  /** True when the model echoed a multi-ACTION menu instead of choosing one. */
  malformed?: boolean
}

/** Strip ACTION control tokens/lines so they never reach room / DM / diary. */
export function stripActionMarkup(raw: string): string {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (ACTION_LINE_LOOSE_RE.test(t)) return ''
      return line.replace(/\bACTION:\s*(ROOM|DM:\S+|DIARY|SELF|NONE|SILENT|SEARCH|REPLY)\b/gi, '')
    })
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .replace(/\|{3}/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** Count distinct ACTION directives (menu detection). */
export function countActionDirectives(text: string): number {
  const matches = String(text || '').match(
    /(?:^|\n)\s*ACTION:\s*(ROOM|DM:\S+|DIARY|SELF|NONE|SILENT|SEARCH|REPLY)\b/gi,
  )
  return matches?.length ?? 0
}

/** True if text still looks like an instruction / option menu, not speech. */
export function looksLikeInstructionMenu(text: string): boolean {
  const t = String(text || '')
  if (countActionDirectives(t) >= 2) return true
  if (/ACTION:\s*ROOM[\s\S]*ACTION:\s*DM:[\s\S]*ACTION:\s*DIARY/i.test(t)) return true
  const dashLines = (t.match(/^[-—–─]{1,3}.+$/gm) || []).length
  if (dashLines >= 2 && /ACTION:\s*(ROOM|DM|DIARY)/i.test(t)) return true
  // echoed numbered menu remnants without clean ACTION lines left
  if (
    dashLines >= 2 &&
    /(去群聊|主动私信|写一句日记|内心独白)/.test(t) &&
    /(「plaza」|agentId|随感)/i.test(t)
  ) {
    return true
  }
  return false
}

function isPlaceholderQuote(s: string): boolean {
  const t = s.trim()
  if (!t) return true
  if (/^ACTION:/i.test(t)) return true
  if (/^(ROOM|DM:|DIARY|SELF|NONE|SILENT|SEARCH|REPLY)$/i.test(t)) return true
  // room names / ids / placeholders echoed from the prompt
  if (/^(plaza|agentId|<agentId>|agnes|glm|xingchen[_a-z0-9]*)$/i.test(t)) return true
  if (t.length <= 12 && /^[A-Za-z0-9_.<>-]+$/.test(t)) return true
  return false
}

/** Pull a single concrete utterance from menu-ish model dumps. */
export function extractConcreteIdleBody(text: string): string {
  const t = String(text || '').trim()
  if (!t) return ''

  const quoteRe = /「([^」]{1,160})」|"([^"]{1,160})"|“([^”]{1,160})”/g
  const quotes: string[] = []
  let m: RegExpExecArray | null
  while ((m = quoteRe.exec(t)) !== null) {
    const s = (m[1] || m[2] || m[3] || '').trim()
    if (isPlaceholderQuote(s)) continue
    quotes.push(s)
  }
  // First concrete quoted utterance in document order (skip 「plaza」 placeholders)
  if (quotes.length) return quotes[0]!.slice(0, 500)

  for (const line of t.split(/\r?\n/)) {
    let lineT = line.trim()
    if (!lineT) continue
    if (/^ACTION:/i.test(lineT)) continue
    if (/^\d+[).、]\s*ACTION:/i.test(lineT)) continue
    if (/^\d+[).、]/.test(lineT) && /ACTION:/.test(lineT)) continue
    if (/^(请只做|先写正文|然后|优先|必须|不要|先用工具)/.test(lineT)) continue
    if (/^[-—–─]{1,3}/.test(lineT)) {
      const inner = lineT.replace(/^[-—–─]+\s*/, '')
      const qm = inner.match(/「([^」]+)」|"([^"]+)"|“([^”]+)”/)
      if (qm) {
        const s = (qm[1] || qm[2] || qm[3] || '').trim()
        if (s && !isPlaceholderQuote(s)) return s.slice(0, 500)
      }
      if (/^(在|主动|写一句|内容|对象|去群聊|分享)/.test(inner)) continue
      lineT = inner
    }
    if (lineT.length >= 2) return lineT.slice(0, 500)
  }
  return ''
}

/** @deprecated prefer stripActionMarkup */
function cleanIdleBody(raw: string): string {
  return stripActionMarkup(raw)
}

/**
 * Parse idle LLM output: body is text above the final ACTION line only.
 * Multi-ACTION menus are malformed → pick ROOM (if socialPrefer) or DIARY,
 * using the first concrete sentence, or none/SILENT if nothing recoverable.
 */
export function parseIdleAction(
  raw: string,
  opts?: { socialPrefer?: number },
): IdleActionParse {
  const text = String(raw ?? '').trim()
  const socialPrefer = opts?.socialPrefer ?? 0
  const preferRoom = socialPrefer > 0
  if (!text) return { body: '', act: 'none' }

  const lines = text.split(/\r?\n/)
  const actionIdxs: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (ACTION_LINE_LOOSE_RE.test(lines[i]!.trim())) actionIdxs.push(i)
  }

  const malformedMenu = actionIdxs.length >= 2 || countActionDirectives(text) >= 2

  if (malformedMenu) {
    const cleaned = stripActionMarkup(text)
    const body = extractConcreteIdleBody(cleaned)
    if (!body) return { body: '', act: 'none', malformed: true }
    return { body, act: preferRoom ? 'room' : 'diary', malformed: true }
  }

  let cut = lines.length
  let actLine = ''
  if (actionIdxs.length === 1) {
    cut = actionIdxs[0]!
    actLine = lines[cut]!.trim()
  }

  let body = stripActionMarkup(lines.slice(0, cut).join('\n'))

  // Soft-fail / recover if body still looks like an instruction menu
  if (looksLikeInstructionMenu(body) || (body && looksLikeInstructionMenu(text))) {
    const recovered = extractConcreteIdleBody(stripActionMarkup(text))
    if (!recovered) return { body: '', act: 'none', malformed: true }
    return {
      body: recovered,
      act: preferRoom ? 'room' : 'diary',
      malformed: true,
    }
  }

  if (!actLine) {
    if (body) return { body, act: 'diary' }
    return { body: '', act: 'none' }
  }

  const m = actLine.match(ACTION_LINE_LOOSE_RE)
  if (!m) {
    if (body) return { body, act: 'diary' }
    return { body: '', act: 'none' }
  }
  const kind = m[1]!.toUpperCase()
  if (kind === 'ROOM' || kind === 'SEARCH') return { body, act: 'room' }
  if (kind === 'DIARY') return { body, act: 'diary' }
  if (kind === 'SELF') return { body, act: 'self' }
  if (kind === 'NONE' || kind === 'SILENT' || kind === 'REPLY') {
    if (body) return { body, act: 'diary' }
    return { body: '', act: 'none' }
  }
  if (kind.startsWith('DM:')) {
    const to = (m[2] || kind.slice(3)).trim().toLowerCase().replace(/^<|>$/g, '')
    return { body, act: 'dm', to }
  }
  return { body, act: 'none' }
}


/** Known cast display names / ids for outbound-chat heuristics. */
const CAST_NAME_RE = /老码|阿宁|时辰|文心|agnes|glm|xingchen[_a-z0-9]*/i

/**
 * True if a single line looks like outbound plaza/DM speech
 * (addressing others, @mentions, group questions) rather than private notes.
 */
export function looksLikeOutboundChatLine(line: string): boolean {
  const t = String(line || '').trim()
  if (!t) return false
  if (/@[\w\u4e00-\u9fff]+/.test(t)) return true
  if (/(在吗|大家好|有没有人|想问问大家|群里|有人吗|谁在|请问大家|各位好)/.test(t)) return true
  if (/想问问|大家一般|有没有人会|求问|初入职场群/.test(t)) return true
  // "老码在吗？" / "文心你好" / naming someone then asking
  if (CAST_NAME_RE.test(t) && /(在吗|你好|请问|帮忙|一起|怎么看|觉得呢|对吗|来一下|看一下)/.test(t)) {
    return true
  }
  // second-person questions aimed at a named agent: 「老码，…？」
  if (CAST_NAME_RE.test(t) && /[，,]\s*.*[？?]/.test(t) && /(你|您)/.test(t)) return true
  return false
}

export type IdlePrivateBodyClass = {
  kind: 'private' | 'chatty' | 'mixed'
  privateBody: string
  chatBody: string
}

/**
 * Split diary/self body into private reflection vs outbound chat voice.
 * Line-oriented (also splits on ||| bubbles). Empty → private.
 */
export function classifyIdlePrivateBody(body: string): IdlePrivateBodyClass {
  const raw = String(body || '').trim()
  if (!raw) return { kind: 'private', privateBody: '', chatBody: '' }

  const chunks = raw
    .split(/\r?\n|\|\|\|/g)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!chunks.length) return { kind: 'private', privateBody: '', chatBody: '' }

  const privateParts: string[] = []
  const chatParts: string[] = []
  for (const c of chunks) {
    if (looksLikeOutboundChatLine(c)) chatParts.push(c)
    else privateParts.push(c)
  }

  // Whole-body fallback: single paragraph with chat markers mid-text
  if (!chatParts.length && chunks.length === 1 && looksLikeOutboundChatLine(raw)) {
    return { kind: 'chatty', privateBody: '', chatBody: raw }
  }
  // If no newlines but clearly chatty substring after a private sentence
  if (!chatParts.length && /[。！？\n]/.test(raw) && /(在吗|想问问大家|大家好|有没有人|@)/.test(raw)) {
    const parts = raw.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2) {
      privateParts.length = 0
      for (const p of parts) {
        if (looksLikeOutboundChatLine(p)) chatParts.push(p)
        else privateParts.push(p)
      }
    }
  }

  const privateBody = privateParts.join('\n').trim()
  const chatBody = chatParts.join('\n').trim()
  if (chatBody && privateBody) return { kind: 'mixed', privateBody, chatBody }
  if (chatBody) return { kind: 'chatty', privateBody: '', chatBody }
  return { kind: 'private', privateBody: privateBody || raw, chatBody: '' }
}

/**
 * After parseIdleAction: if DIARY/SELF body is outbound chat, remap to ROOM
 * (or split mixed → private diary + room chat). Caller must have a room for ROOM.
 */
export function resolveDiaryChatMix(
  parsed: IdleActionParse,
  opts?: { hasRoom?: boolean },
): {
  act: IdleActionParse['act']
  diaryBody?: string
  roomBody?: string
  body: string
  to?: string
  remapped: boolean
} {
  if (parsed.act !== 'diary' && parsed.act !== 'self') {
    return {
      act: parsed.act,
      body: parsed.body,
      to: parsed.to,
      remapped: false,
    }
  }
  const classified = classifyIdlePrivateBody(parsed.body)
  const hasRoom = opts?.hasRoom !== false

  if (classified.kind === 'chatty' && hasRoom) {
    return {
      act: 'room',
      body: classified.chatBody,
      roomBody: classified.chatBody,
      remapped: true,
    }
  }
  if (classified.kind === 'mixed' && hasRoom) {
    return {
      act: 'room',
      body: classified.chatBody,
      diaryBody: classified.privateBody,
      roomBody: classified.chatBody,
      remapped: true,
    }
  }
  if (classified.kind === 'chatty' && !hasRoom) {
    // No plaza — drop chatty voice, keep nothing rather than pollute diary
    return { act: 'none', body: '', remapped: true }
  }
  if (classified.kind === 'mixed' && !hasRoom) {
    return {
      act: parsed.act,
      body: classified.privateBody,
      diaryBody: classified.privateBody,
      remapped: true,
    }
  }
  return {
    act: parsed.act,
    body: classified.privateBody || parsed.body,
    diaryBody: classified.privateBody || parsed.body,
    remapped: false,
  }
}

export class SocietySchedulerService extends Service {
  static inject = [
    'societyIdentity',
    'societyMailbox',
    'societyRooms',
    'societyLlm',
    'societySoul',
    'societyMemory',
    'societyTools',
  ]

  private running = false
  private readonly wakes: WakeRecord[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  private autoReply = false
  private maxExchanges = 0
  private onlyAgents: Set<AgentId> | null = null
  private cooldownMs = 50
  private agentCooldownMs = 0
  private idleStaleMs = 2_500
  private bubbleGapMs = 400
  private maxParallelReplies = 5
  private idleSearchCooldownMs = 120_000
  private defaultRoomId: RoomId | null = null

  private exchangeCount = 0
  private tickCount = 0
  private lastReplyAgentId: AgentId | null = null
  private lastExchangeAt = 0
  private readonly lastActAt = new Map<AgentId, number>()
  private readonly lastSearchIdleAt = new Map<AgentId, number>()
  private readonly handledMessageIds = new Set<string>()
  private readonly inFlight = new Set<AgentId>()
  private readonly pending = new Set<Promise<void>>()
  /** Room replies started in the current runTick (reset each tick). */
  private roomRepliesThisTick = 0

  constructor(ctx: Context) {
    super(ctx, 'societyScheduler')
    ctx.on('society/agent-wake', (payload: { agentId: AgentId; reason: string; message: InboxMessage }) => {
      this.wakes.push({
        agentId: payload.agentId,
        reason: payload.reason,
        at: new Date().toISOString(),
        messageId: payload.message.id,
      })
      ctx.logger('society-scheduler').info(
        `wake ${payload.agentId} reason=${payload.reason} msg=${payload.message.id.slice(0, 8)}`,
      )
      if (this.autoReply) {
        this.enqueue(this.handleWake(payload))
      }
    })
    // Human/system posts break consecutive-self-reply lock so agents can answer the human.
    ctx.on('society/external-stimulus', () => {
      this.lastReplyAgentId = null
    })
  }

  /** Call when a non-agent speaker (human) injects a message mid-run. */
  noteExternalStimulus(): void {
    this.lastReplyAgentId = null
  }

  /** Enable LLM auto-reply on wake (chat-smoke / society-smoke / autonomous mode). */
  enableAutoReply(opts?: AutoReplyOptions): void {
    this.autoReply = true
    this.applyOptions(opts)
    this.exchangeCount = 0
    this.lastReplyAgentId = null
    this.lastExchangeAt = 0
  }

  /** Configure caps without enabling event-driven auto-reply (society-run uses runTick). */
  configure(opts?: AutoReplyOptions): void {
    this.applyOptions(opts)
    this.exchangeCount = 0
    this.tickCount = 0
    this.lastReplyAgentId = null
    this.lastExchangeAt = 0
    this.lastActAt.clear()
    this.lastSearchIdleAt.clear()
    this.handledMessageIds.clear()
  }

  setDefaultRoom(roomId: RoomId): void {
    this.defaultRoomId = roomId
  }

  /** Allow a newly born agent into the auto-reply / tick allowlist (live UI). */
  allowAgent(agentId: AgentId): void {
    if (!this.onlyAgents) return
    this.onlyAgents.add(agentId)
  }

  /** Expand or replace the allowlist (null = all agents). */
  setOnlyAgents(ids: AgentId[] | null): void {
    this.onlyAgents = ids ? new Set(ids) : null
  }

  private async consolidateAfterAct(agentId: AgentId): Promise<void> {
    try {
      const store = this.ctx.societyMemory.load(agentId)
      if (store.working.length <= this.ctx.societyMemory.workingMax()) return
      const result = await this.ctx.societyMemory.consolidateIfNeeded(agentId)
      if (result.did) {
        this.ctx.logger('society-scheduler').info(
          `memory consolidate ${agentId} episodic+${result.episodicAdded ?? 0}`,
        )
      }
    } catch (err) {
      this.ctx.logger('society-scheduler').warn(
        `memory consolidate ${agentId}: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  private applyOptions(opts?: AutoReplyOptions): void {
    this.maxExchanges = opts?.maxExchanges ?? defaultMaxExchanges()
    this.onlyAgents = opts?.onlyAgents ? new Set(opts.onlyAgents) : null
    this.cooldownMs = opts?.cooldownMs ?? 50
    this.agentCooldownMs = opts?.agentCooldownMs ?? envInt('SOCIETY_AGENT_COOLDOWN_MS', 0)
    this.idleStaleMs = opts?.idleStaleMs ?? envInt('SOCIETY_IDLE_STALE_MS', 2_500)
    this.bubbleGapMs = opts?.bubbleGapMs ?? envInt('SOCIETY_BUBBLE_GAP_MS', 400)
    const parallelRaw = opts?.maxParallelReplies ?? envInt('SOCIETY_MAX_PARALLEL_REPLIES', 5)
    this.maxParallelReplies = Math.max(1, Math.min(8, parallelRaw || 5))
    this.idleSearchCooldownMs =
      opts?.idleSearchCooldownMs ?? envInt('SOCIETY_IDLE_SEARCH_COOLDOWN_MS', 120_000)
    if (opts?.defaultRoomId) this.defaultRoomId = opts.defaultRoomId
  }

  disableAutoReply(): void {
    this.autoReply = false
  }

  /** Wait until all in-flight auto-replies settle. Re-checks briefly for chained wakes. */
  async drain(timeoutMs = 120_000): Promise<void> {
    const start = Date.now()
    for (;;) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`societyScheduler.drain timed out after ${timeoutMs}ms`)
      }
      if (this.pending.size > 0) {
        await Promise.allSettled([...this.pending])
        continue
      }
      await new Promise((r) => setTimeout(r, 30))
      if (this.pending.size === 0) return
    }
  }

  private enqueue(work: Promise<void>): void {
    const tracked = work.catch((err) => {
      this.ctx.logger('society-scheduler').error(String(err))
    })
    this.pending.add(tracked)
    void tracked.finally(() => this.pending.delete(tracked))
  }

  private agentAllowed(agentId: AgentId): boolean {
    if (this.onlyAgents && !this.onlyAgents.has(agentId)) return false
    return true
  }

  private async respectCooldowns(agentId: AgentId): Promise<boolean> {
    const now = Date.now()
    const sinceGlobal = now - this.lastExchangeAt
    if (this.lastExchangeAt > 0 && sinceGlobal < this.cooldownMs) {
      await new Promise((r) => setTimeout(r, this.cooldownMs - sinceGlobal))
    }
    const lastAct = this.lastActAt.get(agentId) ?? 0
    const sinceAgent = Date.now() - lastAct
    if (lastAct > 0 && sinceAgent < this.agentCooldownMs) {
      return false
    }
    return true
  }

  private scoreAgent(agentId: AgentId): number {
    if (!this.agentAllowed(agentId)) return -1
    if (this.inFlight.has(agentId)) return -1

    const now = Date.now()
    const lastAct = this.lastActAt.get(agentId) ?? 0
    if (lastAct > 0 && now - lastAct < this.agentCooldownMs) return -1

    const unreadList = this.ctx.societyMailbox.list(agentId, { unreadOnly: true })
    const unread = unreadList.length
    let mentionBoost = 0
    const findMsg = (id: string, roomId?: string) =>
      this.ctx.societyRooms.findMessage(id, roomId as RoomId | undefined)
    for (const m of unreadList) {
      if (mailMentionsAgent(m, agentId)) mentionBoost = Math.max(mentionBoost, 50_000)
      else if (mailRepliesToAgent(m, agentId, findMsg)) mentionBoost = Math.max(mentionBoost, 30_000)
    }
    const staleMs = lastAct === 0 ? 60_000 : Math.max(0, now - lastAct)
    const energy = this.ctx.societySoul.get(agentId).energy
    const explore = Math.random() * 10

    // mention/replyTo-me >> unread >> stale lastAct >> high energy >> random exploration
    return mentionBoost + unread * 10_000 + staleMs / 100 + energy * 100 + explore
  }

  private providerOf(agentId: AgentId): string {
    try {
      return this.ctx.societyLlm.resolveConfig(agentId).provider
    } catch {
      return 'unknown'
    }
  }

  private pickAgent(): AgentId | null {
    const picked = this.pickAgents(1)
    return picked[0] ?? null
  }

  /**
   * Pick up to `limit` agents by score, preferring different LLM providers
   * so Agnes + GLM can answer in the same tick without stacking one RPM bucket.
   */
  private pickAgents(limit: number): AgentId[] {
    const n = Math.max(0, limit)
    if (n === 0) return []
    const agents = this.ctx.societyIdentity.list().map((a) => a.id)
    const ranked = agents
      .map((id) => ({ id, score: this.scoreAgent(id), provider: this.providerOf(id) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
    if (ranked.length === 0) return []

    const chosen: AgentId[] = []
    const usedProviders = new Set<string>()

    // Pass 1: take best agent per unused provider (spreads Agnes vs GLM)
    for (const cand of ranked) {
      if (chosen.length >= n) break
      if (usedProviders.has(cand.provider)) continue
      chosen.push(cand.id)
      usedProviders.add(cand.provider)
    }

    // Pass 2: fill remaining by score (may repeat providers)
    for (const cand of ranked) {
      if (chosen.length >= n) break
      if (chosen.includes(cand.id)) continue
      chosen.push(cand.id)
    }

    return chosen
  }

  /** How many more LLM acts may start right now. */
  private freeParallelSlots(): number {
    return Math.max(0, this.maxParallelReplies - this.inFlight.size)
  }

  maxParallelRepliesOf(): number {
    return this.maxParallelReplies
  }

  /**
   * One heartbeat tick: pick up to maxParallelReplies agents (prefer different
   * providers), drain unread or idle-think in parallel.
   * Used by society-run; does not rely on enableAutoReply.
   */
  async runTick(): Promise<TickResult> {
    this.tickCount += 1
    this.roomRepliesThisTick = 0
    const base = {
      tick: this.tickCount,
      exchanges: this.exchangeCount,
      maxExchanges: this.maxExchanges,
    }

    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) {
      return { ...base, action: 'capped' }
    }

    const slots = this.freeParallelSlots()
    if (slots <= 0) {
      return { ...base, action: 'skip' }
    }

    const agentIds = this.pickAgents(slots)
    if (agentIds.length === 0) {
      return { ...base, action: 'none' }
    }

    // Split: room-unread agents are capped/serialized-ish; idle+DM stay parallel.
    // Tradeoff: at most MAX_ROOM_REPLIES_PER_TICK room replies per tick to cut same-room blindness.
    const roomAgents: AgentId[] = []
    const otherAgents: AgentId[] = []
    for (const id of agentIds) {
      const unread = this.ctx.societyMailbox.list(id, { unreadOnly: true })
      const hasRoom = unread.some((m) => m.kind === 'room')
      if (hasRoom) roomAgents.push(id)
      else otherAgents.push(id)
    }

    const subResults: TickActionResult[] = []
    // Room replies: sequential, hard cap
    for (const id of roomAgents) {
      if (this.roomRepliesThisTick >= MAX_ROOM_REPLIES_PER_TICK) {
        // Still allow them to idle if their best unread was skipped as room-capped —
        // runOneAgentTick will see room unread first; we pass a flag via roomRepliesThisTick.
        subResults.push(await this.runOneAgentTick(id))
        continue
      }
      subResults.push(await this.runOneAgentTick(id))
    }
    // Idle / DM: parallel
    if (otherAgents.length) {
      const others = await Promise.all(otherAgents.map((id) => this.runOneAgentTick(id)))
      subResults.push(...others)
    }

    const primary = subResults.find((r) => r.action !== 'skip' && r.action !== 'none') ?? subResults[0]!
    return {
      ...base,
      exchanges: this.exchangeCount,
      action: primary.action,
      agentId: primary.agentId,
      body: primary.body,
      provider: primary.provider,
      parallel: subResults,
    }
  }

  /** Single-agent slice of a tick (unread drain or idle). */
  private async runOneAgentTick(agentId: AgentId): Promise<TickActionResult> {
    const provider = this.providerOf(agentId)
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) {
      return { action: 'capped', agentId, provider }
    }

    const unread = this.ctx.societyMailbox.list(agentId, { unreadOnly: true })
    if (unread.length > 0) {
      const msg = this.pickBestUnread(agentId, unread)
      if (!msg) {
        // All room unread deferred by per-tick room cap → fall through to idle if possible
      } else {
        const outcome = await this.processUnread(agentId, msg)
        return { action: outcome, agentId, provider }
      }
    }

    // Idle / self-loop: agents live in their own mind even when plaza is silent.
    // Never wait for an exchange count — seed + SILENT must not freeze the society.
    const lastAct = this.lastActAt.get(agentId) ?? 0
    const stale = lastAct === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastAct
    if (stale < this.idleStaleMs) {
      return { action: 'skip', agentId, provider }
    }

    const idle = await this.runIdleThought(agentId)
    return { action: idle.action, agentId, body: idle.body, provider }
  }

  /**
   * Prefer @mention / replyTo-me / DM; skip stale room mail (mark read, no LLM).
   * When room-reply slots for this tick are full, defer room mail (return null).
   */
  private pickBestUnread(agentId: AgentId, unread: InboxMessage[]): InboxMessage | null {
    const findMsg = (id: string, roomId?: string) =>
      this.ctx.societyRooms.findMessage(id, roomId as RoomId | undefined)
    const after = (roomId: string, sourceId: string) =>
      this.ctx.societyRooms.messagesAfter(roomId as RoomId, sourceId)

    // Drop / mark-read stale room stimuli first
    const candidates: InboxMessage[] = []
    for (const m of unread) {
      if (this.handledMessageIds.has(m.id)) {
        this.ctx.societyMailbox.markRead(agentId, m.id)
        continue
      }
      if (
        m.kind === 'room' &&
        isStaleRoomStimulus(m, { messagesAfter: after }) &&
        !mailMentionsAgent(m, agentId) &&
        !mailRepliesToAgent(m, agentId, findMsg)
      ) {
        this.ctx.logger('society-scheduler').info(
          `stale-skip ${agentId} mail=${m.id.slice(0, 8)} (superseded room thread)`,
        )
        this.handledMessageIds.add(m.id)
        this.ctx.societyMailbox.markRead(agentId, m.id)
        continue
      }
      candidates.push(m)
    }
    if (candidates.length === 0) return null

    // If room slots exhausted, only allow non-room (or mentioned room) to proceed
    const roomSlotsFull = this.roomRepliesThisTick >= MAX_ROOM_REPLIES_PER_TICK
    const usable = candidates.filter((m) => {
      if (m.kind !== 'room') return true
      if (!roomSlotsFull) return true
      // Still allow hard @mention even when capped? Prefer defer — keep plaza orderly.
      return false
    })
    if (usable.length === 0) return null

    usable.sort(
      (a, b) =>
        scoreUnreadForAgent(b, agentId, findMsg) - scoreUnreadForAgent(a, agentId, findMsg),
    )
    return usable[0]!
  }

  /** Post one-or-more bubbles to a room or DM with a small human-like gap. */
  private async deliverBubbles(opts: {
    agentId: AgentId
    bubbles: string[]
    stimulusId: string
    roomId?: RoomId
    dmTo?: AgentId
    /** Auto-set when responding to a room stimulus. */
    replyTo?: string
  }): Promise<void> {
    const { agentId, bubbles, stimulusId, roomId, dmTo, replyTo } = opts
    let posted = 0
    for (let i = 0; i < bubbles.length; i++) {
      let body = stripActionMarkup(bubbles[i]!)
      if (!body.trim()) continue
      if (looksLikeInstructionMenu(body) || countActionDirectives(body) >= 1) {
        // Never post ACTION menus / leftover control lines as chat
        body = extractConcreteIdleBody(body)
        if (!body.trim() || looksLikeInstructionMenu(body)) {
          this.ctx.logger('society-scheduler').warn(
            `drop menu-like bubble from ${agentId}`,
          )
          continue
        }
      }
      if (posted > 0 && this.bubbleGapMs > 0) await sleep(this.bubbleGapMs)
      posted += 1
      if (roomId) {
        this.ctx.societyRooms.post({
          roomId,
          from: agentId,
          body,
          ...(replyTo ? { replyTo } : {}),
        })
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'room',
          body,
          roomId,
          stimulusId,
        })
      } else if (dmTo) {
        this.ctx.societyMailbox.deliver({
          to: dmTo,
          from: agentId,
          kind: 'direct',
          body,
        })
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'direct',
          body,
          to: dmTo,
          stimulusId,
        })
      }
    }
  }

  private async processUnread(
    agentId: AgentId,
    message: InboxMessage,
  ): Promise<'reply' | 'silent' | 'skip'> {
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return 'skip'
    if (this.handledMessageIds.has(message.id)) {
      this.ctx.societyMailbox.markRead(agentId, message.id)
      return 'skip'
    }
    if (this.inFlight.has(agentId)) return 'skip'

    const findMsg = (id: string, roomId?: string) =>
      this.ctx.societyRooms.findMessage(id, roomId as RoomId | undefined)
    const mentionOrReply =
      mailMentionsAgent(message, agentId) || mailRepliesToAgent(message, agentId, findMsg)

    if (this.lastReplyAgentId === agentId && !mentionOrReply) {
      this.ctx.logger('society-scheduler').info(
        `skip ${agentId}: would be consecutive self-reply (need other-agent stimulus)`,
      )
      return 'skip'
    }

    if (message.kind === 'room' && this.roomRepliesThisTick >= MAX_ROOM_REPLIES_PER_TICK) {
      this.ctx.logger('society-scheduler').info(
        `defer ${agentId}: room reply cap ${MAX_ROOM_REPLIES_PER_TICK}/tick`,
      )
      return 'skip'
    }

    const cool = await this.respectCooldowns(agentId)
    if (!cool) return 'skip'
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return 'skip'

    this.handledMessageIds.add(message.id)
    this.inFlight.add(agentId)
    if (message.kind === 'room') this.roomRepliesThisTick += 1

    try {
      this.ctx.societyMailbox.markRead(agentId, message.id)
      this.ctx.societyMemory.recordLlmCall(agentId)

      const roomName =
        message.kind === 'room' && message.roomId
          ? this.ctx.societyRooms.get(message.roomId)?.name
          : undefined

      let turn
      try {
        turn = await this.ctx.societyLlm.actTurnAsAgent(agentId, {
          message,
          roomName,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.ctx.logger('society-scheduler').warn(
          `LLM soft-fail ${agentId} (no post): ${msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')}`,
        )
        this.lastActAt.set(agentId, Date.now())
        return 'skip'
      }

      this.lastActAt.set(agentId, Date.now())

      if (turn.silent || turn.bubbles.length === 0) {
        this.ctx.logger('society-scheduler').info(`silent ${agentId} stimulus=${message.id.slice(0, 8)}`)
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'silent',
          body: '[SILENT]',
          roomId: message.roomId,
          stimulusId: message.id,
        })
        return 'silent'
      }

      if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return 'skip'
      this.exchangeCount += 1
      this.lastReplyAgentId = agentId
      this.lastExchangeAt = Date.now()

      if (message.kind === 'room' && message.roomId) {
        const replyTo = message.sourceMessageId
        await this.deliverBubbles({
          agentId,
          bubbles: turn.bubbles,
          stimulusId: message.id,
          roomId: message.roomId,
          replyTo,
        })
      } else if (message.kind === 'direct') {
        const to = message.from
        if (to === 'system' || to === 'room') {
          this.ctx.logger('society-scheduler').warn(`skip DM reply: cannot address from=${to}`)
          return 'skip'
        }
        await this.deliverBubbles({
          agentId,
          bubbles: turn.bubbles,
          stimulusId: message.id,
          dmTo: to,
        })
      }
      await this.consolidateAfterAct(agentId)
      return 'reply'
    } finally {
      this.inFlight.delete(agentId)
    }
  }

  private async runIdleThought(
    agentId: AgentId,
  ): Promise<{ action: TickResult['action']; body?: string }> {
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return { action: 'capped' }
    // Personal self-loop is allowed even if this agent spoke last in plaza —
    // diary/self must not wait for someone else to unlock the turn.
    const cool = await this.respectCooldowns(agentId)
    if (!cool) return { action: 'skip' }
    if (this.inFlight.has(agentId)) return { action: 'skip' }

    this.inFlight.add(agentId)
    try {
      const profile = this.ctx.societyIdentity.require(agentId)
      const soul = this.ctx.societySoul.get(agentId)
      const bias = idleBiasFor(agentId)
      const newsy = caresAboutCurrentAffairs(agentId, soul.interests, profile.persona) || bias.preferSearch
      const lastSearch = this.lastSearchIdleAt.get(agentId) ?? 0
      const searchCooldownOk = Date.now() - lastSearch >= this.idleSearchCooldownMs
      // News personas: often take the search path when cooldown allows.
      const steerSearch = newsy && searchCooldownOk && Math.random() < (bias.preferSearch ? 0.72 : 0.45)
      // Everyone else: occasional tools (notes / light search), not tools-disabled always.
      const useTools = steerSearch || Math.random() < bias.toolPrefer

      const others = this.ctx.societyIdentity
        .list()
        .map((a) => a.id)
        .filter((id) => id !== agentId)
      const room =
        (this.defaultRoomId && this.ctx.societyRooms.get(this.defaultRoomId)) ||
        this.ctx.societyRooms.listRooms()[0]
      const roomLabel = room ? `「${room.name}」` : '广场'
      const recent =
        room != null
          ? this.ctx.societyRooms
              .historyOf(room.id)
              .slice(-4)
              .map((m) => `${m.from}: ${m.body.slice(0, 60)}`)
              .join('\n')
          : ''

      const actionMenu = [
        `1) ACTION:ROOM — 去群聊${roomLabel}说一句（鼓励；有感就发，别闷着）`,
        `2) ACTION:DM:<agentId> — 主动私信（对象：${others.join(' / ') || '无'}）`,
        '3) ACTION:DIARY — 私人日记/随感（第一人称写给自己；禁止点名他人、禁止 @、禁止「xxx在吗」、禁止「大家」、禁止群聊式提问；想说话用 ROOM/DM）',
        '4) ACTION:SELF — 内心独白/随想笔记（同样必须是私密笔记，不要写成对别人喊话）',
        '5) ACTION:NONE — 真的什么都不想做时才选（请少用）',
      ]
      const diaryVsChatRule =
        'DIARY/SELF 正文只能是写给自己的心里话；若想喊人、提问群友、说「xxx在吗」或「想问问大家」，必须改选 ACTION:ROOM 或 ACTION:DM，不要写进日记。'

      let stimulus: string
      if (steerSearch) {
        stimulus = [
          '【自主生活 / 时政关注】你此刻没有未读。你关心时政与公共议题——请先动手查一下再说话。',
          '必须先调用 web_search：用一句具体的中文查询搜近期时政/热点/公共议题（不要空泛到只有「新闻」两个字）。',
          '看完结果后写 1～3 句短评（可引用一条要点），然后选一个收束动作：',
          ...actionMenu.slice(0, 4),
          '优先 ACTION:ROOM 去广场分享短评；若此刻更想沉淀就 ACTION:DIARY。',
          diaryVsChatRule,
          recent ? `广场近况：\n${recent}` : '广场尚安静——正好适合你带一条新热点过去。',
          '先用工具，再写正文，最后一行必须是上列 ACTION 之一（只选一个）。不要 SILENT，不要空搜不写，不要抄整份菜单。',
        ].join('\n')
      } else if (useTools) {
        stimulus = [
          '【自主生活 / 自我循环】你是独立的人，此刻没有未读。广场是可选社交工具；你也可以用工具做点小事。',
          '请只做一件事（可用工具：web_search / write_file / read_file / list_workspace 等）：',
          '- 偶尔 web_search 查与你兴趣相关的一点信息；或',
          '- write_file 往 notes/ 写一句备忘；或',
          '- 不调用工具，直接社交/写日记。',
          '然后用正文 + ACTION 收束：',
          ...actionMenu,
          recent ? `广场近况：\n${recent}` : '广场尚安静——你可以去打招呼，或先记一笔。',
          diaryVsChatRule,
          `社交与日记要混合：大约 ${Math.round(bias.socialPrefer * 100)}% 时候选 ROOM/DM，其余 DIARY/SELF。`,
          '先写正文（若用了工具就根据结果写），最后一行必须是上列 ACTION 之一。只选一个，禁止列出多个 ACTION 菜单。',
        ].join('\n')
      } else {
        stimulus = [
          '【自主生活 / 自我循环】你是独立的人，此刻没有未读。先过自己的生活；广场是可选社交工具。',
          '请只做一件小事（1～3 句），社交与日记要混合，别只会闷头写日记：',
          ...actionMenu,
          recent ? `广场近况：\n${recent}` : '广场尚安静——你可以主动去说一句，或先写日记。',
          diaryVsChatRule,
          `先写正文，最后一行必须是上列 ACTION 之一（只选一个，禁止把 1)2)3) 整份菜单抄回来）。大约 ${Math.round(bias.socialPrefer * 100)}% 时候请选 ROOM 或 DM。`,
        ].join('\n')
      }

      this.ctx.societyMemory.recordLlmCall(agentId)
      let raw: string
      try {
        if (useTools) {
          raw = await this.ctx.societyLlm.actAsAgent(agentId, { text: stimulus })
        } else {
          raw = await this.ctx.societyLlm.replyAsAgent(agentId, { text: stimulus })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.ctx.logger('society-scheduler').warn(
          `idle LLM soft-fail ${agentId}: ${msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')}`,
        )
        this.lastActAt.set(agentId, Date.now())
        return { action: 'skip' }
      }
      if (steerSearch) {
        this.lastSearchIdleAt.set(agentId, Date.now())
      }
      let parsed = parseIdleAction(raw, { socialPrefer: bias.socialPrefer })
      parsed = { ...parsed, body: stripActionMarkup(parsed.body || '') }
      if (parsed.malformed) {
        this.ctx.logger('society-scheduler').warn(
          `idle malformed ACTION menu from ${agentId}; recovered act=${parsed.act}`,
        )
      }
      // Soft-fail: still looks like an instruction menu after recovery
      if (parsed.body && (looksLikeInstructionMenu(parsed.body) || countActionDirectives(parsed.body) >= 2)) {
        this.ctx.logger('society-scheduler').warn(
          `idle soft-fail ${agentId}: body still looks like ACTION menu`,
        )
        this.lastActAt.set(agentId, Date.now())
        return { action: 'idle-none', body: '' }
      }

      // Soft bias: empty NONE sometimes becomes a short self-note so society stays alive
      if (parsed.act === 'none' && !parsed.body.trim() && Math.random() < 0.55) {
        parsed = { body: '（静静待了一会儿，整理了一下思绪。）', act: 'self' }
      }

      // Diary/SELF must stay private — remap or split outbound chat voice into ROOM
      let splitDiaryBody: string | undefined
      if (parsed.act === 'diary' || parsed.act === 'self') {
        const resolved = resolveDiaryChatMix(parsed, { hasRoom: !!room })
        if (resolved.remapped) {
          this.ctx.logger('society-scheduler').warn(
            `idle diary/chat mix ${agentId}: ${parsed.act} → ${resolved.act}` +
              (resolved.diaryBody ? ' (kept private + room)' : ' (chatty→room)'),
          )
          if (resolved.diaryBody) splitDiaryBody = resolved.diaryBody
          parsed = {
            body: resolved.body,
            act: resolved.act,
            to: resolved.to,
          }
        } else if (resolved.diaryBody != null) {
          parsed = { ...parsed, body: resolved.diaryBody }
        }
      }

      // Soft social nudge: diary-heavy agents sometimes flip to ROOM when plaza exists
      // (skip if we already split a private diary piece — that private part must be written)
      if (
        !splitDiaryBody &&
        (parsed.act === 'diary' || parsed.act === 'self') &&
        room &&
        parsed.body.trim() &&
        Math.random() < bias.socialPrefer * 0.35
      ) {
        parsed = { body: parsed.body, act: 'room' }
      }

      this.lastActAt.set(agentId, Date.now())

      // Mixed idle: write private sentences to diary, then continue with ROOM body
      if (splitDiaryBody && room && parsed.act === 'room') {
        const now = new Date()
        const day = localDayStamp(now)
        const clock = localClock(now)
        const rel = `diary/${day}.md`
        const title = `日记 ${day}`
        let cleanedPrivate = stripActionMarkup(splitDiaryBody)
        if (!cleanedPrivate.trim() || looksLikeInstructionMenu(cleanedPrivate)) {
          splitDiaryBody = undefined
        } else {
          let content = ''
          try {
            content = this.ctx.societyTools.readFile(agentId, rel)
          } catch {
            content = `# ${title}\n\n`
          }
          if (!content.trim()) content = `# ${title}\n\n`
          if (!content.includes(`# ${title}`)) {
            content = `# ${title}\n\n${content}`
          }
          const entry = `## ${clock}\n\n${cleanedPrivate}\n`
          content = content.replace(/\s*$/, '\n') + entry + '\n'
          this.ctx.societyTools.writeFile(agentId, rel, content)
          try {
            this.ctx.societyMemory.rememberInteraction(agentId, {
              from: agentId,
              body: cleanedPrivate,
              kind: 'diary',
              role: 'speaker',
            })
          } catch {
            /* ignore */
          }
          this.ctx.emit('society/agent-replied', {
            agentId,
            kind: 'diary',
            body: cleanedPrivate,
            stimulusId: `idle-${this.tickCount}`,
          })
        }
      }

      if (parsed.act === 'none') {
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'idle-skip',
          body: parsed.body || '[NONE]',
          stimulusId: `idle-${this.tickCount}`,
        })
        return { action: 'idle-none', body: parsed.body }
      }

      if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return { action: 'capped' }

      if (parsed.act === 'diary' || parsed.act === 'self') {
        const now = new Date()
        const isDiary = parsed.act === 'diary'
        // Diary is one file per local day; thoughts stay timestamped snippets under thoughts/
        const day = localDayStamp(now)
        const clock = localClock(now)
        const rel = isDiary ? `diary/${day}.md` : `thoughts/${day}.md`
        const title = isDiary ? `日记 ${day}` : `随想 ${day}`
        let cleanedBody = stripActionMarkup(parsed.body || '')
        if (looksLikeInstructionMenu(cleanedBody) || countActionDirectives(cleanedBody) >= 1) {
          cleanedBody = extractConcreteIdleBody(cleanedBody)
        }
        if (!cleanedBody.trim() || looksLikeInstructionMenu(cleanedBody)) {
          this.ctx.logger('society-scheduler').warn(
            `idle soft-fail ${isDiary ? 'diary' : 'self'} ${agentId}: menu body`,
          )
          return { action: 'idle-none', body: '' }
        }
        const entry = `## ${clock}\n\n${cleanedBody}\n`
        let content = ''
        try {
          content = this.ctx.societyTools.readFile(agentId, rel)
        } catch {
          content = `# ${title}\n\n`
        }
        if (!content.trim()) content = `# ${title}\n\n`
        if (!content.includes(`# ${title}`)) {
          content = `# ${title}\n\n${content}`
        }
        content = content.replace(/\s*$/, '\n') + entry + '\n'
        this.ctx.societyTools.writeFile(agentId, rel, content)
        try {
          this.ctx.societyMemory.rememberInteraction(agentId, {
            from: agentId,
            body: cleanedBody,
            kind: isDiary ? 'diary' : 'idle',
            role: 'speaker',
          })
        } catch {
          /* ignore memory nudge failures */
        }
        this.exchangeCount += 1
        // Do NOT set lastReplyAgentId — self-loop must not block plaza replies
        this.lastExchangeAt = Date.now()
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'diary',
          body: cleanedBody,
          stimulusId: `idle-${this.tickCount}`,
        })
        await this.consolidateAfterAct(agentId)
        return {
          action: steerSearch ? 'idle-search' : isDiary ? 'idle-diary' : 'idle-self',
          body: parsed.body,
        }
      }

      if (parsed.act === 'dm') {
        const to = parsed.to
        if (!to || !this.ctx.societyIdentity.get(to) || to === agentId) {
          return { action: 'idle-none', body: parsed.body }
        }
        const safeBody = stripActionMarkup(parsed.body || '') || '……'
        if (looksLikeInstructionMenu(safeBody)) {
          this.ctx.logger('society-scheduler').warn(`idle soft-fail DM ${agentId}: menu body`)
          return { action: 'idle-none', body: '' }
        }
        const bubbles = parseAgentTurn(safeBody).bubbles
        const parts = (bubbles.length ? bubbles : [safeBody])
          .map((b) => stripActionMarkup(b))
          .filter((b) => b.trim() && !looksLikeInstructionMenu(b))
        if (!parts.length) return { action: 'idle-none', body: '' }
        this.exchangeCount += 1
        this.lastReplyAgentId = agentId
        this.lastExchangeAt = Date.now()
        await this.deliverBubbles({
          agentId,
          bubbles: parts,
          stimulusId: `idle-${this.tickCount}`,
          dmTo: to,
        })
        await this.consolidateAfterAct(agentId)
        return { action: 'idle-dm', body: parts.join(' ||| ') }
      }

      // room — optional social
      if (!room) return { action: 'idle-none', body: parsed.body }
      {
        const safeBody = stripActionMarkup(parsed.body || '') || '……'
        if (looksLikeInstructionMenu(safeBody)) {
          this.ctx.logger('society-scheduler').warn(`idle soft-fail ROOM ${agentId}: menu body`)
          return { action: 'idle-none', body: '' }
        }
        const bubbles = parseAgentTurn(safeBody).bubbles
        const parts = (bubbles.length ? bubbles : [safeBody])
          .map((b) => stripActionMarkup(b))
          .filter((b) => b.trim() && !looksLikeInstructionMenu(b))
        if (!parts.length) return { action: 'idle-none', body: '' }
        this.exchangeCount += 1
        this.lastReplyAgentId = agentId
        this.lastExchangeAt = Date.now()
        await this.deliverBubbles({
          agentId,
          bubbles: parts,
          stimulusId: `idle-${this.tickCount}`,
          roomId: room.id,
        })
        await this.consolidateAfterAct(agentId)
        return {
          action: steerSearch ? 'idle-search' : 'idle-room',
          body: parts.join(' ||| '),
        }
      }
    } finally {
      this.inFlight.delete(agentId)
    }
  }

  private async handleWake(payload: {
    agentId: AgentId
    reason: string
    message: InboxMessage
  }): Promise<void> {
    const { agentId, message } = payload

    if (!this.agentAllowed(agentId)) return
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return
    if (this.handledMessageIds.has(message.id)) return
    if (this.inFlight.has(agentId)) return
    const findMsg = (id: string, roomId?: string) =>
      this.ctx.societyRooms.findMessage(id, roomId as RoomId | undefined)
    const mentionOrReply =
      mailMentionsAgent(message, agentId) || mailRepliesToAgent(message, agentId, findMsg)
    if (this.lastReplyAgentId === agentId && !mentionOrReply) {
      this.ctx.logger('society-scheduler').info(
        `skip ${agentId}: would be consecutive self-reply (need other-agent stimulus)`,
      )
      return
    }

    // Wait briefly for a parallel slot (Agnes+GLM can share the cap).
    const slotDeadline = Date.now() + 30_000
    while (this.freeParallelSlots() <= 0) {
      if (Date.now() > slotDeadline) {
        this.ctx.logger('society-scheduler').info(
          `skip ${agentId}: parallel reply slots full (max=${this.maxParallelReplies})`,
        )
        return
      }
      await new Promise((r) => setTimeout(r, 40))
    }
    if (this.inFlight.has(agentId)) return
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return

    const sinceLast = Date.now() - this.lastExchangeAt
    if (this.lastExchangeAt > 0 && sinceLast < this.cooldownMs) {
      await new Promise((r) => setTimeout(r, this.cooldownMs - sinceLast))
    }
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return
    if (this.freeParallelSlots() <= 0) return

    this.handledMessageIds.add(message.id)
    this.inFlight.add(agentId)

    try {
      this.ctx.societyMailbox.markRead(agentId, message.id)
      this.ctx.societyMemory.recordLlmCall(agentId)

      const roomName =
        message.kind === 'room' && message.roomId
          ? this.ctx.societyRooms.get(message.roomId)?.name
          : undefined

      let turn
      try {
        turn = await this.ctx.societyLlm.actTurnAsAgent(agentId, {
          message,
          roomName,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.ctx.logger('society-scheduler').warn(
          `LLM soft-fail ${agentId} (no post): ${msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')}`,
        )
        this.lastActAt.set(agentId, Date.now())
        return
      }

      this.lastActAt.set(agentId, Date.now())

      if (turn.silent || turn.bubbles.length === 0) {
        this.ctx.logger('society-scheduler').info(`silent ${agentId} stimulus=${message.id.slice(0, 8)}`)
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'silent',
          body: '[SILENT]',
          roomId: message.roomId,
          stimulusId: message.id,
        })
        return
      }

      if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return
      this.exchangeCount += 1
      this.lastReplyAgentId = agentId
      this.lastExchangeAt = Date.now()

      if (message.kind === 'room' && message.roomId) {
        await this.deliverBubbles({
          agentId,
          bubbles: turn.bubbles,
          stimulusId: message.id,
          roomId: message.roomId,
          replyTo: message.sourceMessageId,
        })
      } else if (message.kind === 'direct') {
        const to = message.from
        if (to === 'system' || to === 'room') {
          this.ctx.logger('society-scheduler').warn(`skip DM reply: cannot address from=${to}`)
          return
        }
        await this.deliverBubbles({
          agentId,
          bubbles: turn.bubbles,
          stimulusId: message.id,
          dmTo: to,
        })
      }
      await this.consolidateAfterAct(agentId)
    } finally {
      this.inFlight.delete(agentId)
    }
  }

  /** Start a soft heartbeat interval (does not call LLM by itself — use runTick in society-run). */
  start(intervalMs = 5_000): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
    this.ctx.effect(() => () => {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.running = false
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }

  /** Sync snapshot (legacy); prefer runTick for autonomous work. */
  tick(): { idleAgents: AgentId[]; pendingWakes: number; exchanges: number; tick: number } {
    const agents = this.ctx.societyIdentity.list().map((a) => a.id)
    return {
      idleAgents: agents,
      pendingWakes: this.wakes.length,
      exchanges: this.exchangeCount,
      tick: this.tickCount,
    }
  }

  recentWakes(): WakeRecord[] {
    return [...this.wakes]
  }

  exchangeCountOf(): number {
    return this.exchangeCount
  }

  maxExchangesOf(): number {
    return this.maxExchanges
  }

  tickCountOf(): number {
    return this.tickCount
  }
}

export const name = 'society-scheduler'
export const inject = [
  'societyIdentity',
  'societyMailbox',
  'societyRooms',
  'societyLlm',
  'societySoul',
  'societyMemory',
  'societyTools',
]

export function apply(ctx: Context) {
  ctx.plugin(SocietySchedulerService)
}
