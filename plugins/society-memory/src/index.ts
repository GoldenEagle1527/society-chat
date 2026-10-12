/**
 * society-memory — Per-agent durable working / episodic / semantic memory.
 * Cordis service name: `societyMemory`
 *
 * Persists to data/agents/<id>/memory.json
 * YinYang M0: probe notes (observations / hypotheses / error codes / configs).
 * Casual chat does NOT enter long-term memory by default — world/system events do.
 * Audit: optional data/agents/<id>/memory-log.jsonl
 * Never logs API keys.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AgentId,
  AgentMemoryStore,
  EpisodicMemory,
  MemoryInteraction,
  RoomMessage,
  SemanticBelief,
  WorkingMemoryLine,
} from '../../../src/types.ts'
import {
  providerModelLabel,
  requireProviderConfig,
  societyConsolidateCooldownMs,
  societyWorkingMax,
  normalizeProviderId,
  type LlmProviderId,
} from '../../../src/env.ts'
import { LlmHttpError, withLlmRetries } from '../../../src/llm-http.ts'
import { agentDataDir } from '../../../src/paths.ts'
import { beijingDayStamp } from '../../../src/beijing-time.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyMemory: SocietyMemoryService
  }
}

const EPISODIC_MAX = 40
const SEMANTIC_MAX = 30

interface ConsolidateJson {
  episodic?: Array<{ summary?: string; salience?: number }>
  semantic?: Array<{ subject?: string; belief?: string; confidence?: number }>
}

function emptyStore(): AgentMemoryStore {
  return {
    working: [],
    episodic: [],
    semantic: [],
    updatedAt: new Date().toISOString(),
  }
}

function memoryPath(agentId: AgentId): string {
  return path.join(agentDataDir(agentId), 'memory.json')
}

function memoryLogPath(agentId: AgentId): string {
  return path.join(agentDataDir(agentId), 'memory-log.jsonl')
}

export class SocietyMemoryService extends Service {
  static inject = ['societyIdentity', 'societyRooms']

  private readonly cache = new Map<AgentId, AgentMemoryStore>()
  private readonly lastConsolidateAt = new Map<AgentId, number>()
  private readonly consolidating = new Set<AgentId>()

  constructor(ctx: Context) {
    super(ctx, 'societyMemory')

    ctx.on('society/room-message', (msg: RoomMessage) => {
      // Casual agent/human chat: working only skipped — world/system lines become probe notes.
      if (msg.from !== 'system') return
      const room = ctx.societyRooms.get(msg.roomId)
      const members = room?.members ?? []
      for (const member of members) {
        try {
          this.recordProbeNote(member, {
            kind: 'world_event',
            body: msg.body.slice(0, 240),
            at: msg.createdAt,
          })
        } catch (err) {
          ctx.logger('society-memory').warn(String(err))
        }
      }
    })

    ctx.on('society/mail-delivered', (msg) => {
      if (msg.kind !== 'direct') return
      // Only human/system DMs leave a short probe note; agent↔agent chatter stays out of LTM.
      if (msg.from !== 'human' && msg.from !== 'system') return
      try {
        this.recordProbeNote(msg.to, {
          kind: 'dm_probe',
          body: `${msg.from}: ${msg.body.slice(0, 160)}`,
          at: msg.createdAt,
        })
      } catch (err) {
        ctx.logger('society-memory').warn(String(err))
      }
    })
  }

  workingMax(): number {
    return societyWorkingMax(20)
  }

  consolidateCooldownMs(): number {
    return societyConsolidateCooldownMs(300_000)
  }

  /** @deprecated No hard cap; kept for observe display compatibility (Infinity). */
  dailyLlmBudget(): number {
    return Number.POSITIVE_INFINITY
  }

  load(agentId: AgentId): AgentMemoryStore {
    this.ctx.societyIdentity.require(agentId)
    const cached = this.cache.get(agentId)
    if (cached) return cached
    const file = memoryPath(agentId)
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentMemoryStore
        const store: AgentMemoryStore = {
          working: Array.isArray(raw.working) ? raw.working : [],
          episodic: Array.isArray(raw.episodic) ? raw.episodic : [],
          semantic: Array.isArray(raw.semantic) ? raw.semantic : [],
          updatedAt: raw.updatedAt || new Date().toISOString(),
          budget: raw.budget && typeof raw.budget === 'object'
            ? {
                day: String((raw.budget as { day?: string }).day || ''),
                llmCalls: Number((raw.budget as { llmCalls?: number }).llmCalls) || 0,
              }
            : undefined,
        }
        this.cache.set(agentId, store)
        return store
      } catch {
        /* fall through */
      }
    }
    const store = emptyStore()
    this.cache.set(agentId, store)
    this.persist(agentId, store)
    return store
  }

  rememberInteraction(agentId: AgentId, event: MemoryInteraction): void {
    const store = this.load(agentId)
    const ts = event.at || new Date().toISOString()
    const line: WorkingMemoryLine = {
      ts,
      from: String(event.from),
      body: event.body.slice(0, 500),
      kind: event.kind,
      roomId: event.roomId,
    }
    store.working.push(line)

    if (event.role === 'listener' && event.from !== 'system' && event.from !== 'room') {
      this.nudgeSemantic(store, String(event.from), event.body)
    }
    if (event.role === 'speaker' && event.kind === 'room') {
      this.nudgeSemantic(store, 'self', `我在群里说了：${event.body.slice(0, 80)}`)
    }

    store.updatedAt = new Date().toISOString()
    this.persist(agentId, store)

    // Hard safety cap without LLM if massively overgrown (2× soft max)
    const soft = this.workingMax()
    if (store.working.length > soft * 2) {
      this.dumbConsolidate(agentId, store)
    } else if (store.working.length > soft) {
      // Fire-and-forget LLM consolidate (rate-limited inside)
      void this.consolidateIfNeeded(agentId).catch((err) => {
        this.ctx.logger('society-memory').warn(
          `async consolidate ${agentId}: ${err instanceof Error ? err.message : err}`,
        )
      })
    }
  }

  /**
   * When working overflows soft max, fold oldest overflow into one episodic summary (no LLM).
   * Kept as fallback / emergency cap.
   */
  maybeConsolidate(agentId: AgentId, store?: AgentMemoryStore): void {
    const s = store ?? this.load(agentId)
    if (s.working.length <= this.workingMax()) return
    this.dumbConsolidate(agentId, s)
  }

  /**
   * LLM consolidate when working.length > threshold.
   * At most 1 per agent per SOCIETY_CONSOLIDATE_COOLDOWN_MS; LLM counters are display-only (no daily hard cap).
   * Uses the agent's own free provider (llm.json). Never logs API keys.
   */
  async consolidateIfNeeded(
    agentId: AgentId,
    opts?: { force?: boolean; bypassCooldown?: boolean },
  ): Promise<{ did: boolean; reason: string; episodicAdded?: number }> {
    this.ctx.societyIdentity.require(agentId)
    const store = this.load(agentId)
    const soft = this.workingMax()
    if (store.working.length <= soft && !opts?.force) {
      return { did: false, reason: 'under-threshold' }
    }
    if (this.consolidating.has(agentId)) {
      return { did: false, reason: 'in-flight' }
    }

    const cooldown = this.consolidateCooldownMs()
    const last = this.lastConsolidateAt.get(agentId) ?? 0
    if (!opts?.bypassCooldown && !opts?.force && last > 0 && Date.now() - last < cooldown) {
      return { did: false, reason: 'cooldown' }
    }

    // Need at least soft+1 lines, or force with whatever we have above soft
    if (store.working.length <= soft) {
      return { did: false, reason: 'under-threshold' }
    }

    this.consolidating.add(agentId)
    try {
      const overflowCount = store.working.length - soft
      const chunk = store.working.slice(0, overflowCount)
      const pref = this.ctx.societyIdentity.getLlmPreference(agentId)
      const provider: LlmProviderId = normalizeProviderId(pref.provider)
      const cfg = requireProviderConfig(provider, pref.model)

      this.ctx.logger('society-memory').info(
        `consolidate ${agentId} chunk=${chunk.length} ${providerModelLabel(cfg)}`,
      )

      this.recordLlmCall(agentId)
      const parsed = await this.callConsolidateLlm(agentId, chunk, cfg.provider, cfg.model, cfg.baseUrl, cfg.apiKey)

      // Remove chunk from working (reload in case of concurrent writes — we hold consolidating lock)
      const fresh = this.load(agentId)
      // Drop the oldest overflowCount lines that match our chunk timestamps/bodies loosely
      fresh.working.splice(0, Math.min(overflowCount, fresh.working.length))

      const now = new Date().toISOString()
      let episodicAdded = 0
      const epis = Array.isArray(parsed.episodic) ? parsed.episodic : []
      for (const e of epis.slice(0, 3)) {
        const summary = String(e?.summary || '').trim()
        if (!summary) continue
        const salience = Math.max(0, Math.min(1, Number(e?.salience) || 0.5))
        const entry: EpisodicMemory = { ts: now, summary: summary.slice(0, 400), salience }
        fresh.episodic.push(entry)
        episodicAdded += 1
      }
      if (episodicAdded === 0) {
        // Model returned empty — still persist a minimal episodic so consolidate is visible
        fresh.episodic.push({
          ts: now,
          summary: `早期对话压缩（${chunk.length} 条）：${chunk
            .map((w) => `${w.from}: ${w.body.slice(0, 40)}`)
            .join(' / ')
            .slice(0, 300)}`,
          salience: 0.4,
        })
        episodicAdded = 1
      }
      if (fresh.episodic.length > EPISODIC_MAX) {
        fresh.episodic.splice(0, fresh.episodic.length - EPISODIC_MAX)
      }

      const sems = Array.isArray(parsed.semantic) ? parsed.semantic : []
      for (const s of sems.slice(0, 5)) {
        const subject = String(s?.subject || '').trim().slice(0, 64)
        const belief = String(s?.belief || '').trim().slice(0, 200)
        if (!subject || !belief) continue
        const confidence = Math.max(0, Math.min(1, Number(s?.confidence) || 0.5))
        const existing = fresh.semantic.find((x) => x.subject === subject)
        if (existing) {
          existing.belief = belief
          existing.confidence = Math.min(1, Math.max(existing.confidence, confidence))
        } else {
          fresh.semantic.push({ subject, belief, confidence })
        }
      }
      if (fresh.semantic.length > SEMANTIC_MAX) {
        fresh.semantic.splice(0, fresh.semantic.length - SEMANTIC_MAX)
      }

      fresh.updatedAt = now
      this.persist(agentId, fresh)
      this.lastConsolidateAt.set(agentId, Date.now())
      this.appendMemoryLog(agentId, {
        ts: now,
        kind: 'llm-consolidate',
        provider: cfg.provider,
        model: cfg.model,
        chunkSize: chunk.length,
        episodicAdded,
        semanticTouched: sems.length,
      })
      return { did: true, reason: 'ok', episodicAdded }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.ctx.logger('society-memory').warn(`consolidate failed ${agentId}: ${msg}`)
      // Fallback dumb fold so working stays bounded
      this.dumbConsolidate(agentId, this.load(agentId))
      this.appendMemoryLog(agentId, {
        ts: new Date().toISOString(),
        kind: 'dumb-fallback',
        error: msg.slice(0, 200),
      })
      return { did: false, reason: `llm-error:${msg.slice(0, 80)}` }
    } finally {
      this.consolidating.delete(agentId)
    }
  }

  /**
   * Probe note: observations / hypotheses / error codes / useful configs.
   * Prefer world events; not casual chat.
   */
  recordProbeNote(
    agentId: AgentId,
    note: { kind: string; body: string; at?: string },
  ): void {
    const store = this.load(agentId)
    const line: WorkingMemoryLine = {
      ts: note.at || new Date().toISOString(),
      from: 'probe',
      body: `[${note.kind}] ${note.body}`.slice(0, 400),
      kind: 'self',
    }
    store.working.push(line)
    const soft = this.workingMax()
    if (store.working.length > soft) {
      store.working.splice(0, store.working.length - soft)
    }
    // Promote high-signal world/error notes into semantic hypotheses lightly
    if (/error|err|OUT_OF|NO_ENERGY|starve|death|hypothesis|假设/i.test(note.body + note.kind)) {
      store.semantic.unshift({
        subject: note.kind,
        belief: note.body.slice(0, 160),
        confidence: 0.45,
      })
      if (store.semantic.length > SEMANTIC_MAX) store.semantic.length = SEMANTIC_MAX
    }
    store.updatedAt = new Date().toISOString()
    this.persist(agentId, store)
  }

  /** Short Chinese block for system prompt — probe notes only. */
  getPromptSection(agentId: AgentId): string {
    const s = this.load(agentId)
    const lines: string[] = ['【探测笔记】']
    const probes = s.working.filter((w) => w.from === 'probe' || w.kind === 'self').slice(-8)
    const sem = s.semantic.slice(0, 6)
    if (!probes.length && !sem.length) {
      lines.push('- （尚无探测笔记；用 world_observe / 世界事件积累）')
      return lines.join('\n')
    }
    if (probes.length) {
      lines.push('- 近期探测：')
      for (const w of probes) lines.push(`  · ${w.body.slice(0, 100)}`)
    }
    if (sem.length) {
      lines.push('- 假设 / 错误码：')
      for (const b of sem) lines.push(`  · ${b.subject}: ${b.belief.slice(0, 80)}`)
    }
    return lines.join('\n')
  }

  private todayKey(): string {
    return beijingDayStamp()
  }

  getLlmCallsToday(agentId: AgentId): number {
    const store = this.load(agentId)
    const day = this.todayKey()
    if (!store.budget || store.budget.day !== day) return 0
    return store.budget.llmCalls
  }

  recordLlmCall(agentId: AgentId): number {
    const store = this.load(agentId)
    const day = this.todayKey()
    if (!store.budget || store.budget.day !== day) {
      store.budget = { day, llmCalls: 0 }
    }
    store.budget.llmCalls += 1
    store.updatedAt = new Date().toISOString()
    this.persist(agentId, store)
    return store.budget.llmCalls
  }

  private dumbConsolidate(agentId: AgentId, store: AgentMemoryStore): void {
    const soft = this.workingMax()
    if (store.working.length <= soft) return
    const overflow = store.working.splice(0, store.working.length - soft)
    const summary = overflow
      .map((w) => `${w.from}: ${w.body.slice(0, 60)}`)
      .join(' / ')
      .slice(0, 400)
    const episodic: EpisodicMemory = {
      ts: new Date().toISOString(),
      summary: `早期对话压缩（${overflow.length} 条）：${summary}`,
      salience: 0.4,
    }
    store.episodic.push(episodic)
    if (store.episodic.length > EPISODIC_MAX) {
      store.episodic.splice(0, store.episodic.length - EPISODIC_MAX)
    }
    store.updatedAt = new Date().toISOString()
    this.persist(agentId, store)
  }

  private async callConsolidateLlm(
    agentId: AgentId,
    chunk: WorkingMemoryLine[],
    provider: LlmProviderId,
    model: string,
    baseUrl: string,
    apiKey: string,
  ): Promise<ConsolidateJson> {
    const transcript = chunk
      .map((w) => `[${w.ts}] ${w.from}: ${w.body}`)
      .join('\n')
      .slice(0, 6000)
    const system = [
      '你是记忆整理助手。根据对话片段，输出严格 JSON（不要 markdown 围栏，不要其它文字）：',
      '{"episodic":[{"summary":"中文情节摘要","salience":0.0到1.0}],"semantic":[{"subject":"对象","belief":"信念","confidence":0.0到1.0}]}',
      'episodic 1～3 条；semantic 0～5 条。salience/confidence 为数字。',
    ].join('\n')
    const user = `Agent id: ${agentId}\n请压缩以下 ${chunk.length} 条工作记忆：\n${transcript}`

    const url = `${baseUrl}/chat/completions`
    const log = (msg: string) => this.ctx.logger('society-memory').warn(msg)
    return withLlmRetries(
      `${provider} consolidate`,
      async () => {
        let res: Response
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
              temperature: 0.3,
              max_tokens: 800,
            }),
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new LlmHttpError(provider, 0, `${provider} consolidate network error: ${msg}`)
        }
        const raw = await res.text()
        let data: {
          choices?: Array<{ message?: { content?: string | null } }>
          error?: { message?: string }
        }
        try {
          data = JSON.parse(raw) as typeof data
        } catch {
          throw new LlmHttpError(
            provider,
            res.status,
            `${provider} consolidate non-JSON (HTTP ${res.status})`,
          )
        }
        if (!res.ok) {
          throw new LlmHttpError(
            provider,
            res.status,
            `${provider} consolidate failed: ${data.error?.message || `HTTP ${res.status}`}`,
          )
        }
        const content = (data.choices?.[0]?.message?.content || '').trim()
        if (!content) {
          throw new LlmHttpError(provider, res.status, `${provider} consolidate empty content`)
        }
        return this.parseConsolidateJson(content)
      },
      log,
    )
  }

  private parseConsolidateJson(content: string): ConsolidateJson {
    let text = content.trim()
    // Strip optional ```json fences
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fence) text = fence[1]!.trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) text = text.slice(start, end + 1)
    try {
      return JSON.parse(text) as ConsolidateJson
    } catch {
      throw new Error('consolidate response was not valid JSON')
    }
  }

  private nudgeSemantic(store: AgentMemoryStore, subject: string, body: string): void {
    const positive = /谢谢|感谢|欢迎|开心|喜欢|好|棒|赞|有趣|期待/
    const cautious = /小心|危险|隔离|安全|权限|炸|崩溃/
    let belief = `与我有过互动：${body.slice(0, 40)}`
    let confidence = 0.35
    if (positive.test(body)) {
      belief = `态度偏友善：${body.slice(0, 40)}`
      confidence = 0.55
    } else if (cautious.test(body)) {
      belief = `提到安全/风险相关话题：${body.slice(0, 40)}`
      confidence = 0.5
    }
    const existing = store.semantic.find((x) => x.subject === subject)
    if (existing) {
      existing.belief = belief
      existing.confidence = Math.min(1, existing.confidence + 0.05)
    } else {
      const entry: SemanticBelief = { subject, belief, confidence }
      store.semantic.push(entry)
      if (store.semantic.length > SEMANTIC_MAX) {
        store.semantic.splice(0, store.semantic.length - SEMANTIC_MAX)
      }
    }
  }

  private appendMemoryLog(agentId: AgentId, entry: Record<string, unknown>): void {
    try {
      const dir = agentDataDir(agentId)
      fs.mkdirSync(dir, { recursive: true })
      // Never persist secrets
      const safe = { ...entry }
      delete safe.apiKey
      delete safe.key
      fs.appendFileSync(memoryLogPath(agentId), JSON.stringify(safe) + '\n', 'utf8')
    } catch {
      /* best-effort audit */
    }
  }

  private persist(agentId: AgentId, store: AgentMemoryStore): void {
    const dir = agentDataDir(agentId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(memoryPath(agentId), JSON.stringify(store, null, 2), 'utf8')
    this.cache.set(agentId, store)
  }
}

export const name = 'society-memory'
export const inject = ['societyIdentity', 'societyRooms']

export function apply(ctx: Context) {
  ctx.plugin(SocietyMemoryService)
}
