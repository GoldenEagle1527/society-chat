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
 * - replies/idle use structured closing tools (speak_in_room / stay_silent / write_diary / rest / …)
 * - rest snooze: skip idle while resting; room unread only if @mention or from human; agent↔agent DM skipped; human DM/@ wakes
 * - no ACTION: text protocol; tools apply side effects; scheduler must not double-post
 * - multi-bubble via ||| inside tool body args
 * - idle: always actClosedTurn; news personas often web_search then speak_in_room
 * - write_diary rejects outbound chat voice server-side
 * - per-agent tick budget (SOCIETY_AGENT_TICK_BUDGET_MS) so hung LLM cannot freeze runTick
 * - quiet plaza idle bias strongly prefers speak_in_room over diary
 * - LLM sync path: 1 attempt (SOCIETY_LLM_SYNC_ATTEMPTS); failures enqueue async retry queue
 *   (SOCIETY_LLM_MAX_ATTEMPTS with backoff) — does not block tickRunning / next runTick
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, InboxMessage, RoomId } from '../../../src/types.ts'
import { HUMAN_SPEAKER_ID } from '../../../src/types.ts'
import type { ActMode, AgentActResult, ReplyStimulus } from '../../society-llm/src/index.ts'
import { formatBeijingNow } from '../../../src/beijing-time.ts'
import {
  agentTickBudgetMs,
  sleep as sleepMs,
  worldLlmTimeoutMs,
  worldTurnTimeoutMs,
} from '../../../src/llm-http.ts'
import {
  recordLlm,
  recordSchedulerTick,
  recordSkip,
  recordWake,
  setLedgerWorldTick,
} from '../../../src/call-ledger.ts'
import {
  clearRest,
  getRestUntil,
  isAgentResting,
} from '../../society-tools/src/rest.ts'

// Re-export voice helpers for offline smokes
export { looksLikeOutboundChatLine, classifyIdlePrivateBody } from '../../society-tools/src/index.ts'

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

/** Failed sync turn handed to the background LLM retry queue (off the main heartbeat). */
interface AsyncRetryJob {
  agentId: AgentId
  kind: 'idle' | 'reply'
  stimulusKey: string
  stimulus: ReplyStimulus
  mode: ActMode
  opts?: { injectReplyTo?: string; defaultDmTo?: string }
  roomId?: string
  steerSearch?: boolean
  enqueuedAt: number
  syncError: string
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


/** True when message is from the human operator. */
export function mailFromHuman(message: InboxMessage): boolean {
  return message.from === HUMAN_SPEAKER_ID
}

/**
 * While resting: only human posts or @mentions (or reply-to-me) may wake the agent.
 * Agent↔agent DMs and unmentioned room chatter are skipped.
 */
export function restWakeStimulus(
  message: InboxMessage,
  agentId: AgentId,
  findMessage: (id: string, roomId?: string) => { from: string } | undefined,
): boolean {
  if (mailFromHuman(message)) return true
  if (mailMentionsAgent(message, agentId)) return true
  if (mailRepliesToAgent(message, agentId, findMessage)) return true
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
      return { preferSearch: true, socialPrefer: 0.78, toolPrefer: 0.85 }
    case 'xingchen_lit':
      return { preferSearch: false, socialPrefer: 0.62, toolPrefer: 0.22 }
    case 'agnes':
      return { preferSearch: false, socialPrefer: 0.72, toolPrefer: 0.28 }
    case 'glm':
      return { preferSearch: false, socialPrefer: 0.6, toolPrefer: 0.3 }
    default:
      return { preferSearch: false, socialPrefer: 0.65, toolPrefer: 0.25 }
  }
}

function schedWarn(ctx: Context, msg: string): void {
  ctx.logger('society-scheduler').warn(msg)
  console.warn(`[society-scheduler] ${msg}`)
}

/** @deprecated ACTION text protocol removed — kept as no-op stubs for any stray imports. */
export function stripActionMarkup(raw: string): string {
  return String(raw || '').trim()
}

export function countActionDirectives(_text: string): number {
  return 0
}

export function looksLikeInstructionMenu(_text: string): boolean {
  return false
}

export function extractConcreteIdleBody(text: string): string {
  return String(text || '').trim()
}

export interface IdleActionParse {
  body: string
  act: 'room' | 'dm' | 'diary' | 'self' | 'none'
  to?: string
  malformed?: boolean
}

/** @deprecated Use closing tools instead of ACTION lines. */
export function parseIdleAction(raw: string, _opts?: { socialPrefer?: number }): IdleActionParse {
  const body = String(raw ?? '').trim()
  if (!body) return { body: '', act: 'none' }
  return { body, act: 'none', malformed: true }
}

export type IdlePrivateBodyClass = {
  kind: 'private' | 'chatty' | 'mixed'
  privateBody: string
  chatBody: string
}

/** @deprecated Diary chat-mix handled inside write_diary tool. */
export function resolveDiaryChatMix(
  parsed: IdleActionParse,
  _opts?: { hasRoom?: boolean },
): {
  act: IdleActionParse['act']
  diaryBody?: string
  roomBody?: string
  body: string
  to?: string
  remapped: boolean
} {
  return {
    act: parsed.act,
    body: parsed.body,
    to: parsed.to,
    remapped: false,
  }
}

