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
 * - same agent cannot reply twice in a row (needs other-agent stimulus between)
 * - per-agent cooldown + global cooldown
 * - each inbox message id handled at most once
 * - LLM call counters in memory.json are display-only (no daily hard cap)
 * - limited parallel replies (SOCIETY_MAX_PARALLEL_REPLIES, prefer different LLM providers)
 * - agents may ACTION:SILENT; replies may be multi-bubble (|||)
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
  /** Idle thought if last act older than this (default 3000). */
  idleStaleMs?: number
  /** @deprecated Ignored — free models have no daily hard cap; counters remain for display. */
  dailyLlmBudget?: number
  /** Gap between multi-bubble posts (default SOCIETY_BUBBLE_GAP_MS || 400). */
  bubbleGapMs?: number
  /** Default plaza room for idle ROOM acts. */
  defaultRoomId?: RoomId
  /**
   * Max agents whose LLM calls may run at once (default SOCIETY_MAX_PARALLEL_REPLIES || 2).
   * Prefer picking agents on different providers when > 1.
   */
  maxParallelReplies?: number
}

export interface TickActionResult {
  action: 'reply' | 'silent' | 'idle-room' | 'idle-dm' | 'idle-diary' | 'idle-none' | 'skip' | 'capped' | 'none'
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

function parseIdleAction(raw: string): {
  body: string
  act: 'room' | 'dm' | 'diary' | 'none'
  to?: string
} {
  const text = raw.trim()
  const lines = text.split(/\r?\n/)
  let actLine = ''
  let cut = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (/^ACTION:\s*(ROOM|DM:\S+|DIARY|NONE)\s*$/i.test(line)) {
      actLine = line
      cut = i
      break
    }
  }
  const body = lines.slice(0, cut).join('\n').trim()
  if (!actLine) {
    // Heuristic fallback: if model forgot ACTION, treat non-empty as room post
    if (body) return { body, act: 'room' }
    return { body: '', act: 'none' }
  }
  const m = actLine.match(/^ACTION:\s*(ROOM|DM:(\S+)|DIARY|NONE)\s*$/i)
  if (!m) return { body, act: 'none' }
  const kind = m[1]!.toUpperCase()
  if (kind === 'ROOM') return { body, act: 'room' }
  if (kind === 'DIARY') return { body, act: 'diary' }
  if (kind === 'NONE') return { body, act: 'none' }
  if (kind.startsWith('DM:')) {
    const to = (m[2] || kind.slice(3)).trim().toLowerCase()
    return { body, act: 'dm', to }
  }
  return { body, act: 'none' }
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
  private idleStaleMs = 3_000
  private bubbleGapMs = 400
  private maxParallelReplies = 2
  private defaultRoomId: RoomId | null = null

  private exchangeCount = 0
  private tickCount = 0
  private lastReplyAgentId: AgentId | null = null
  private lastExchangeAt = 0
  private readonly lastActAt = new Map<AgentId, number>()
  private readonly handledMessageIds = new Set<string>()
  private readonly inFlight = new Set<AgentId>()
  private readonly pending = new Set<Promise<void>>()

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
    this.idleStaleMs = opts?.idleStaleMs ?? envInt('SOCIETY_IDLE_STALE_MS', 3_000)
    this.bubbleGapMs = opts?.bubbleGapMs ?? envInt('SOCIETY_BUBBLE_GAP_MS', 400)
    const parallelRaw = opts?.maxParallelReplies ?? envInt('SOCIETY_MAX_PARALLEL_REPLIES', 2)
    this.maxParallelReplies = Math.max(1, Math.min(8, parallelRaw || 1))
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

    const unread = this.ctx.societyMailbox.list(agentId, { unreadOnly: true }).length
    const staleMs = lastAct === 0 ? 60_000 : Math.max(0, now - lastAct)
    const energy = this.ctx.societySoul.get(agentId).energy
    const explore = Math.random() * 10

    // unread >> stale lastAct >> high energy >> random exploration
    return unread * 10_000 + staleMs / 100 + energy * 100 + explore
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

