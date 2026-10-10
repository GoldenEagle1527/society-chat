/**
 * Agent rest / snooze — persist until timestamp under data/agents/<id>/rest.json.
 * Closing tool `rest` writes this; scheduler skips idle & most unread until expiry
 * or a human / @mention wake clears it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beijingParts } from '../../../src/beijing-time.ts'
import { agentDataDir } from '../../../src/paths.ts'

export interface AgentRestState {
  /** ISO UTC instant when rest ends */
  until: string
  reason?: string
  startedAt: string
  /** How until was chosen (for logs / UI) */
  mode: 'until' | 'minutes' | 'morning' | 'default'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function restFilePath(agentId: string): string {
  return path.join(agentDataDir(agentId), 'rest.json')
}

/**
 * Next Asia/Shanghai wall-clock `hour:minute` as a Date (UTC instant).
 * If that time today has already passed (or is within `graceMs`), use tomorrow.
 */
export function nextBeijingWallClock(
  hour: number,
  minute: number,
  from: Date | number = Date.now(),
  graceMs = 60_000,
): Date {
  const nowMs = typeof from === 'number' ? from : from.getTime()
  const p = beijingParts(nowMs)
  const h = Math.max(0, Math.min(23, Math.floor(hour)))
  const m = Math.max(0, Math.min(59, Math.floor(minute)))
  const candidate = new Date(`${p.date}T${pad2(h)}:${pad2(m)}:00+08:00`)
  if (candidate.getTime() > nowMs + graceMs) return candidate
  return new Date(candidate.getTime() + 24 * 60 * 60 * 1000)
}

/**
 * Default rest-until when only `reason` (or empty args) is given:
 * next Beijing 07:00, unless that is <3h or >12h away — then +7 hours
 * (sensible overnight vs midday nap). Documented on the `rest` tool.
 */
export function defaultRestUntil(from: Date | number = Date.now()): Date {
  const nowMs = typeof from === 'number' ? from : from.getTime()
  const morning = nextBeijingWallClock(7, 0, nowMs)
  const hoursUntil = (morning.getTime() - nowMs) / 3_600_000
  if (hoursUntil < 3 || hoursUntil > 12) {
    return new Date(nowMs + 7 * 3_600_000)
  }
  return morning
}

export interface ResolveRestUntilArgs {
  until?: unknown
  minutes?: unknown
  reason?: unknown
}

export interface ResolveRestUntilResult {
  until: Date
  mode: AgentRestState['mode']
}

/**
 * Resolve rest end time from tool args.
 * Priority: minutes → until (ISO | HH:mm | 'morning') → default.
 */
export function resolveRestUntil(
  args: ResolveRestUntilArgs,
  from: Date | number = Date.now(),
): ResolveRestUntilResult {
  const nowMs = typeof from === 'number' ? from : from.getTime()

  if (args.minutes != null && args.minutes !== '') {
    const mins = Number(args.minutes)
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error('minutes must be a positive number')
    }
    const clamped = Math.min(24 * 60, Math.max(1, Math.floor(mins)))
    return { until: new Date(nowMs + clamped * 60_000), mode: 'minutes' }
  }

  if (args.until != null && String(args.until).trim()) {
    const raw = String(args.until).trim()
    const lower = raw.toLowerCase()
    if (lower === 'morning' || lower === '明天早上' || lower === '明早') {
      return { until: nextBeijingWallClock(7, 0, nowMs), mode: 'morning' }
    }
    const hm = raw.match(/^(\d{1,2}):(\d{2})$/)
    if (hm) {
      const hour = parseInt(hm[1]!, 10)
      const minute = parseInt(hm[2]!, 10)
      if (hour > 23 || minute > 59) throw new Error(`invalid Beijing HH:mm: ${raw}`)
      return { until: nextBeijingWallClock(hour, minute, nowMs), mode: 'until' }
    }
    const parsed = Date.parse(raw)
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `until must be ISO timestamp, Beijing HH:mm, or "morning" (got: ${raw.slice(0, 40)})`,
      )
    }
    if (parsed <= nowMs + 30_000) {
      throw new Error('until must be in the future')
    }
    return { until: new Date(parsed), mode: 'until' }
  }

  return { until: defaultRestUntil(nowMs), mode: 'default' }
}

export function readRest(agentId: string): AgentRestState | null {
  const fp = restFilePath(agentId)
  try {
    if (!fs.existsSync(fp)) return null
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<AgentRestState>
    if (typeof raw.until !== 'string' || !raw.until) return null
    const untilMs = Date.parse(raw.until)
    if (!Number.isFinite(untilMs)) return null
    return {
      until: new Date(untilMs).toISOString(),
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : undefined,
      startedAt:
        typeof raw.startedAt === 'string' && raw.startedAt
          ? raw.startedAt
          : new Date().toISOString(),
      mode:
        raw.mode === 'until' ||
        raw.mode === 'minutes' ||
        raw.mode === 'morning' ||
        raw.mode === 'default'
          ? raw.mode
          : 'default',
    }
  } catch {
    return null
  }
}

export function writeRest(
  agentId: string,
  until: Date,
  opts?: { reason?: string; mode?: AgentRestState['mode'] },
): AgentRestState {
  const state: AgentRestState = {
    until: until.toISOString(),
    reason: opts?.reason?.trim() ? opts.reason.trim().slice(0, 200) : undefined,
    startedAt: new Date().toISOString(),
    mode: opts?.mode ?? 'default',
  }
  const fp = restFilePath(agentId)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  const tmp = `${fp}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, fp)
  return state
}

/** True when rest.json exists and until is still in the future. */
export function isAgentResting(agentId: string, now: Date | number = Date.now()): boolean {
  const state = readRest(agentId)
  if (!state) return false
  const nowMs = typeof now === 'number' ? now : now.getTime()
  return Date.parse(state.until) > nowMs
}

/** Rest until Date if currently resting; otherwise null. Expired files are cleared. */
export function getRestUntil(agentId: string, now: Date | number = Date.now()): Date | null {
  const state = readRest(agentId)
  if (!state) return null
  const untilMs = Date.parse(state.until)
  const nowMs = typeof now === 'number' ? now : now.getTime()
  if (untilMs <= nowMs) {
    clearRest(agentId, 'expired')
    return null
  }
  return new Date(untilMs)
}

/** Remove rest.json. Returns true if a file was present. */
export function clearRest(agentId: string, _reason?: string): boolean {
  const fp = restFilePath(agentId)
  try {
    if (!fs.existsSync(fp)) return false
    fs.unlinkSync(fp)
    return true
  } catch {
    return false
  }
}
