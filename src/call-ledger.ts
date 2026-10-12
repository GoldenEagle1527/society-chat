/**
 * Call ledger — per-agent observe/act/LLM/wake stats for a live window.
 * Persists to data/society/call-ledger.json. Real counters only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { SOCIETY_STATE_ROOT } from './paths.ts'

export const CALL_LEDGER_FILE = path.join(SOCIETY_STATE_ROOT, 'call-ledger.json')

export const CAST_DISPLAY: Record<string, string> = {
  agnes: '阿宁',
  glm: '老码',
  xingchen_news: '时辰',
  xingchen_lit: '文心',
}

export type SkipReason =
  | 'resting'
  | 'idle_stale'
  | 'capped'
  | 'timeout'
  | 'no_slot'
  | 'room_defer'
  | 'other'

export interface AgentLedger {
  agentId: string
  displayName: string
  observeCalls: number
  observeFail: number
  actCalls: number
  actFail: number
  actAcceptedOps: number
  actRejectedOps: number
  llmInvocations: number
  llmOk: number
  llmFail: number
  wakes: number
  skips: number
  skipReasons: Partial<Record<SkipReason, number>>
  /** Wall ms of each LLM start (for interval). */
  llmAtMs: number[]
  firstEventAt?: string
  lastEventAt?: string
}

export interface CallLedger {
  schema: 1
  /** All numbers are real instrumentation unless noted. */
  estimatedFields: string[]
  windowStartedAt: string | null
  windowEndedAt: string | null
  worldTickStart: number | null
  worldTickEnd: number | null
  schedulerTicks: number
  schedulerTicksCapped: number
  schedulerTicksNone: number
  agents: Record<string, AgentLedger>
  notes: string[]
}

function emptyAgent(agentId: string): AgentLedger {
  return {
    agentId,
    displayName: CAST_DISPLAY[agentId] || agentId,
    observeCalls: 0,
    observeFail: 0,
    actCalls: 0,
    actFail: 0,
    actAcceptedOps: 0,
    actRejectedOps: 0,
    llmInvocations: 0,
    llmOk: 0,
    llmFail: 0,
    wakes: numberZero(),
    skips: 0,
    skipReasons: {},
    llmAtMs: [],
  }
}

function numberZero(): number {
  return 0
}

let ledger: CallLedger = blankLedger()
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function blankLedger(): CallLedger {
  const agents: Record<string, AgentLedger> = {}
  for (const id of Object.keys(CAST_DISPLAY)) agents[id] = emptyAgent(id)
  return {
    schema: 1,
    estimatedFields: [],
    windowStartedAt: null,
    windowEndedAt: null,
    worldTickStart: null,
    worldTickEnd: null,
    schedulerTicks: 0,
    schedulerTicksCapped: 0,
    schedulerTicksNone: 0,
    agents,
    notes: [
      'observe/act counts = world_observe / world_act tool calls (not prompt snapshot injects).',
      'wakes = agent entered runOneAgentTickBody and was not immediately skip/capped before work.',
      'avgLlmIntervalMs derived from llmAtMs timestamps (real).',
    ],
  }
}

function ensureAgent(agentId: string): AgentLedger {
  if (!ledger.agents[agentId]) ledger.agents[agentId] = emptyAgent(agentId)
  return ledger.agents[agentId]!
}

function touch(agentId: string): AgentLedger {
  const a = ensureAgent(agentId)
  const iso = new Date().toISOString()
  if (!a.firstEventAt) a.firstEventAt = iso
  a.lastEventAt = iso
  dirty = true
  scheduleFlush()
  return a
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushCallLedger()
  }, 2000)
}

export function resetCallLedger(opts?: { worldTickStart?: number; note?: string }): void {
  ledger = blankLedger()
  ledger.windowStartedAt = new Date().toISOString()
  ledger.windowEndedAt = null
  ledger.worldTickStart = opts?.worldTickStart ?? 0
  ledger.worldTickEnd = opts?.worldTickStart ?? 0
  if (opts?.note) ledger.notes.push(opts.note)
  dirty = true
  flushCallLedger()
}

export function setLedgerWorldTick(tick: number): void {
  if (ledger.worldTickStart == null) ledger.worldTickStart = tick
  ledger.worldTickEnd = tick
  dirty = true
  scheduleFlush()
}

export function recordObserve(agentId: string, ok: boolean): void {
  if (!CAST_DISPLAY[agentId] && agentId === 'human') return
  const a = touch(agentId)
  a.observeCalls += 1
  if (!ok) a.observeFail += 1
}

export function recordAct(
  agentId: string,
  ok: boolean,
  accepted = 0,
  rejected = 0,
): void {
  if (agentId === 'human') return
  const a = touch(agentId)
  a.actCalls += 1
  if (!ok) a.actFail += 1
  a.actAcceptedOps += accepted
  a.actRejectedOps += rejected
}

export function recordLlm(agentId: string, ok: boolean): void {
  const a = touch(agentId)
  a.llmInvocations += 1
  a.llmAtMs.push(Date.now())
  if (a.llmAtMs.length > 200) a.llmAtMs.splice(0, a.llmAtMs.length - 200)
  if (ok) a.llmOk += 1
  else a.llmFail += 1
}

export function recordWake(agentId: string): void {
  touch(agentId).wakes += 1
}

export function recordSkip(agentId: string, reason: SkipReason): void {
  const a = touch(agentId)
  a.skips += 1
  a.skipReasons[reason] = (a.skipReasons[reason] || 0) + 1
}