    const subResults = await Promise.all(agentIds.map((id) => this.runOneAgentTick(id)))
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
      const msg = unread[0]!
      const outcome = await this.processUnread(agentId, msg)
      return { action: outcome, agentId, provider }
    }

    // Idle thought only if stale enough (never idle before any exchange — wait for seed drain)
    const lastAct = this.lastActAt.get(agentId) ?? 0
    const stale = lastAct === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastAct
    if (this.exchangeCount === 0) {
      return { action: 'skip', agentId, provider }
    }
    if (stale < this.idleStaleMs) {
      return { action: 'skip', agentId, provider }
    }

    const idle = await this.runIdleThought(agentId)
    return { action: idle.action, agentId, body: idle.body, provider }
  }

  /** Post one-or-more bubbles to a room or DM with a small human-like gap. */
  private async deliverBubbles(opts: {
    agentId: AgentId
    bubbles: string[]
    stimulusId: string
    roomId?: RoomId
    dmTo?: AgentId
  }): Promise<void> {
    const { agentId, bubbles, stimulusId, roomId, dmTo } = opts
    for (let i = 0; i < bubbles.length; i++) {
      const body = bubbles[i]!
      if (i > 0 && this.bubbleGapMs > 0) await sleep(this.bubbleGapMs)
      if (roomId) {
        this.ctx.societyRooms.post({ roomId, from: agentId, body })
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
    if (this.lastReplyAgentId === agentId) {
      this.ctx.logger('society-scheduler').info(
        `skip ${agentId}: would be consecutive self-reply (need other-agent stimulus)`,
      )
      return 'skip'
    }
    const cool = await this.respectCooldowns(agentId)
    if (!cool) return 'skip'
    if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return 'skip'

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
        await this.deliverBubbles({
          agentId,
          bubbles: turn.bubbles,
          stimulusId: message.id,
          roomId: message.roomId,
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
    if (this.lastReplyAgentId === agentId) {
      // Prefer letting someone else go; soft skip
      return { action: 'skip' }
    }
    const cool = await this.respectCooldowns(agentId)
    if (!cool) return { action: 'skip' }
    if (this.inFlight.has(agentId)) return { action: 'skip' }

    this.inFlight.add(agentId)
    try {
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

      const stimulus = [
        '【空闲思考 / 自主行动】你现在没有未读消息。请只做一件小事，不要刷屏、不要长篇大论（1～2 句）。',
        `可选：`,
        `1) 在群聊${roomLabel}说一句观察或延续话题`,
        `2) 私信另一人一句（对象 id：${others.join(' / ') || '无'}）`,
        `3) 写一句日记（我会存到你的 workspace）`,
        `4) 什么都不做`,
        recent ? `广场近况：\n${recent}` : '广场尚安静。',
        '先写正文（要发言/日记的内容），最后一行必须是下列之一：',
        'ACTION:ROOM',
        'ACTION:DM:<agentId>',
        'ACTION:DIARY',
        'ACTION:NONE',
      ].join('\n')

      this.ctx.societyMemory.recordLlmCall(agentId)
      // Idle: no tools (cheaper); diary written by scheduler
      const raw = await this.ctx.societyLlm.replyAsAgent(agentId, { text: stimulus })
      const parsed = parseIdleAction(raw)

      this.lastActAt.set(agentId, Date.now())

      if (parsed.act === 'none' || !parsed.body.trim()) {
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'idle-skip',
          body: parsed.body || '[NONE]',
          stimulusId: `idle-${this.tickCount}`,
        })
        return { action: 'idle-none', body: parsed.body }
      }

      if (exchangesCapped(this.exchangeCount, this.maxExchanges)) return { action: 'capped' }

      if (parsed.act === 'diary') {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        const path = `diary/${stamp}.md`
        const content = `# 日记\n\n${parsed.body || '（空白）'}\n`
        this.ctx.societyTools.writeFile(agentId, path, content)
        // Diary does not wake others; still counts lightly toward exchange to limit spam
        this.exchangeCount += 1
        this.lastReplyAgentId = agentId
        this.lastExchangeAt = Date.now()
        this.ctx.emit('society/agent-replied', {
          agentId,
          kind: 'diary',
          body: parsed.body || '',
          stimulusId: `idle-${this.tickCount}`,
        })
        await this.consolidateAfterAct(agentId)
        return { action: 'idle-diary', body: parsed.body }
      }

      if (parsed.act === 'dm') {
        const to = parsed.to
        if (!to || !this.ctx.societyIdentity.get(to) || to === agentId) {
          return { action: 'idle-none', body: parsed.body }
        }
        const bubbles = parseAgentTurn(parsed.body || '……').bubbles
        const parts = bubbles.length ? bubbles : [parsed.body || '……']
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

      // room
      if (!room) return { action: 'idle-none', body: parsed.body }
      {
        const bubbles = parseAgentTurn(parsed.body || '……').bubbles
        const parts = bubbles.length ? bubbles : [parsed.body || '……']
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
        return { action: 'idle-room', body: parts.join(' ||| ') }
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
    if (this.lastReplyAgentId === agentId) {
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
