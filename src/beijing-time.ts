/**
 * Asia/Shanghai (UTC+8) calendar helpers — refresh from Date.now() each call.
 * Used in LLM prompts, diary day files, and budget day keys.
 */

export const BEIJING_TZ = 'Asia/Shanghai'

export interface BeijingParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
  /** e.g. 星期六 */
  weekday: string
  /** YYYY-MM-DD */
  date: string
  /** HH:mm */
  clock: string
  /** HH:mm:ss */
  clockWithSeconds: string
}

function pad2(n: string | number): string {
  return String(n).padStart(2, '0')
}

/** Calendar parts in Asia/Shanghai for `at` (default now). */
export function beijingParts(at: Date | number = Date.now()): BeijingParts {
  const d = typeof at === 'number' ? new Date(at) : at
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false,
  })
  const parts = fmt.formatToParts(d)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''

  let hour = get('hour')
  // Some engines emit "24" for midnight
  if (hour === '24') hour = '00'

  const year = get('year')
  const month = pad2(get('month'))
  const day = pad2(get('day'))
  const minute = pad2(get('minute'))
  const second = pad2(get('second'))
  hour = pad2(hour)
  const weekday = get('weekday') || ''

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    date: `${year}-${month}-${day}`,
    clock: `${hour}:${minute}`,
    clockWithSeconds: `${hour}:${minute}:${second}`,
  }
}

/** YYYY-MM-DD in Asia/Shanghai. */
export function beijingDayStamp(at: Date | number = Date.now()): string {
  return beijingParts(at).date
}

/** HH:mm in Asia/Shanghai. */
export function beijingClock(at: Date | number = Date.now()): string {
  return beijingParts(at).clock
}

/**
 * Short prompt line, e.g.
 * `当前北京时间：2026-10-10 星期六 15:08（Asia/Shanghai）`
 */
export function formatBeijingNow(at: Date | number = Date.now()): string {
  const p = beijingParts(at)
  return `当前北京时间：${p.date} ${p.weekday} ${p.clock}（${BEIJING_TZ}）`
}