export function recordSchedulerTick(action: string): void {
  ledger.schedulerTicks += 1
  if (action === 'capped') ledger.schedulerTicksCapped += 1
  if (action === 'none' || action === 'skip') ledger.schedulerTicksNone += 1
  dirty = true
  scheduleFlush()
}

export function closeCallLedgerWindow(worldTickEnd?: number): CallLedger {
  ledger.windowEndedAt = new Date().toISOString()
  if (worldTickEnd != null) ledger.worldTickEnd = worldTickEnd
  dirty = true
  flushCallLedger()
  return getCallLedgerSnapshot()
}

export function flushCallLedger(): void {
  if (!dirty && fs.existsSync(CALL_LEDGER_FILE)) return
  try {
    fs.mkdirSync(SOCIETY_STATE_ROOT, { recursive: true })
    fs.writeFileSync(CALL_LEDGER_FILE, JSON.stringify(enrich(ledger), null, 2), 'utf8')
    dirty = false
  } catch (err) {
    console.warn('[call-ledger] flush failed', err instanceof Error ? err.message : err)
  }
}

function avgInterval(ms: number[]): number | null {
  if (ms.length < 2) return null
  const sorted = [...ms].sort((a, b) => a - b)
  let sum = 0
  for (let i = 1; i < sorted.length; i++) sum += sorted[i]! - sorted[i - 1]!
  return Math.round(sum / (sorted.length - 1))
}

function enrich(src: CallLedger): CallLedger & {
  aggregate: Record<string, unknown>
  agentsEnriched: Record<string, unknown>
} {
  const agentsEnriched: Record<string, unknown> = {}
  let totalLlm = 0
  for (const [id, a] of Object.entries(src.agents)) {
    totalLlm += a.llmInvocations
    const wallMs =
      a.firstEventAt && a.lastEventAt
        ? Date.parse(a.lastEventAt) - Date.parse(a.firstEventAt)
        : null
    agentsEnriched[id] = {
      ...a,
      avgLlmIntervalMs: avgInterval(a.llmAtMs),
      wallSpanMs: wallMs,
      llmAtMs: a.llmAtMs.slice(-20),
    }
  }
  const started = src.windowStartedAt ? Date.parse(src.windowStartedAt) : null
  const ended = src.windowEndedAt ? Date.parse(src.windowEndedAt) : Date.now()
  const wallSec =
    started != null && ended != null ? Math.max(0.001, (ended - started) / 1000) : null
  const tickDelta =
    src.worldTickStart != null && src.worldTickEnd != null
      ? src.worldTickEnd - src.worldTickStart
      : null
  return {
    ...src,
    agentsEnriched,
    aggregate: {
      totalLlmInvocations: totalLlm,
      schedulerTicks: src.schedulerTicks,
      worldTickDelta: tickDelta,
      wallSeconds: wallSec != null ? Math.round(wallSec * 10) / 10 : null,
      worldTicksPerWallMin:
        wallSec && tickDelta != null ? Math.round((tickDelta / wallSec) * 60 * 10) / 10 : null,
      schedulerTicksPerWallMin:
        wallSec != null ? Math.round((src.schedulerTicks / wallSec) * 60 * 10) / 10 : null,
      expectedSchedulerPerMinAt800ms: 75,
      note: 'expectedSchedulerPerMinAt800ms assumes no LLM stall; real rate is LLM-bound.',
    },
  }
}

export function getCallLedgerSnapshot(): CallLedger {
  return JSON.parse(JSON.stringify(ledger)) as CallLedger
}

export function callLedgerMarkdown(): string {
  const e = enrich(ledger)
  const lines: string[] = [
    '# Call ledger / 调用账',
    '',
    `- window: ${e.windowStartedAt || '?'} → ${e.windowEndedAt || '(open)'}`,
    `- worldTick: ${e.worldTickStart} → ${e.worldTickEnd}`,
    `- schedulerTicks: ${e.schedulerTicks} (capped=${e.schedulerTicksCapped}, none/skip=${e.schedulerTicksNone})`,
    `- aggregate: ${JSON.stringify(e.aggregate)}`,
    '',
    '## Per agent',
    '',
  ]
  for (const id of Object.keys(CAST_DISPLAY)) {
    const a = (e.agentsEnriched as Record<string, any>)[id]
    if (!a) continue
    lines.push(`### ${a.displayName} (${id})`)
    lines.push(
      `- observe: ${a.observeCalls} (fail ${a.observeFail}) · act: ${a.actCalls} (fail ${a.actFail}, acceptedOps ${a.actAcceptedOps}, rejectedOps ${a.actRejectedOps})`,
    )
    lines.push(
      `- LLM: ${a.llmInvocations} (ok ${a.llmOk} / fail ${a.llmFail}) · avgIntervalMs=${a.avgLlmIntervalMs ?? 'n/a'}`,
    )
    lines.push(
      `- wakes=${a.wakes} skips=${a.skips} reasons=${JSON.stringify(a.skipReasons)} · wallSpanMs=${a.wallSpanMs ?? 'n/a'}`,
    )
    lines.push('')
  }
  lines.push('## Notes')
  for (const n of e.notes) lines.push(`- ${n}`)
  return lines.join('\n')
}

/** Load from disk if present (read-only tooling). */
export function loadCallLedgerFromDisk(): CallLedger | null {
  try {
    if (!fs.existsSync(CALL_LEDGER_FILE)) return null
    return JSON.parse(fs.readFileSync(CALL_LEDGER_FILE, 'utf8')) as CallLedger
  } catch {
    return null
  }
}