export class SocietySchedulerService extends Service {
  static inject = [
    'societyIdentity',
    'societyMailbox',
    'societyRooms',
    'societyLlm',
    'societyMemory',
    'societyTools',
    'societyWorld',
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

  /** Background LLM retries — must not block tickRunning / runTick. */
  private readonly asyncRetryQueue: AsyncRetryJob[] = []
  private asyncRetryPumping = false
  /** stimulusKey currently queued or running (dedupe). */
  private readonly asyncRetryKeys = new Set<string>()

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

    // Expire rest if due; while resting only wake-worthy unread scores
    getRestUntil(agentId, now)
    const resting = isAgentResting(agentId, now)

    const unreadList = this.ctx.societyMailbox.list(agentId, { unreadOnly: true })
    const findMsg = (id: string, roomId?: string) =>
      this.ctx.societyRooms.findMessage(id, roomId as RoomId | undefined)
    const wakeUnread = resting
      ? unreadList.filter((m) => restWakeStimulus(m, agentId, findMsg))
      : unreadList
    if (resting && wakeUnread.length === 0) return -1

    const unread = wakeUnread.length
    let mentionBoost = 0
    for (const m of wakeUnread) {
      if (mailFromHuman(m)) mentionBoost = Math.max(mentionBoost, 80_000)
      if (mailMentionsAgent(m, agentId)) mentionBoost = Math.max(mentionBoost, 50_000)
      else if (mailRepliesToAgent(m, agentId, findMsg)) mentionBoost = Math.max(mentionBoost, 30_000)
    }
    const staleMs = lastAct === 0 ? 60_000 : Math.max(0, now - lastAct)
    // World-side urgency (energy_pool / core_integrity / starve) — NOT soul.energy
    let worldScore = 50
    try {
      if (!this.ctx.societyWorld.isAlive(agentId)) return -1
      worldScore = this.ctx.societyWorld.wakeScore(agentId)
    } catch {
      /* world not ready */
    }
    const explore = Math.random() * 10

    // mention/replyTo-me >> unread >> world survival urgency >> stale >> explore
    return mentionBoost + unread * 10_000 + worldScore * 120 + staleMs / 100 + explore
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
      try {
        recordSchedulerTick('capped')
        const w = this.ctx.societyWorld?.getState?.()
        if (w && typeof w.tick === 'number') setLedgerWorldTick(w.tick)
      } catch { /* */ }
      return { ...base, action: 'capped' }
    }

    const slots = this.freeParallelSlots()
    if (slots <= 0) {
      try {
        recordSchedulerTick('skip')
        const w = this.ctx.societyWorld?.getState?.()
        if (w && typeof w.tick === 'number') setLedgerWorldTick(w.tick)
      } catch { /* */ }
      return { ...base, action: 'skip' }
    }

