/**
 * society-memory — Per-agent durable working / episodic / semantic memory.
 * Cordis service name: `societyMemory`
 *
 * Persists to data/agents/<id>/memory.json
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
import { agentDataDir } from '../../../src/paths.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyMemory: SocietyMemoryService
  }
}

const WORKING_MAX = 20
const EPISODIC_MAX = 40
const SEMANTIC_MAX = 30

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

export class SocietyMemoryService extends Service {
  static inject = ['societyIdentity', 'societyRooms']

  private readonly cache = new Map<AgentId, AgentMemoryStore>()

  constructor(ctx: Context) {
    super(ctx, 'societyMemory')

    // Every room post lightly updates speaker + listeners
    ctx.on('society/room-message', (msg: RoomMessage) => {
      const room = ctx.societyRooms.get(msg.roomId)
      const members = room?.members ?? []
      const roomName = room?.name
      for (const member of members) {
        const role = member === msg.from ? 'speaker' : 'listener'
        // system posts: everyone is listener
        const effectiveRole =
          msg.from === 'system' ? 'listener' : role
        try {
          this.rememberInteraction(member, {
            kind: 'room',
            from: msg.from,
            body: msg.body,
            roomId: msg.roomId,
            roomName,
            role: effectiveRole,
            at: msg.createdAt,
          })
        } catch (err) {
          ctx.logger('society-memory').warn(String(err))
        }
      }
    })

    // Direct mail: recipient as listener; sender tracked if known agent
    ctx.on('society/mail-delivered', (msg) => {
      if (msg.kind !== 'direct') return
      try {
        this.rememberInteraction(msg.to, {
          kind: 'direct',
          from: msg.from,
          body: msg.body,
          role: 'listener',
          at: msg.createdAt,
        })
      } catch (err) {
        ctx.logger('society-memory').warn(String(err))
      }
      if (msg.from !== 'system' && msg.from !== 'room') {
        try {
          if (ctx.societyIdentity.get(msg.from)) {
            this.rememberInteraction(msg.from, {
              kind: 'direct',
              from: msg.from,
              body: msg.body,
              role: 'speaker',
              at: msg.createdAt,
            })
          }
        } catch {
          /* sender may be synthetic */
        }
      }
    })
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
    this.maybeConsolidate(agentId, store)

    // Light semantic nudge from listener perspective
    if (event.role === 'listener' && event.from !== 'system' && event.from !== 'room') {
      this.nudgeSemantic(store, String(event.from), event.body)
    }
    if (event.role === 'speaker' && event.kind === 'room') {
      // Speaker recalls they addressed the room
      this.nudgeSemantic(store, 'self', `我在群里说了：${event.body.slice(0, 80)}`)
    }

    store.updatedAt = new Date().toISOString()
    this.persist(agentId, store)
  }

  /**
   * When working overflows WORKING_MAX, fold oldest overflow into one episodic summary.
   */
  maybeConsolidate(agentId: AgentId, store?: AgentMemoryStore): void {
    const s = store ?? this.load(agentId)
    if (s.working.length <= WORKING_MAX) return

    const overflow = s.working.splice(0, s.working.length - WORKING_MAX)
    const summary = overflow
      .map((w) => `${w.from}: ${w.body.slice(0, 60)}`)
      .join(' / ')
      .slice(0, 400)
    const episodic: EpisodicMemory = {
      ts: new Date().toISOString(),
      summary: `早期对话压缩（${overflow.length} 条）：${summary}`,
      salience: 0.4,
    }
    s.episodic.push(episodic)
    if (s.episodic.length > EPISODIC_MAX) {
      s.episodic.splice(0, s.episodic.length - EPISODIC_MAX)
    }
    s.updatedAt = new Date().toISOString()
    this.persist(agentId, s)
  }

  /** Short Chinese block for system prompt. */
  getPromptSection(agentId: AgentId): string {
    const s = this.load(agentId)
    const lines: string[] = ['【记忆】']
    if (s.working.length === 0 && s.episodic.length === 0 && s.semantic.length === 0) {
      lines.push('- （尚无记忆）')
      return lines.join('\n')
    }
    const recent = s.working.slice(-6)
    if (recent.length) {
      lines.push('- 近期对话：')
      for (const w of recent) {
        lines.push(`  · ${w.from}: ${w.body.slice(0, 80)}`)
      }
    }
    const epi = s.episodic.slice(-3)
    if (epi.length) {
      lines.push('- 情节记忆：')
      for (const e of epi) {
        lines.push(`  · (${e.salience.toFixed(1)}) ${e.summary.slice(0, 100)}`)
      }
    }
    const sem = s.semantic.slice(0, 5)
    if (sem.length) {
      lines.push('- 信念：')
      for (const b of sem) {
        lines.push(`  · 关于 ${b.subject}：${b.belief}（置信 ${b.confidence.toFixed(2)}）`)
      }
    }
    return lines.join('\n')
  }


  /** Calendar day key in local (box) timezone. */
  private todayKey(): string {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  getLlmCallsToday(agentId: AgentId): number {
    const store = this.load(agentId)
    const day = this.todayKey()
    if (!store.budget || store.budget.day !== day) return 0
    return store.budget.llmCalls
  }

  /** Increment daily LLM call counter; returns new count. */
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
