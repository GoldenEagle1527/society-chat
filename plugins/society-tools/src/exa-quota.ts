/**
 * Exa search daily quota: 1 successful reservation per LLM model id per Beijing calendar day.
 * Persistence: data/society/exa-quota.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { beijingDayStamp } from '../../../src/beijing-time.ts'
import { SOCIETY_STATE_ROOT } from '../../../src/paths.ts'

export const EXA_QUOTA_FILE = path.join(SOCIETY_STATE_ROOT, 'exa-quota.json')
export const EXA_DAILY_LIMIT = 1

export interface ExaQuotaFile {
  /** Beijing YYYY-MM-DD this file is tracking */
  day: string
  /** modelId → ISO timestamp when the slot was consumed */
  used: Record<string, string>
}

function emptyQuota(day: string): ExaQuotaFile {
  return { day, used: {} }
}

/** Read quota file; if day drifted, return a fresh day (does not write until consume). */
export function readExaQuota(now: Date | number = Date.now(), filePath = EXA_QUOTA_FILE): ExaQuotaFile {
  const today = beijingDayStamp(now)
  try {
    if (!fs.existsSync(filePath)) return emptyQuota(today)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ExaQuotaFile>
    const day = typeof raw.day === 'string' ? raw.day : today
    const used =
      raw.used && typeof raw.used === 'object' && !Array.isArray(raw.used)
        ? Object.fromEntries(
            Object.entries(raw.used).filter(
              ([k, v]) => typeof k === 'string' && typeof v === 'string',
            ),
          )
        : {}
    if (day !== today) return emptyQuota(today)
    return { day, used }
  } catch {
    return emptyQuota(today)
  }
}

export function writeExaQuota(quota: ExaQuotaFile, filePath = EXA_QUOTA_FILE): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(quota, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, filePath)
}

export function isExaQuotaExhausted(
  modelId: string,
  now: Date | number = Date.now(),
  filePath = EXA_QUOTA_FILE,
): boolean {
  const id = modelId.trim()
  if (!id) return true
  const q = readExaQuota(now, filePath)
  return Boolean(q.used[id])
}

/**
 * Atomically reserve today's Exa slot for modelId.
 * Returns true if reserved (caller may call Exa); false if already used.
 */
export function tryConsumeExaQuota(
  modelId: string,
  now: Date | number = Date.now(),
  filePath = EXA_QUOTA_FILE,
): boolean {
  const id = modelId.trim()
  if (!id) return false
  const today = beijingDayStamp(now)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  let quota = readExaQuota(now, filePath)
  if (quota.day !== today) quota = emptyQuota(today)
  if (quota.used[id]) return false

  const at = (typeof now === 'number' ? new Date(now) : now).toISOString()
  quota.used[id] = at
  writeExaQuota(quota, filePath)
  return true
}

export function exaQuotaExhaustedMessage(modelId: string): string {
  return `Error: Exa daily quota exhausted for model ${modelId} (${EXA_DAILY_LIMIT}/day, Beijing calendar)`
}