    const agentIds = this.pickAgents(slots)
    if (agentIds.length === 0) {
      try {
        recordSchedulerTick('none')
        const w = this.ctx.societyWorld?.getState?.()
        if (w && typeof w.tick === 'number') setLedgerWorldTick(w.tick)
      } catch { /* */ }
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
    try {
      recordSchedulerTick(primary.action)
      const w = this.ctx.societyWorld?.getState?.()
      if (w && typeof w.tick === 'number') setLedgerWorldTick(w.tick)
    } catch { /* ledger optional */ }
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

  /**
   * Synced turn-based world tick:
   * 1) beginSyncedTurn (act ops do not stepPhysics)
   * 2) ask ALL living agents in parallel (timeout → wait fill)
   * 3) endSyncedTurn → one shared physics/metabolism step
   * No free-running metabolism while models think.
   */
  async runSyncedWorldTurn(opts?: {
    timeoutMs?: number
  }): Promise<{
    tick: number
    worldTick: number
    results: Array<{
      agentId: AgentId
      status: 'ok' | 'timeout' | 'error' | 'rest' | 'dead' | 'wait_fill'
      action?: string
    }>
  }> {
    const timeoutMs = Math.max(5_000, opts?.timeoutMs ?? worldTurnTimeoutMs())
    this.tickCount += 1
    this.roomRepliesThisTick = 0

    const state = this.ctx.societyWorld.getState()
    const living = (state?.bots || [])
      .filter((b) => b.alive && b.actorId !== 'human')
      .map((b) => b.actorId as AgentId)

    this.ctx.societyWorld.beginSyncedTurn()

    const results = await Promise.all(
      living.map(async (agentId) => {
        if (!this.ctx.societyWorld.isAlive(agentId)) {
          return { agentId, status: 'dead' as const }
        }
        getRestUntil(agentId)
        if (isAgentResting(agentId)) {
          try {
            recordSkip(agentId, 'resting')
          } catch {
            /* */
          }
          this.applyWaitFill(agentId)
          return { agentId, status: 'rest' as const, action: 'wait_fill' }
        }

        try {
          recordWake(agentId)
        } catch {
          /* */
        }

        const ac = new AbortController()
        const work = this.forceIdleWorldTurn(agentId, ac.signal)
        const raced = await Promise.race([
          work.then((r) => ({ tag: 'ok' as const, r })),
          sleepMs(timeoutMs).then(() => ({ tag: 'timeout' as const })),
        ])

        if (raced.tag === 'timeout') {
          ac.abort()
          this.inFlight.delete(agentId)
          try {
            recordSkip(agentId, 'timeout')
          } catch {
            /* */
          }
          this.applyWaitFill(agentId)
          void work.catch(() => undefined)
          return { agentId, status: 'timeout' as const, action: 'wait_fill' }
        }

        const action = raced.r.action
        if (raced.r.didWorldOp) {
          return { agentId, status: 'ok' as const, action }
        }
        this.applyWaitFill(agentId)
        return { agentId, status: 'wait_fill' as const, action: action || 'wait_fill' }
      }),
    )

    this.ctx.societyWorld.endSyncedTurn()
    const w = this.ctx.societyWorld.getState()
    try {
      recordSchedulerTick('synced')
      if (w && typeof w.tick === 'number') setLedgerWorldTick(w.tick)
    } catch {
      /* */
    }

    return {
      tick: this.tickCount,
      worldTick: w?.tick ?? 0,
      results,
    }
  }

  /** Default physics wait when agent timed out or did not world_act this turn. */
  private applyWaitFill(agentId: AgentId): void {
    try {
      if (!this.ctx.societyWorld.isAlive(agentId)) return
      this.ctx.societyWorld.act({
        actor_id: agentId,
        budget_energy: 1,
        actions: [{ op: 'wait' }],
      })
    } catch (err) {
      schedWarn(
        this.ctx,
        `wait_fill fail ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Always invoke one idle LLM turn for synced world (no idle_stale / cooldown skip).
   * Does not enqueue async retry — caller wait_fills on failure.
   */
  private async forceIdleWorldTurn(
    agentId: AgentId,
    signal?: AbortSignal,
  ): Promise<{ action: TickResult['action']; body?: string; didWorldOp: boolean }> {
    if (this.inFlight.has(agentId)) {
      return { action: 'skip', didWorldOp: false }
    }
    this.inFlight.add(agentId)
    try {
      const profile = this.ctx.societyIdentity.require(agentId)
      if (!this.ctx.societyWorld.isAlive(agentId)) {
        return { action: 'skip', didWorldOp: false }
      }

      const others = this.ctx.societyIdentity
        .list()
        .map((a) => a.id)
        .filter((id) => id !== agentId)
      const room =
        (this.defaultRoomId && this.ctx.societyRooms.get(this.defaultRoomId)) ||
        this.ctx.societyRooms.listRooms().find((r) => r.name === 'plaza') ||
        this.ctx.societyRooms.listRooms()[0]
      const roomLabel = room ? `「${room.name}」` : '广场'
      const history = room != null ? this.ctx.societyRooms.historyOf(room.id) : []
      const recent = history
        .slice(-4)
        .map((m) => `${m.from}: ${m.body.slice(0, 60)}`)
        .join('\n')

      if (room) this.ctx.societyTools.setDefaultRoom(room.id)

      let worldLine = ''
      try {
        worldLine = this.ctx.societyWorld.promptWorldSection(agentId)
      } catch {
        try {
          worldLine = this.ctx.societyWorld.formatSnapshotFor(agentId)
        } catch {
          worldLine = '世界状态暂不可用'
        }
      }

      const stimulus = [
        formatBeijingNow(),
        `【阴阳场·同步回合 t_sched=${this.tickCount}】全员并行决策；本回合结束后才结算物理/代谢。`,
        worldLine,
        '必须收束：优先 world_observe 再 world_act（bite/digest/nudge/pull/adsorb/catalyze/wait/revive）。',
        '也可 speak_in_room 短句，但未 world_act 时引擎会代填 wait。',
        '收束工具（必须恰好一个）：world_act / speak_in_room / send_dm / do_nothing / rest',
        recent ? `广场近况：\n${recent}` : '广场安静。',
        `可私信：${others.join(' / ') || '无'}；默认群${roomLabel}。`,
        `语气参考：${profile.persona.slice(0, 120)}`,
      ].join('\n')

      this.ctx.societyMemory.recordLlmCall(agentId)
      const idleStimulusKey = `sync-${this.tickCount}-${agentId}`
      let result: AgentActResult
      const t0 = Date.now()
      try {
        const worldCfg = this.ctx.societyLlm.resolveWorldTurnConfig(agentId)
        result = await this.ctx.societyLlm.actClosedTurn(agentId, { text: stimulus }, 'idle', {
          llmMode: 'sync',
          timeoutMs: worldLlmTimeoutMs(),
          signal,
          cfgOverride: worldCfg,
          skipNudge: true,
          maxToolRounds: 2,
        })
        try {
          recordLlm(agentId, true, Date.now() - t0)
        } catch {
          /* */
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const safe = msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        try {
          recordLlm(agentId, false, Date.now() - t0)
        } catch {
          /* */
        }
        schedWarn(this.ctx, `sync-turn LLM fail ${agentId}: ${safe}`)
        this.lastActAt.set(agentId, Date.now())
        return { action: 'skip', didWorldOp: false }
      }

      this.lastActAt.set(agentId, Date.now())
      const worldOp = result.acted === 'world_act' || result.acted === 'rest'

      if (!result.ok || result.acted === 'none') {
        return { action: 'skip', didWorldOp: false }
      }

      const noted = this.noteClosingAct(agentId, result, idleStimulusKey, {
        roomId: room?.id,
      })
      if (result.sideEffectDone && noted.action !== 'idle-none' && noted.action !== 'silent') {
        await this.consolidateAfterAct(agentId)
      }
      return { action: noted.action, body: noted.body, didWorldOp: worldOp }
    } finally {
      this.inFlight.delete(agentId)
    }
  }

  /**
   * Single-agent slice with a hard time budget.
   * Hung LLM fetch must not block Promise.all / tickRunning forever.
   * On timeout we return skip immediately; the inner work may still finish and
   * clear inFlight in its finally (agent stays busy until then).
   */
  private async runOneAgentTick(agentId: AgentId): Promise<TickActionResult> {
    const provider = this.providerOf(agentId)
    const budget = agentTickBudgetMs()
    const work = this.runOneAgentTickBody(agentId)
    const winner = await Promise.race([
      work.then((r) => ({ tag: 'ok' as const, r })),
      sleepMs(budget).then(() => ({ tag: 'timeout' as const })),
    ])
    if (winner.tag === 'timeout') {
      this.lastActAt.set(agentId, Date.now())
      schedWarn(
        this.ctx,
        `tick timeout agent=${agentId} provider=${provider} after ${budget}ms — releasing tick (inner may still finish)`,
      )
      void work.then(
        (r) => {
          console.warn(
            `[society-scheduler] late finish after timeout agent=${agentId} action=${r.action}`,
          )
        },
        (err) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(
            `[society-scheduler] late error after timeout agent=${agentId}: ${msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')}`,
          )
        },
      )
      try { recordSkip(agentId, 'timeout') } catch { /* */ }
      return { action: 'skip', agentId, provider }
    }
    return winner.r
  }

