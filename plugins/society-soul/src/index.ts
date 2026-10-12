/**
 * society-soul — RETIRED for YinYang M0 (kept as stub for disk compat).
 * Do not use soul.energy for wake/social; use energy_pool / core_integrity.
 * Cordis service name: `societySoul`
 *
 * Persists to data/agents/<id>/soul.json
 * Audit: data/agents/<id>/soul-log.jsonl
 * Seeds from identity profile (agents/*.json) on first run.
 *
 * Soul openness/trust/energy/mood change ONLY via the agent's own
 * subjective tool call (reflect_feelings → applySubjective). No
 * keyword heuristics on room fan-out.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, SoulState } from '../../../src/types.ts'
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

/** Max absolute delta per metric per reflect_feelings call. */
export const SUBJECTIVE_DELTA_CLAMP = 0.05

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function clampDelta(n: number, maxAbs = SUBJECTIVE_DELTA_CLAMP): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(-maxAbs, Math.min(maxAbs, n))
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

export interface SubjectiveSoulPatch {
  /** Relative deltas; each clamped to ±SUBJECTIVE_DELTA_CLAMP then 0–1. */
  openness?: number
  trust?: number
  energy?: number
  /** Optional short mood label (agent's subjective feeling). */
  mood?: string
  /** Optional short reason for the audit log. */
  reason?: string
}

export class SocietySoulService extends Service {
  static inject = ['societyIdentity']

  private readonly cache = new Map<AgentId, SoulRecord>()

  constructor(ctx: Context) {
    super(ctx, 'societySoul')
    // No automatic room/mail heuristic nudges — soul changes only via applySubjective.
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

  /**
   * Apply the agent's own subjective feeling deltas (from reflect_feelings).
   * Only updates THIS agentId. Each numeric delta clamped to ±0.05; result 0–1.
   */
  applySubjective(agentId: AgentId, patch: SubjectiveSoulPatch): SoulRecord {
    const before = this.load(agentId)
    const dOpen = clampDelta(Number(patch.openness ?? 0))
    const dTrust = clampDelta(Number(patch.trust ?? 0))
    const dEnergy = clampDelta(Number(patch.energy ?? 0))
    const moodIn =
      patch.mood != null && String(patch.mood).trim()
        ? String(patch.mood).trim().slice(0, 32)
        : undefined
    const reasonRaw =
      patch.reason != null && String(patch.reason).trim()
        ? String(patch.reason).trim().slice(0, 120)
        : 'reflect_feelings'

    if (dOpen === 0 && dTrust === 0 && dEnergy === 0 && !moodIn) {
      return before
    }

    const after: SoulRecord = {
      openness: clamp01(before.openness + dOpen),
      trust: clamp01(before.trust + dTrust),
      energy: clamp01(before.energy + dEnergy),
      interests: [...before.interests],
      mood: moodIn || before.mood || '平静',
      notes: before.notes,
      updatedAt: new Date().toISOString(),
    }

    this.persist(agentId, after)
    this.appendLog(agentId, {
      ts: after.updatedAt,
      reason: reasonRaw,
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
  /** Soul layer retired for YinYang M0 — empty prompt section. */
  getPromptSection(_agentId: AgentId): string {
    return ''
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
export const inject = ['societyIdentity']

export function apply(ctx: Context) {
  ctx.plugin(SocietySoulService)
}
