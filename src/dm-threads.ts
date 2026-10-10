/**
 * Durable human↔agent DM thread registry (sidebar before first message).
 * Never stores secrets.
 */
import fs from 'node:fs'
import { DM_THREADS_STATE_FILE, SOCIETY_STATE_ROOT } from './paths.ts'
import { HUMAN_SPEAKER_ID } from './types.ts'

export interface DmThreadRecord {
  /** Sorted peer pair joined by | e.g. "alice|human" */
  pair: string
  a: string
  b: string
  createdAt: string
}

interface DmThreadsFile {
  threads: DmThreadRecord[]
}

function dmPairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

export function dmChatId(a: string, b: string): string {
  const [x, y] = [a, b].sort()
  return `dm:${x}:${y}`
}

function load(): DmThreadsFile {
  try {
    if (!fs.existsSync(DM_THREADS_STATE_FILE)) return { threads: [] }
    const raw = JSON.parse(fs.readFileSync(DM_THREADS_STATE_FILE, 'utf8')) as DmThreadsFile
    return { threads: Array.isArray(raw.threads) ? raw.threads : [] }
  } catch {
    return { threads: [] }
  }
}

function save(file: DmThreadsFile): void {
  fs.mkdirSync(SOCIETY_STATE_ROOT, { recursive: true })
  const tmp = `${DM_THREADS_STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, DM_THREADS_STATE_FILE)
}

/** Ensure a DM thread exists between human and agent; returns chatId. */
export function ensureHumanDm(agentId: string): { chatId: string; created: boolean; peers: [string, string] } {
  const id = String(agentId || '').trim()
  if (!id || id === HUMAN_SPEAKER_ID || id === 'human' || id === 'system' || id === 'room') {
    throw new Error('agentId required (not human/system)')
  }
  const a = HUMAN_SPEAKER_ID
  const b = id
  const pair = dmPairKey(a, b)
  const file = load()
  const existing = file.threads.find((t) => t.pair === pair)
  if (existing) {
    return { chatId: dmChatId(a, b), created: false, peers: [a, b].sort() as [string, string] }
  }
  const [x, y] = [a, b].sort()
  file.threads.push({
    pair,
    a: x,
    b: y,
    createdAt: new Date().toISOString(),
  })
  save(file)
  return { chatId: dmChatId(a, b), created: true, peers: [x, y] }
}

export function listDmThreads(): DmThreadRecord[] {
  return load().threads
}
