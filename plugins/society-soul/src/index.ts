/**
 * society-soul — Evolving personality state with audit log.
 * Cordis service name: `societySoul`
 *
 * Persists to data/agents/<id>/soul.json
 * Audit: data/agents/<id>/soul-log.jsonl
 * Seeds from identity profile (agents/*.json) on first run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, RoomMessage, SoulState } from '../../../src/types.ts'
import { agentDataDir } from '../../../src/paths.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societySoul: SocietySoulService
  }
}

export interface SoulRecord extends SoulState {
  updatedAt: string
}

export interface SoulLogEntry {
  ts: string
  reason: string
  before: SoulState
  after: SoulState
  deltas: Partial<Record<'openness' | 'trust' | 'energy', number>>
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function soulPath(agentId: AgentId): string {
  return path.join(agentDataDir(agentId), 'soul.json')
}

function soulLogPath(agentId: AgentId): string {
  return path.join(agentDataDir(agentId), 'soul-log.jsonl')
}

function snapshot(s: SoulState): SoulState {
  return {
    openness: s.openness,
    trust: s.trust,
    energy: s.energy,
    interests: [...s.interests],
    mood: s.mood,
    notes: s.notes,
  }
}

/** Deterministic valence / keyword heuristic (no LLM). */
function heuristicDeltas(body: string, role: 'speaker' | 'listener'): {
  openness: number
  trust: number
  energy: number
  mood?: string
} {
  const text = body
  let openness = 0
  let trust = 0
  let energy = 0
  let mood: string | undefined

  if (/谢谢|感谢|欢迎|开心|喜欢|棒|赞|有趣|期待|嗨|你好/.test(text)) {
    trust += 0.012
    energy += 0.01
    mood = '友善'
  }
  if (/好奇|探索|为什么|怎么|发现|想法|分享/.test(text)) {
    openness += 0.015
    mood = mood || '好奇'
  }
  if (/系统|隔离|安全|权限|细节|工程|工具/.test(text)) {
    energy += role === 'speaker' ? 0.008 : 0.004
    openness += 0.004
  }
  if (/累|烦|讨厌|生气|危险|炸|崩溃|拒绝/.test(text)) {
    trust -= 0.01
    energy -= 0.015
    mood = '警惕'
  }
  if (/吗\？|\?|？/.test(text)) {
    openness += 0.008
    energy -= 0.003
  }
  // Speaking costs a tiny bit of energy; listening a bit less
  if (role === 'speaker') energy -= 0.005
  else energy -= 0.002

  return { openness, trust, energy, mood }
}

export class SocietySoulService extends Service {
  static inject = ['societyIdentity', 'societyRooms']

  private readonly cache = new Map<AgentId, SoulRecord>()

  constructor(ctx: Context) {
    super(ctx, 'societySoul')

    ctx.on('society/room-message', (msg: RoomMessage) => {
      const room = ctx.societyRooms.get(msg.roomId)
      const members = room?.members ?? []
      for (const member of members) {
        const role: 'speaker' | 'listener' =
          msg.from !== 'system' && member === msg.from ? 'speaker' : 'listener'
        try {
          this.nudgeFromText(member, msg.body, role, `room:${msg.roomId.slice(0, 8)}`)
        } catch (err) {
          ctx.logger('society-soul').warn(String(err))
        }
      }
    })

    ctx.on('society/mail-delivered', (msg) => {
      if (msg.kind !== 'direct') return
      try {
        this.nudgeFromText(msg.to, msg.body, 'listener', `dm-from:${msg.from}`)
      } catch (err) {
        ctx.logger('society-soul').warn(String(err))
      }
    })
  }