  /** Inner agent tick (unread drain or idle) — awaited with budget in runOneAgentTick. */
  private async runOneAgentTickBody(agentId: AgentId): Promise<TickActionResult> {
    const provider = this.providerOf(agentId)
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) {
      try { recordSkip(agentId, 'capped') } catch { /* */ }
      return { action: 'capped', agentId, provider }
    }

    const now = Date.now()
    getRestUntil(agentId, now) // clear expired
    const resting = isAgentResting(agentId, now)

    const unread = this.ctx.societyMailbox.list(agentId, { unreadOnly: true })
    if (unread.length > 0) {
      const msg = this.pickBestUnread(agentId, unread, { resting })
      if (!msg) {
        // All room unread deferred by per-tick room cap → fall through to idle if possible
        try { recordSkip(agentId, 'room_defer') } catch { /* */ }
      } else {
        try { recordWake(agentId) } catch { /* */ }
        const outcome = await this.processUnread(agentId, msg)
        return { action: outcome, agentId, provider }
      }
    }

    // While resting: no idle self-loop
    if (resting) {
      try { recordSkip(agentId, 'resting') } catch { /* */ }
      return { action: 'skip', agentId, provider }
    }

    // Idle / self-loop: agents live in their own mind even when plaza is silent.
    // Never wait for an exchange count — seed + SILENT must not freeze the society.
    const lastAct = this.lastActAt.get(agentId) ?? 0
    const stale = lastAct === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastAct
    if (stale < this.idleStaleMs) {
      try { recordSkip(agentId, 'idle_stale') } catch { /* */ }
      return { action: 'skip', agentId, provider }
    }

