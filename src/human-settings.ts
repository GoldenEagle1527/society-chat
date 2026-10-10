/**
 * Persisted human operator display name (data/society/settings.json).
 * Internal speaker id stays HUMAN_SPEAKER_ID (`human`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { SETTINGS_STATE_FILE, SOCIETY_STATE_ROOT } from './paths.ts'

export const DEFAULT_HUMAN_DISPLAY_NAME = '用户'
export const MAX_HUMAN_DISPLAY_NAME_LEN = 32

interface SocietySettingsFile {
  humanDisplayName?: string
}

let cache: string | null = null

function sanitizeHumanDisplayName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[\r\n\0]/g, '')
    .trim()
    .slice(0, MAX_HUMAN_DISPLAY_NAME_LEN)
    .trim()
  return s || DEFAULT_HUMAN_DISPLAY_NAME
}

function readFile(): SocietySettingsFile {
  try {
    if (!fs.existsSync(SETTINGS_STATE_FILE)) return {}
    const raw = fs.readFileSync(SETTINGS_STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as SocietySettingsFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeFile(data: SocietySettingsFile): void {
  fs.mkdirSync(SOCIETY_STATE_ROOT, { recursive: true })
  const tmp = `${SETTINGS_STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, SETTINGS_STATE_FILE)
}

/** Current human display name; default 用户 when unset / empty. */
export function getHumanDisplayName(): string {
  if (cache !== null) return cache
  const fromFile = sanitizeHumanDisplayName(readFile().humanDisplayName)
  cache = fromFile
  return cache
}

/** Persist and return the sanitized display name. */
export function setHumanDisplayName(raw: unknown): string {
  const name = sanitizeHumanDisplayName(raw)
  const prev = readFile()
  writeFile({ ...prev, humanDisplayName: name })
  cache = name
  return name
}

/** Test helper: drop in-memory cache (does not delete the file). */
export function clearHumanDisplayNameCache(): void {
  cache = null
}

/** Absolute path (for docs / debugging). */
export function humanSettingsPath(): string {
  return path.resolve(SETTINGS_STATE_FILE)
}