  /** Load or seed soul.json from identity profile. */
  load(agentId: AgentId): SoulRecord {
    this.ctx.societyIdentity.require(agentId)
    const cached = this.cache.get(agentId)
    if (cached) return cached

    const file = soulPath(agentId)
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SoulRecord
        const record = this.normalize(raw)
        this.cache.set(agentId, record)
        return record
      } catch {
        /* reseed */
      }
    }

    const profile = this.ctx.societyIdentity.require(agentId)
    const record: SoulRecord = {
      ...snapshot(profile.soul),
      mood: profile.soul.mood || '平静',
      notes: profile.soul.notes || '',
      updatedAt: new Date().toISOString(),
    }
    this.persist(agentId, record)
    this.appendLog(agentId, {
      ts: record.updatedAt,
      reason: 'seed-from-profile',
      before: snapshot(profile.soul),
      after: snapshot(record),
      deltas: {},
    })
    this.cache.set(agentId, record)
    return record
  }

  get(agentId: AgentId): SoulRecord {
    return this.load(agentId)
  }

  /** Apply heuristic deltas; writes soul.json + soul-log.jsonl. */
  nudgeFromText(
    agentId: AgentId,
    body: string,
    role: 'speaker' | 'listener',
    reason: string,
  ): SoulRecord {
    const before = this.load(agentId)
    const d = heuristicDeltas(body, role)
    if (d.openness === 0 && d.trust === 0 && d.energy === 0 && !d.mood) {
      return before
    }

    const after: SoulRecord = {
      openness: clamp01(before.openness + d.openness),
      trust: clamp01(before.trust + d.trust),
      energy: clamp01(before.energy + d.energy),
      interests: [...before.interests],
      mood: d.mood || before.mood || '平静',
      notes: before.notes,
      updatedAt: new Date().toISOString(),
    }

    // Interest discovery from keywords (deterministic)
    const interestHints: Array<[RegExp, string]> = [
      [/探索|发现/, '探索'],
      [/聊天|说话|交流/, '聊天'],
      [/系统|工程|工具/, '系统'],
      [/隔离|安全|权限/, '隔离'],
      [/笔记|记录/, '笔记'],
    ]
    for (const [re, tag] of interestHints) {
      if (re.test(body) && !after.interests.includes(tag)) {
        after.interests = [...after.interests, tag].slice(0, 8)
      }
    }

    this.persist(agentId, after)
    this.appendLog(agentId, {
      ts: after.updatedAt,
      reason,
      before: snapshot(before),
      after: snapshot(after),
      deltas: {
        openness: round4(after.openness - before.openness),
        trust: round4(after.trust - before.trust),
        energy: round4(after.energy - before.energy),
      },
    })
    return after
  }

  /** Chinese personality section for system prompt. */
  getPromptSection(agentId: AgentId): string {
    const s = this.load(agentId)
    const lines = [
      '【灵魂 / 性格】',
      `- 开放度=${s.openness.toFixed(2)}，信任=${s.trust.toFixed(2)}，精力=${s.energy.toFixed(2)}`,
      `- 心情：${s.mood || '平静'}`,
      `- 兴趣：${s.interests.length ? s.interests.join('、') : '无'}`,
    ]
    if (s.notes?.trim()) lines.push(`- 备注：${s.notes.trim().slice(0, 120)}`)
    return lines.join('\n')
  }

  private normalize(raw: SoulRecord): SoulRecord {
    return {
      openness: clamp01(Number(raw.openness) || 0.5),
      trust: clamp01(Number(raw.trust) || 0.5),
      energy: clamp01(Number(raw.energy) || 0.5),
      interests: Array.isArray(raw.interests) ? raw.interests.map(String) : [],
      mood: raw.mood || '平静',
      notes: raw.notes || '',
      updatedAt: raw.updatedAt || new Date().toISOString(),
    }
  }

  private persist(agentId: AgentId, record: SoulRecord): void {
    const dir = agentDataDir(agentId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(soulPath(agentId), JSON.stringify(record, null, 2), 'utf8')
    this.cache.set(agentId, record)
  }

  private appendLog(agentId: AgentId, entry: SoulLogEntry): void {
    const dir = agentDataDir(agentId)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(soulLogPath(agentId), JSON.stringify(entry) + '\n', 'utf8')
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

export const name = 'society-soul'
export const inject = ['societyIdentity', 'societyRooms']

export function apply(ctx: Context) {
  ctx.plugin(SocietySoulService)
}