    try { recordWake(agentId) } catch { /* */ }
    const idle = await this.runIdleThought(agentId)
    return { action: idle.action, agentId, body: idle.body, provider }
  }

  /**
   * Prefer @mention / replyTo-me / DM; skip stale room mail (mark read, no LLM).
   * When room-reply slots for this tick are full, defer room mail (return null).
   */
  private pickBestUnread(
    agentId: AgentId,
    unread: InboxMessage[],
    opts?: { resting?: boolean },
  ): InboxMessage | null {
    const findMsg = (id: string, roomId?: string) =>
      this.ctx.societyRooms.findMessage(id, roomId as RoomId | undefined)
    const after = (roomId: string, sourceId: string) =>
      this.ctx.societyRooms.messagesAfter(roomId as RoomId, sourceId)
    const resting = opts?.resting === true

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
      // Resting: skip agent↔agent DM and unmentioned non-human room mail
      if (resting && !restWakeStimulus(m, agentId, findMsg)) {
        this.ctx.logger('society-scheduler').info(
          `rest-skip ${agentId} mail=${m.id.slice(0, 8)} kind=${m.kind} from=${m.from}`,
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

  /** Map closing tool result → tick action + emit events (no re-post; tools already acted). */
  private noteClosingAct(
    agentId: AgentId,
    result: AgentActResult,
    stimulusId: string,
    opts?: { roomId?: string; steerSearch?: boolean },
  ): { action: TickResult['action']; body?: string } {
    const detail = result.detail || result.acted
    let bodyPreview = ''
    try {
      const j = JSON.parse(result.detail || '') as { text?: string; messageIds?: string[] }
      bodyPreview = j.text || result.acted
    } catch {
      bodyPreview = result.acted
    }

    if (
      result.acted === 'stay_silent' ||
      result.acted === 'do_nothing' ||
      result.acted === 'rest' ||
      result.acted === 'none'
    ) {
      const kind = result.acted === 'stay_silent' ? 'silent' : 'idle-skip'
      this.ctx.emit('society/agent-replied', {
        agentId,
        kind: kind as 'silent' | 'idle-skip',
        body: bodyPreview || `[${result.acted}]`,
        roomId: opts?.roomId,
        stimulusId,
      })
      if (result.acted === 'stay_silent') return { action: 'silent', body: bodyPreview }
      if (result.acted === 'rest') return { action: 'idle-none', body: bodyPreview || '[rest]' }
      return { action: 'idle-none', body: bodyPreview }
    }

    if (result.acted === 'world_act') {
      this.exchangeCount += 1
      this.lastExchangeAt = Date.now()
      this.ctx.emit('society/agent-replied', {
        agentId,
        kind: 'idle-skip',
        body: bodyPreview || '[world_act]',
        stimulusId,
      })
      return { action: 'idle-self', body: bodyPreview || '[world_act]' }
    }

    if (result.acted === 'speak_in_room') {
      this.exchangeCount += 1
      this.lastReplyAgentId = agentId
      this.lastExchangeAt = Date.now()
      this.ctx.emit('society/agent-replied', {
        agentId,
        kind: 'room',
        body: bodyPreview,
        roomId: opts?.roomId,
        stimulusId,
      })
      return {
        action: opts?.steerSearch ? 'idle-search' : 'idle-room',
        body: bodyPreview,
      }
    }

    if (result.acted === 'send_dm') {
      this.exchangeCount += 1
      this.lastReplyAgentId = agentId
      this.lastExchangeAt = Date.now()
      this.ctx.emit('society/agent-replied', {
        agentId,
        kind: 'direct',
        body: bodyPreview,
        stimulusId,
      })
      return { action: 'idle-dm', body: bodyPreview }
    }

    return { action: 'idle-none', body: detail }
  }

  /** Whether background async LLM retries are enabled (default on). */
  private asyncRetryEnabled(): boolean {
    const raw = process.env.SOCIETY_LLM_ASYNC_RETRY?.trim()
    if (raw === '0' || raw === 'false' || raw === 'off') return false
    return true
  }

  private asyncRetryQueueMax(): number {
    return Math.max(1, envInt('SOCIETY_LLM_ASYNC_RETRY_QUEUE', 16) || 16)
  }

  private asyncRetryDedupeKey(agentId: AgentId, stimulusKey: string): string {
    return `${agentId}::${stimulusKey}`
  }

  /**
   * Hand a sync-failed turn to the background retry queue.
   * Returns true if the agent stays inFlight for the async pump to clear.
   * Never blocks the caller beyond a microtask schedule of the pump.
   */
  private enqueueAsyncRetry(job: Omit<AsyncRetryJob, 'enqueuedAt'>): boolean {
    if (!this.asyncRetryEnabled()) return false
    const key = this.asyncRetryDedupeKey(job.agentId, job.stimulusKey)
    if (this.asyncRetryKeys.has(key)) {
      schedWarn(
        this.ctx,
        `async-retry skip-dup agent=${job.agentId} key=${job.stimulusKey.slice(0, 24)}`,
      )
      return false
    }
    if (this.asyncRetryQueue.length >= this.asyncRetryQueueMax()) {
      schedWarn(
        this.ctx,
        `async-retry drop-full agent=${job.agentId} kind=${job.kind} q=${this.asyncRetryQueue.length}`,
      )
      return false
    }
    this.asyncRetryKeys.add(key)
    this.asyncRetryQueue.push({ ...job, enqueuedAt: Date.now() })
    schedWarn(
      this.ctx,
      `async-retry enqueue agent=${job.agentId} kind=${job.kind} mode=${job.mode} key=${job.stimulusKey.slice(0, 24)} syncErr=${job.syncError.slice(0, 120)}`,
    )
    void this.pumpAsyncRetries()
    return true
  }

  /**
   * Drain the async retry queue off the main heartbeat.
   * Uses llmMode=async (full SOCIETY_LLM_MAX_ATTEMPTS + backoff).
   * Delivers at most once per job when closing tools succeed.
   */
  private async pumpAsyncRetries(): Promise<void> {
    if (this.asyncRetryPumping) return
    this.asyncRetryPumping = true
    try {
      while (this.asyncRetryQueue.length > 0) {
        const job = this.asyncRetryQueue.shift()!
        const key = this.asyncRetryDedupeKey(job.agentId, job.stimulusKey)
        // Agent should already be in inFlight (handoff from sync catch)
        this.inFlight.add(job.agentId)
        schedWarn(
          this.ctx,
          `async-retry start agent=${job.agentId} kind=${job.kind} waited=${Date.now() - job.enqueuedAt}ms`,
        )
        try {
          const result = await this.ctx.societyLlm.actClosedTurn(
            job.agentId,
            job.stimulus,
            job.mode,
            { ...job.opts, llmMode: 'async' },
          )
          try { recordLlm(job.agentId, true) } catch { /* */ }
          this.lastActAt.set(job.agentId, Date.now())

          if (
            !result.ok ||
            result.acted === 'stay_silent' ||
            result.acted === 'do_nothing' ||
            result.acted === 'rest' ||
            result.acted === 'none'
          ) {
            schedWarn(
              this.ctx,
              `async-retry done agent=${job.agentId} acted=${result.acted} (no post)`,
            )
            if (job.kind === 'reply') {
              this.ctx.emit('society/agent-replied', {
                agentId: job.agentId,
                kind: 'silent',
                body: '[SILENT-async]',
                roomId: job.roomId,
                stimulusId: job.stimulusKey,
              })
            }
            continue
          }

          if (job.kind === 'idle') {
            const noted = this.noteClosingAct(job.agentId, result, job.stimulusKey, {
              roomId: job.roomId,
              steerSearch: job.steerSearch,
            })
            schedWarn(
              this.ctx,
              `async-retry done agent=${job.agentId} acted=${result.acted} action=${noted.action} (delivered once)`,
            )
            if (result.sideEffectDone && noted.action !== 'idle-none' && noted.action !== 'silent') {
              await this.consolidateAfterAct(job.agentId)
            }
          } else {
            // reply path — tools already posted; count exchange once
            if (!exchangesCapped(this.exchangeCount, this.maxExchanges)) {
              this.exchangeCount += 1
              this.lastReplyAgentId = job.agentId
              this.lastExchangeAt = Date.now()
            }
            if (result.acted === 'speak_in_room') {
              this.ctx.emit('society/agent-replied', {
                agentId: job.agentId,
                kind: 'room',
                body: result.detail || '',
                roomId: job.roomId,
                stimulusId: job.stimulusKey,
              })
            } else if (result.acted === 'send_dm') {
              const to =
                job.stimulus.message?.from &&
                job.stimulus.message.from !== 'system' &&
                job.stimulus.message.from !== 'room'
                  ? job.stimulus.message.from
                  : undefined
              this.ctx.emit('society/agent-replied', {
                agentId: job.agentId,
                kind: 'direct',
                body: result.detail || '',
                to: to as AgentId | undefined,
                stimulusId: job.stimulusKey,
              })
            } else if (result.acted === 'world_act') {
              this.ctx.emit('society/agent-replied', {
                agentId: job.agentId,
                kind: 'idle-skip',
                body: result.detail || '[world_act]',
                stimulusId: job.stimulusKey,
              })
            }
            schedWarn(
              this.ctx,
              `async-retry done agent=${job.agentId} acted=${result.acted} (delivered once)`,
            )
            await this.consolidateAfterAct(job.agentId)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const safe = msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
          try { recordLlm(job.agentId, false) } catch { /* */ }
          schedWarn(
            this.ctx,
            `async-retry fail agent=${job.agentId} kind=${job.kind}: ${safe.slice(0, 200)}`,
          )
          this.lastActAt.set(job.agentId, Date.now())
        } finally {
          this.asyncRetryKeys.delete(key)
          this.inFlight.delete(job.agentId)
        }
      }
    } finally {
      this.asyncRetryPumping = false
      // Jobs enqueued while we were finishing
      if (this.asyncRetryQueue.length > 0) void this.pumpAsyncRetries()
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

    // Rest gate: only human / @ / reply-to-me may proceed; clear snooze on wake
    getRestUntil(agentId)
    if (isAgentResting(agentId)) {
      if (!restWakeStimulus(message, agentId, findMsg)) {
        this.handledMessageIds.add(message.id)
        this.ctx.societyMailbox.markRead(agentId, message.id)
        this.ctx.logger('society-scheduler').info(
          `rest-skip-unread ${agentId} mail=${message.id.slice(0, 8)}`,
        )
        return 'skip'
      }
      clearRest(agentId, mailFromHuman(message) ? 'human-wake' : 'mention-wake')
      this.ctx.logger('society-scheduler').info(
        `rest-wake ${agentId} via ${mailFromHuman(message) ? 'human' : 'mention'} mail=${message.id.slice(0, 8)}`,
      )
    }

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

    let handoffAsync = false
    try {
      this.ctx.societyMailbox.markRead(agentId, message.id)
      this.ctx.societyMemory.recordLlmCall(agentId)

      const roomName =
        message.kind === 'room' && message.roomId
          ? this.ctx.societyRooms.get(message.roomId)?.name
          : undefined

      const mode = message.kind === 'direct' ? 'reply-dm' : 'reply-room'
      const turnOpts = {
        injectReplyTo:
          message.kind === 'room' ? message.sourceMessageId : undefined,
        defaultDmTo:
          message.kind === 'direct' && message.from !== 'system' && message.from !== 'room'
            ? message.from
            : undefined,
      }
      let result: AgentActResult
      try {
        result = await this.ctx.societyLlm.actClosedTurn(
          agentId,
          { message, roomName },
          mode,
          turnOpts,
        )
        try { recordLlm(agentId, true) } catch { /* */ }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const safe = msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        try { recordLlm(agentId, false) } catch { /* */ }
        schedWarn(this.ctx, `LLM sync-fail ${agentId} (no post): ${safe}`)
        this.lastActAt.set(agentId, Date.now())
        handoffAsync = this.enqueueAsyncRetry({
          agentId,
          kind: 'reply',
          stimulusKey: message.id,
          stimulus: { message, roomName },
          mode,
          opts: turnOpts,
          roomId: message.roomId,
          syncError: safe,
        })
        return 'skip'
      }

      this.lastActAt.set(agentId, Date.now())

      if (
        !result.ok ||
        result.acted === 'stay_silent' ||
        result.acted === 'do_nothing' ||
        result.acted === 'rest' ||
        result.acted === 'none'
      ) {
        this.ctx.logger('society-scheduler').info(
          `silent ${agentId} stimulus=${message.id.slice(0, 8)} acted=${result.acted}`,
        )
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'silent',
          body: '[SILENT]',
          roomId: message.roomId,
          stimulusId: message.id,
        })
        return 'silent'
      }

      // Tools already posted — only count exchange / emit
      if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return 'skip'
      this.exchangeCount += 1
      this.lastReplyAgentId = agentId
      this.lastExchangeAt = Date.now()

      if (result.acted === 'speak_in_room') {
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'room',
          body: result.detail || '',
          roomId: message.roomId,
          stimulusId: message.id,
        })
      } else if (result.acted === 'send_dm') {
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'direct',
          body: result.detail || '',
          to: message.from,
          stimulusId: message.id,
        })
      }
      await this.consolidateAfterAct(agentId)
      return 'reply'
    } finally {
      if (!handoffAsync) this.inFlight.delete(agentId)
    }
  }

  private async runIdleThought(
    agentId: AgentId,
  ): Promise<{ action: TickResult['action']; body?: string }> {
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return { action: 'capped' }
    getRestUntil(agentId)
    if (isAgentResting(agentId)) return { action: 'skip' }
    const cool = await this.respectCooldowns(agentId)
    if (!cool) return { action: 'skip' }
    if (this.inFlight.has(agentId)) return { action: 'skip' }

    this.inFlight.add(agentId)
    let handoffAsync = false
    try {
      const profile = this.ctx.societyIdentity.require(agentId)
      if (!this.ctx.societyWorld.isAlive(agentId)) return { action: 'skip' }

      const others = this.ctx.societyIdentity
        .list()
        .map((a) => a.id)
        .filter((id) => id !== agentId)
      const room =
        (this.defaultRoomId && this.ctx.societyRooms.get(this.defaultRoomId)) ||
        this.ctx.societyRooms.listRooms().find((r) => r.name === 'plaza') ||
        this.ctx.societyRooms.listRooms()[0]
      const roomLabel = room ? `「${room.name}」` : '广场'
      const history = room != null ? this.ctx.societyRooms.historyOf(room.id) : []
      const recent =
        history
          .slice(-4)
          .map((m) => `${m.from}: ${m.body.slice(0, 60)}`)
          .join('\n')

      if (room) this.ctx.societyTools.setDefaultRoom(room.id)

      let worldLine = ''
      try {
        worldLine = this.ctx.societyWorld.formatSnapshotFor(agentId)
      } catch {
        worldLine = '世界状态暂不可用'
      }
      const closingList =
        '收束工具（必须恰好一个）：world_act / speak_in_room / send_dm / do_nothing / rest(守卫)'

      const stimulus = [
        formatBeijingNow(),
        '【阴阳场心跳】没有未读。你是场中控制器，聊天只是外壳。',
        worldLine,
        '优先：world_observe 看邻域，再用 world_act。能池够用 → 试探/nudge/复活；濒饿才 bite/digest。连啃硕果会被引擎餍足拒绝。',
        '能池尚可时也可 speak_in_room 短聊；不要日记人格循环。',
        closingList,
        recent ? `广场近况：\n${recent}` : '广场安静——生存优先于寒暄。',
        `可私信：${others.join(' / ') || '无'}；默认群${roomLabel}。`,
        `语气参考：${profile.persona.slice(0, 120)}`,
        '禁止 ACTION: 与纯文本收束。',
      ].join('\n')
      const steerSearch = false

      this.ctx.societyMemory.recordLlmCall(agentId)
      const idleStimulusKey = `idle-${this.tickCount}-${agentId}`
      let result: AgentActResult
      try {
        result = await this.ctx.societyLlm.actClosedTurn(agentId, { text: stimulus }, 'idle')
        try { recordLlm(agentId, true) } catch { /* */ }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const safe = msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        try { recordLlm(agentId, false) } catch { /* */ }
        schedWarn(this.ctx, `idle LLM sync-fail ${agentId}: ${safe}`)
        this.lastActAt.set(agentId, Date.now())
        handoffAsync = this.enqueueAsyncRetry({
          agentId,
          kind: 'idle',
          stimulusKey: idleStimulusKey,
          stimulus: { text: stimulus },
          mode: 'idle',
          roomId: room?.id,
          steerSearch,
          syncError: safe,
        })
        return { action: 'skip' }
      }
      if (steerSearch) this.lastSearchIdleAt.set(agentId, Date.now())
      this.lastActAt.set(agentId, Date.now())

      if (!result.ok || result.acted === 'none') {
        schedWarn(
          this.ctx,
          `idle soft-fail ${agentId}: no closing tool (${result.detail?.slice(0, 80) || ''})`,
        )
        return { action: 'idle-none', body: '' }
      }

      if (exchangesCapped(this.exchangeCount, this.maxExchanges) && result.sideEffectDone) {
        // Side effect already happened via tool — still note it
      } else if (exchangesCapped(this.exchangeCount, this.maxExchanges)) {
        return { action: 'capped' }
      }

      const noted = this.noteClosingAct(agentId, result, idleStimulusKey, {
        roomId: room?.id,
        steerSearch,
      })
      if (result.sideEffectDone && noted.action !== 'idle-none' && noted.action !== 'silent') {
        await this.consolidateAfterAct(agentId)
      }
      return noted
    } finally {
      if (!handoffAsync) this.inFlight.delete(agentId)
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

    getRestUntil(agentId)
    if (isAgentResting(agentId)) {
      if (!restWakeStimulus(message, agentId, findMsg)) {
        this.handledMessageIds.add(message.id)
        this.ctx.societyMailbox.markRead(agentId, message.id)
        this.ctx.logger('society-scheduler').info(
          `rest-skip-wake ${agentId} mail=${message.id.slice(0, 8)}`,
        )
        return
      }
      clearRest(agentId, mailFromHuman(message) ? 'human-wake' : 'mention-wake')
    }

    const mentionOrReply =
      mailMentionsAgent(message, agentId) || mailRepliesToAgent(message, agentId, findMsg)
    if (this.lastReplyAgentId === agentId && !mentionOrReply) {
      this.ctx.logger('society-scheduler').info(
        `skip ${agentId}: would be consecutive self-reply (need other-agent stimulus)`,
      )
      return
    }

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

    let handoffAsync = false
    try {
      this.ctx.societyMailbox.markRead(agentId, message.id)
      this.ctx.societyMemory.recordLlmCall(agentId)

      const roomName =
        message.kind === 'room' && message.roomId
          ? this.ctx.societyRooms.get(message.roomId)?.name
          : undefined

      const mode = message.kind === 'direct' ? 'reply-dm' : 'reply-room'
      const turnOpts = {
        injectReplyTo:
          message.kind === 'room' ? message.sourceMessageId : undefined,
        defaultDmTo:
          message.kind === 'direct' && message.from !== 'system' && message.from !== 'room'
            ? message.from
            : undefined,
      }
      let result: AgentActResult
      try {
        result = await this.ctx.societyLlm.actClosedTurn(
          agentId,
          { message, roomName },
          mode,
          turnOpts,
        )
        try { recordLlm(agentId, true) } catch { /* */ }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const safe = msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        try { recordLlm(agentId, false) } catch { /* */ }
        schedWarn(this.ctx, `LLM sync-fail ${agentId} (no post): ${safe}`)
        this.lastActAt.set(agentId, Date.now())
        handoffAsync = this.enqueueAsyncRetry({
          agentId,
          kind: 'reply',
          stimulusKey: message.id,
          stimulus: { message, roomName },
          mode,
          opts: turnOpts,
          roomId: message.roomId,
          syncError: safe,
        })
        return
      }

      this.lastActAt.set(agentId, Date.now())

      if (
        !result.ok ||
        result.acted === 'stay_silent' ||
        result.acted === 'do_nothing' ||
        result.acted === 'rest' ||
        result.acted === 'none'
      ) {
        this.ctx.logger('society-scheduler').info(
          `silent ${agentId} stimulus=${message.id.slice(0, 8)} acted=${result.acted}`,
        )
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

      if (result.acted === 'speak_in_room') {
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'room',
          body: result.detail || '',
          roomId: message.roomId,
          stimulusId: message.id,
        })
      } else if (result.acted === 'send_dm') {
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'direct',
          body: result.detail || '',
          to: message.from,
          stimulusId: message.id,
        })
      }
      await this.consolidateAfterAct(agentId)
    } finally {
      if (!handoffAsync) this.inFlight.delete(agentId)
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
  'societyMemory',
  'societyTools',
  'societyWorld',
]

export function apply(ctx: Context) {
  ctx.plugin(SocietySchedulerService)
}
