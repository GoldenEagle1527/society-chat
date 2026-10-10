/**
 * Read-only snapshot of durable society files under data/.
 * Used by the observe HTTP server — never touches .env or API keys.
 *
 * Exposes Telegram-style chats: group rooms, DM threads, and per-agent
 * personal/self sessions (diary · soul · tool notes).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  AGENTS_DATA_ROOT,
  MESSAGES_STATE_FILE,
  PROJECT_ROOT,
  ROOMS_STATE_FILE,
  agentDataDir,
  agentWorkspaceDir,
} from './paths.ts'
import { listDmThreads } from './dm-threads.ts'

const SECRET_KEY_RE = /(api[_-]?key|secret|password|token|authorization|bearer|agnes_api|glm_api|siliconflow_api)/i

export type ObserveChatKind = 'group' | 'dm' | 'self'

export interface ObserveAgent {
  id: string
  displayName: string
  persona: string
  mood: string
  openness: number
  trust: number
  energy: number
  interests: string[]
  llmProvider: string | null
  llmModel: string | null
  llmCallsToday: number
  llmBudgetDay: string | null
  soulUpdatedAt: string | null
  memoryUpdatedAt: string | null
  soulNotes: string
  avatarColor: string
  initials: string
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

export interface ObserveChatMessage {
  id: string
  chatId: string
  from: string
  fromName: string
  body: string
  createdAt: string
  /** text | diary | soul | tool | system */
  kind: string
}

export interface ObserveChat {
  id: string
  kind: ObserveChatKind
  title: string
  subtitle: string
  /** For group: room id. For self/dm: primary agent. */
  roomId?: string
  agentId?: string
  peerIds?: string[]
  members?: string[]
  avatarColor: string
  initials: string
  lastMessage?: { from: string; fromName: string; body: string; createdAt: string }
  messageCount: number
}

export interface ObserveState {
  generatedAt: string
  projectRoot: string
  note: string
  mode?: 'observe' | 'live'
  canSay?: boolean
  agents: ObserveAgent[]
  rooms: ObserveRoom[]
  chats: ObserveChat[]
  messages: ObserveChatMessage[]
  /** @deprecated UI uses chats+messages; kept for older clients */
  recentMessages: ObserveMessage[]
  recentSoulLog: ObserveSoulLogLine[]
  llmTotals: { byAgent: Record<string, number>; today: number }
}

const AVATAR_PALETTE = [
  '#e17076',
  '#faa774',
  '#e5c07b',
  '#7bc862',
  '#6ec9cb',
  '#65aadd',
  '#a695e7',
  '#ee7aae',
  '#e4b65b',
  '#5cbf9b',
]

function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export function avatarColorFor(id: string): string {
  return AVATAR_PALETTE[hashHue(id) % AVATAR_PALETTE.length]!
}

export function initialsFor(name: string): string {
  const t = String(name || '?').trim()
  if (!t) return '?'
  // Prefer Latin/Chinese first char(s)
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  }
  return t.slice(0, 2).toUpperCase()
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

function clip(s: string, n: number): string {
  const t = String(s ?? '')
  return t.length <= n ? t : t.slice(0, n) + '…'
}

function shortReason(reason: string): string {
  const r = String(reason || '').trim()
  if (!r) return ''
  if (r.startsWith('room:')) return '群聊'
  if (r.startsWith('dm-from:')) return `私信·${r.slice('dm-from:'.length)}`
  if (r === 'seed-from-profile') return '初始化'
  return clip(r, 28)
}


function dmChatId(a: string, b: string): string {
  const [x, y] = [a, b].sort()
  return `dm:${x}:${y}`
}

function selfChatId(agentId: string): string {
  return `self:${agentId}`
}

function roomChatId(roomId: string): string {
  return `room:${roomId}`
}

function listTextFiles(dir: string, maxDepth = 3, acc: { rel: string; mtime: string; size: number }[] = [], depth = 0, base = dir): typeof acc {
  if (depth > maxDepth || !fs.existsSync(dir)) return acc
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      listTextFiles(full, maxDepth, acc, depth + 1, base)
      continue
    }
    if (!/\.(md|txt|json|csv|log)$/i.test(ent.name)) continue
    try {
      const st = fs.statSync(full)
      if (st.size > 200_000) continue
      acc.push({
        rel: path.relative(base, full).split(path.sep).join('/'),
        mtime: st.mtime.toISOString(),
        size: st.size,
      })
    } catch {
      /* skip */
    }
  }
  return acc
}

