/**
 * Read-only snapshot of durable society files under data/.
 * Used by the observe HTTP server — never touches .env or API keys.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  AGENTS_DATA_ROOT,
  MESSAGES_STATE_FILE,
  PROJECT_ROOT,
  ROOMS_STATE_FILE,
} from './paths.ts'

const SECRET_KEY_RE = /(api[_-]?key|secret|password|token|authorization|bearer|agnes_api)/i

export interface ObserveAgent {
  id: string
  displayName: string
  persona: string
  mood: string
  openness: number
  trust: number
  energy: number
  interests: string[]
  llmCallsToday: number
  llmBudgetDay: string | null
  soulUpdatedAt: string | null
  memoryUpdatedAt: string | null
}

export interface ObserveRoom {
  id: string
  name: string
  members: string[]
  createdBy: string
  createdAt: string
}

export interface ObserveMessage {
  id: string
  roomId: string
  roomName?: string
  from: string
  body: string
  createdAt: string
}

export interface ObserveSoulLogLine {
  agentId: string
  ts: string
  reason: string
  mood?: string
  deltas?: Record<string, number>
}

export interface ObserveState {
  generatedAt: string
  projectRoot: string
  note: string
  agents: ObserveAgent[]
  rooms: ObserveRoom[]
  recentMessages: ObserveMessage[]
  recentSoulLog: ObserveSoulLogLine[]
  llmTotals: { byAgent: Record<string, number>; today: number }
}

function safeJsonRead<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function stripSecrets<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((v) => stripSecrets(v)) as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[redacted]'
      continue
    }
    out[k] = stripSecrets(v)
  }
  return out as T
}

function todayKeyLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function readObserveState(opts?: { messageLimit?: number; soulLogLimit?: number }): ObserveState {
  const messageLimit = opts?.messageLimit ?? 40
  const soulLogLimit = opts?.soulLogLimit ?? 30
  const today = todayKeyLocal()
  const agents: ObserveAgent[] = []
  const recentSoulLog: ObserveSoulLogLine[] = []
  const byAgent: Record<string, number> = {}

  if (fs.existsSync(AGENTS_DATA_ROOT)) {
    for (const id of fs.readdirSync(AGENTS_DATA_ROOT).sort()) {
      const dir = path.join(AGENTS_DATA_ROOT, id)
      if (!fs.statSync(dir).isDirectory()) continue
      const profile = safeJsonRead<{
        id?: string
        displayName?: string
        persona?: string
        soul?: {
          openness?: number
          trust?: number
          energy?: number
          interests?: string[]
          mood?: string
        }
      }>(path.join(dir, 'profile.json'))
      const soul = safeJsonRead<{
        openness?: number
        trust?: number
        energy?: number
        interests?: string[]
        mood?: string
        updatedAt?: string
      }>(path.join(dir, 'soul.json'))
      const memory = safeJsonRead<{
        updatedAt?: string
        budget?: { day?: string; llmCalls?: number }
      }>(path.join(dir, 'memory.json'))

      const openness = Number(soul?.openness ?? profile?.soul?.openness ?? 0.5)
      const trust = Number(soul?.trust ?? profile?.soul?.trust ?? 0.5)
      const energy = Number(soul?.energy ?? profile?.soul?.energy ?? 0.5)
      const interests = soul?.interests ?? profile?.soul?.interests ?? []
      const mood = soul?.mood || profile?.soul?.mood || '平静'
      const budgetDay = memory?.budget?.day || null
      const llmCalls =
        budgetDay === today ? Number(memory?.budget?.llmCalls) || 0 : Number(memory?.budget?.llmCalls) || 0
      // Only count toward "today" total when day matches
      const llmCallsToday = budgetDay === today ? Number(memory?.budget?.llmCalls) || 0 : 0

      agents.push({
        id: profile?.id || id,
        displayName: profile?.displayName || id,
        persona: (profile?.persona || '').slice(0, 200),
        mood,
        openness,
        trust,
        energy,
        interests: Array.isArray(interests) ? interests.map(String).slice(0, 12) : [],
        llmCallsToday,
        llmBudgetDay: budgetDay,
        soulUpdatedAt: soul?.updatedAt || null,
        memoryUpdatedAt: memory?.updatedAt || null,
      })
      byAgent[id] = llmCallsToday

      const logPath = path.join(dir, 'soul-log.jsonl')
      if (fs.existsSync(logPath)) {
        try {
          const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
          for (const line of lines.slice(-20)) {
            try {
              const entry = JSON.parse(line) as {
                ts?: string
                reason?: string
                after?: { mood?: string }
                deltas?: Record<string, number>
              }
              recentSoulLog.push({
                agentId: id,
                ts: entry.ts || '',
                reason: entry.reason || '',
                mood: entry.after?.mood,
                deltas: entry.deltas,
              })
            } catch {
              /* skip */
            }
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  recentSoulLog.sort((a, b) => a.ts.localeCompare(b.ts))
  const soulTrimmed = recentSoulLog.slice(-soulLogLimit)

  const roomsFile = safeJsonRead<{ rooms?: ObserveRoom[] }>(ROOMS_STATE_FILE)
  const rooms: ObserveRoom[] = Array.isArray(roomsFile?.rooms)
    ? roomsFile!.rooms.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        members: Array.isArray(r.members) ? r.members.map(String) : [],
        createdBy: String(r.createdBy || 'system'),
        createdAt: String(r.createdAt || ''),
      }))
    : []
  const roomNameById = new Map(rooms.map((r) => [r.id, r.name]))

  const recentMessages: ObserveMessage[] = []
  if (fs.existsSync(MESSAGES_STATE_FILE)) {
    try {
      const lines = fs.readFileSync(MESSAGES_STATE_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
      for (const line of lines.slice(-messageLimit * 2)) {
        try {
          const msg = JSON.parse(line) as {
            id?: string
            roomId?: string
            from?: string
            body?: string
            createdAt?: string
          }
          if (!msg.id || !msg.roomId) continue
          recentMessages.push({
            id: String(msg.id),
            roomId: String(msg.roomId),
            roomName: roomNameById.get(String(msg.roomId)),
            from: String(msg.from || ''),
            body: String(msg.body || '').slice(0, 500),
            createdAt: String(msg.createdAt || ''),
          })
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  recentMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const messagesTrimmed = recentMessages.slice(-messageLimit)

  const todayTotal = Object.values(byAgent).reduce((a, b) => a + b, 0)

  const state: ObserveState = {
    generatedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    note:
      '旁观只读 data/；请另开终端运行 npm run society-run。本接口不暴露 .env / API 密钥。',
    agents,
    rooms,
    recentMessages: messagesTrimmed,
    recentSoulLog: soulTrimmed,
    llmTotals: { byAgent, today: todayTotal },
  }
  return stripSecrets(state)
}

/** Reject any path that could leak secrets via the observe HTTP API. */
export function isForbiddenObservePath(urlPath: string): boolean {
  const p = urlPath.toLowerCase()
  return (
    p.includes('.env') ||
    p.includes('api_key') ||
    p.includes('apikey') ||
    p.includes('/secrets') ||
    p.endsWith('.pem') ||
    p.endsWith('.key')
  )
}