function readTextPreview(file: string, max = 400): string {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return clip(raw.replace(/\s+/g, ' ').trim(), max)
  } catch {
    return ''
  }
}

export function readObserveState(opts?: {
  messageLimit?: number
  soulLogLimit?: number
  selfMessageLimit?: number
}): ObserveState {
  const messageLimit = opts?.messageLimit ?? 120
  const soulLogLimit = opts?.soulLogLimit ?? 40
  const selfMessageLimit = opts?.selfMessageLimit ?? 40
  const today = todayKeyLocal()
  const agents: ObserveAgent[] = []
  const recentSoulLog: ObserveSoulLogLine[] = []
  const byAgent: Record<string, number> = {}
  const nameById = new Map<string, string>()
  nameById.set('human', '你')
  nameById.set('system', '系统')
  nameById.set('room', '房间')

  const chatMessages: ObserveChatMessage[] = []
  const dmPairKeys = new Set<string>()

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
        llm?: { provider?: string; model?: string }
      }>(path.join(dir, 'profile.json'))
      const soul = safeJsonRead<{
        openness?: number
        trust?: number
        energy?: number
        interests?: string[]
        mood?: string
        notes?: string
        updatedAt?: string
      }>(path.join(dir, 'soul.json'))
      const memory = safeJsonRead<{
        updatedAt?: string
        budget?: { day?: string; llmCalls?: number }
        working?: Array<{
          ts?: string
          from?: string
          body?: string
          kind?: string
          roomId?: string
        }>
      }>(path.join(dir, 'memory.json'))
      const llmPref = safeJsonRead<{ provider?: string; model?: string }>(path.join(dir, 'llm.json'))

      const displayName = profile?.displayName || id
      nameById.set(id, displayName)

      const openness = Number(soul?.openness ?? profile?.soul?.openness ?? 0.5)
      const trust = Number(soul?.trust ?? profile?.soul?.trust ?? 0.5)
      const energy = Number(soul?.energy ?? profile?.soul?.energy ?? 0.5)
      const interests = soul?.interests ?? profile?.soul?.interests ?? []
      const mood = soul?.mood || profile?.soul?.mood || '平静'
      const budgetDay = memory?.budget?.day || null
      const llmCallsToday = budgetDay === today ? Number(memory?.budget?.llmCalls) || 0 : 0
      const llmProvider = llmPref?.provider || profile?.llm?.provider || null
      const llmModel = llmPref?.model || profile?.llm?.model || null

      agents.push({
        id: profile?.id || id,
        displayName,
        persona: (profile?.persona || '').slice(0, 400),
        mood,
        openness,
        trust,
        energy,
        interests: Array.isArray(interests) ? interests.map(String).slice(0, 12) : [],
        llmProvider,
        llmModel,
        llmCallsToday,
        llmBudgetDay: budgetDay,
        soulUpdatedAt: soul?.updatedAt || null,
        memoryUpdatedAt: memory?.updatedAt || null,
        soulNotes: clip(soul?.notes || '', 200),
        avatarColor: avatarColorFor(id),
        initials: initialsFor(displayName),
      })
      byAgent[id] = llmCallsToday

      // --- personal / self session messages ---
      const selfId = selfChatId(id)
      const selfMsgs: ObserveChatMessage[] = []

      // Diary files
      const diaryDir = path.join(agentWorkspaceDir(id), 'diary')
      if (fs.existsSync(diaryDir)) {
        try {
          for (const name of fs.readdirSync(diaryDir).sort()) {
            if (!/\.(md|txt)$/i.test(name)) continue
            const full = path.join(diaryDir, name)
            const st = fs.statSync(full)
            const preview = readTextPreview(full, 500)
            selfMsgs.push({
              id: `diary:${id}:${name}`,
              chatId: selfId,
              from: id,
              fromName: displayName,
              body: preview ? `📔 日记 ${name}\n${preview}` : `📔 日记 ${name}`,
              createdAt: st.mtime.toISOString(),
              kind: 'diary',
            })
          }
        } catch {
          /* skip */
        }
      }

      // Soul log → personality change notes in self chat
      const logPath = path.join(dir, 'soul-log.jsonl')
      if (fs.existsSync(logPath)) {
        try {
          const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
          for (const line of lines.slice(-soulLogLimit)) {
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
              const deltaBits = entry.deltas
                ? Object.entries(entry.deltas)
                    .filter(([, v]) => Math.abs(Number(v)) >= 0.008)
                    .map(([k, v]) => `${k}${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(3)}`)
                    .join(' · ')
                : ''
              selfMsgs.push({
                id: `soul:${id}:${entry.ts || line.slice(0, 24)}`,
                chatId: selfId,
                from: 'system',
                fromName: '灵魂',
                body:
                  `性格微调` +
                  (entry.after?.mood ? ` · 心情${entry.after.mood}` : '') +
                  (entry.reason ? ` · ${shortReason(entry.reason)}` : '') +
                  (deltaBits ? ` · ${deltaBits}` : ''),
                createdAt: entry.ts || new Date(0).toISOString(),
                kind: 'soul',
              })
            } catch {
              /* skip */
            }
          }
        } catch {
          /* skip */
        }
      }

      // Working memory: direct → DM threads; non-room solo thoughts → self
      if (Array.isArray(memory?.working)) {
        for (const w of memory!.working!.slice(-60)) {
          const kind = String(w.kind || '')
          const from = String(w.from || id)
          const body = clip(String(w.body || ''), 500)
          const ts = String(w.ts || '')
          if (!body || !ts) continue

          if (kind === 'direct') {
            const peer = from === id ? 'unknown' : from
            // Prefer pairing speaker with this agent
            const other = from === id ? peer : from
            if (other && other !== 'unknown' && other !== 'system' && other !== 'room') {
              const cid = dmChatId(id, other)
              dmPairKeys.add(`${[id, other].sort().join('|')}`)
              chatMessages.push({
                id: `mem-dm:${id}:${ts}:${hashHue(body) % 1e6}`,
                chatId: cid,
                from,
                fromName: nameById.get(from) || from,
                body,
                createdAt: ts,
                kind: 'text',
              })
            }
          } else if (kind === 'diary' || kind === 'system' || kind === 'idle' || kind === 'tool') {
            selfMsgs.push({
              id: `mem:${id}:${ts}:${hashHue(body) % 1e6}`,
              chatId: selfId,
              from: kind === 'tool' ? 'system' : from === id ? id : from,
              fromName: kind === 'tool' ? '工具' : nameById.get(from) || from,
              body: kind === 'tool' ? body : body,
              createdAt: ts,
              kind: kind === 'tool' ? 'tool' : kind === 'diary' ? 'diary' : 'system',
            })
          }
        }
      }

      // Workspace note files (tool writes) as self activity
      const ws = agentWorkspaceDir(id)
      const files = listTextFiles(ws, 3)
        .filter((f) => !f.rel.startsWith('diary/'))
        .sort((a, b) => a.mtime.localeCompare(b.mtime))
        .slice(-12)
      for (const f of files) {
        const preview = readTextPreview(path.join(ws, f.rel), 280)
        selfMsgs.push({
          id: `file:${id}:${f.rel}:${f.mtime}`,
          chatId: selfId,
          from: 'system',
          fromName: '工作区',
          body:
            `文件 ${f.rel}` +
            (preview ? ` · ${clip(preview.replace(/\s+/g, ' '), 72)}` : ''),
          createdAt: f.mtime,
          kind: 'tool',
        })
      }

      // Inbox direct mails (durable)
      const inboxPath = path.join(agentDataDir(id), 'inbox', 'messages.json')
      const inbox = safeJsonRead<
        Array<{
          id?: string
          to?: string
          from?: string
          kind?: string
          body?: string
          createdAt?: string
        }>
      >(inboxPath)
      if (Array.isArray(inbox)) {
        for (const m of inbox) {
          if (m.kind !== 'direct') continue
          const from = String(m.from || '')
          const to = String(m.to || id)
          if (!from || from === 'room' || from === 'system') continue
          const other = from === id ? to : from
          if (!other || other === id) continue
          const cid = dmChatId(id, other)
          dmPairKeys.add(`${[id, other].sort().join('|')}`)
          chatMessages.push({
            id: String(m.id || `inbox:${id}:${m.createdAt}`),
            chatId: cid,
            from,
            fromName: nameById.get(from) || from,
            body: clip(String(m.body || ''), 500),
            createdAt: String(m.createdAt || ''),
            kind: 'text',
          })
        }
      }

      selfMsgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      // Dedup by id, keep last N
      const seen = new Set<string>()
      const trimmedSelf: ObserveChatMessage[] = []
      for (const m of selfMsgs.reverse()) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        trimmedSelf.push(m)
        if (trimmedSelf.length >= selfMessageLimit) break
      }
      chatMessages.push(...trimmedSelf.reverse())
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
          const from = String(msg.from || '')
          const body = String(msg.body || '').slice(0, 500)
          const createdAt = String(msg.createdAt || '')
          const roomId = String(msg.roomId)
          recentMessages.push({
            id: String(msg.id),
            roomId,
            roomName: roomNameById.get(roomId),
            from,
            body,
            createdAt,
          })
          chatMessages.push({
            id: String(msg.id),
            chatId: roomChatId(roomId),
            from,
            fromName: nameById.get(from) || from,
            body,
            createdAt,
            kind: 'text',
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

  // Deduplicate chat messages (memory + inbox may overlap)
  const msgSeen = new Set<string>()
  const deduped: ObserveChatMessage[] = []
  for (const m of chatMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = `${m.chatId}|${m.from}|${m.createdAt}|${m.body.slice(0, 80)}`
    if (msgSeen.has(key) || msgSeen.has(m.id)) continue
    msgSeen.add(key)
    msgSeen.add(m.id)
    // Refresh agent display names; keep custom labels (灵魂/工具/工作区)
    if (m.from !== 'system' && nameById.has(m.from)) {
      m.fromName = nameById.get(m.from)!
    } else if (!m.fromName) {
      m.fromName = nameById.get(m.from) || m.from
    }
    deduped.push(m)
  }

  // Build chat list
  const chats: ObserveChat[] = []
  const msgsByChat = new Map<string, ObserveChatMessage[]>()
  for (const m of deduped) {
    if (!msgsByChat.has(m.chatId)) msgsByChat.set(m.chatId, [])
    msgsByChat.get(m.chatId)!.push(m)
  }

  for (const r of rooms) {
    const cid = roomChatId(r.id)
    const msgs = msgsByChat.get(cid) || []
    const last = msgs[msgs.length - 1]
    const memberNames = r.members.map((id) => nameById.get(id) || id)
    chats.push({
      id: cid,
      kind: 'group',
      title: r.name,
      subtitle: memberNames.join(', ') || '群聊',
      roomId: r.id,
      members: r.members,
      avatarColor: avatarColorFor(r.id),
      initials: initialsFor(r.name),
      lastMessage: last
        ? { from: last.from, fromName: last.fromName, body: last.body, createdAt: last.createdAt }
        : undefined,
      messageCount: msgs.length,
    })
  }

  for (const a of agents) {
    const cid = selfChatId(a.id)
    const msgs = msgsByChat.get(cid) || []
    const last = msgs[msgs.length - 1]
    chats.push({
      id: cid,
      kind: 'self',
      title: `${a.displayName}`,
      subtitle: '个人空间 · 日记 / 工具 / 灵魂',
      agentId: a.id,
      avatarColor: a.avatarColor,
      initials: a.initials,
      lastMessage: last
        ? { from: last.from, fromName: last.fromName, body: last.body, createdAt: last.createdAt }
        : undefined,
      messageCount: msgs.length,
    })
  }

  // Ensured DM threads (human↔agent) from registry — show even with no messages yet
  for (const t of listDmThreads()) {
    dmPairKeys.add(t.pair)
  }

  for (const pair of dmPairKeys) {
    const [a, b] = pair.split('|') as [string, string]
    const cid = dmChatId(a, b)
    const msgs = msgsByChat.get(cid) || []
    const last = msgs[msgs.length - 1]
    const na = nameById.get(a) || a
    const nb = nameById.get(b) || b
    chats.push({
      id: cid,
      kind: 'dm',
      title: `${na} ↔ ${nb}`,
      subtitle: '私信',
      peerIds: [a, b],
      avatarColor: avatarColorFor(cid),
      initials: initialsFor(na[0]! + nb[0]!),
      lastMessage: last
        ? { from: last.from, fromName: last.fromName, body: last.body, createdAt: last.createdAt }
        : undefined,
      messageCount: msgs.length,
    })
  }

  chats.sort((x, y) => {
    const tx = x.lastMessage?.createdAt || ''
    const ty = y.lastMessage?.createdAt || ''
    return ty.localeCompare(tx)
  })

  const todayTotal = Object.values(byAgent).reduce((a, b) => a + b, 0)

  const state: ObserveState = {
    generatedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    note:
      '旁观只读 data/；请另开终端运行 npm run society-run。本接口不暴露 .env / API 密钥。',
    agents,
    rooms,
    chats,
    messages: deduped,
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
