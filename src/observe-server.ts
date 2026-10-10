/**
 * Shared observe / society-live HTTP server (Node http only).
 * - Serves Telegram-style UI from public/
 * - observe mode: read-only
 * - live mode: POST /api/say | /api/rooms | /api/dm | /api/agents + composer
 * Never serves .env or API keys.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { RoomMessage } from './types.ts'
import { HUMAN_SPEAKER_ID, speakerLabel } from './types.ts'
import { isForbiddenObservePath, readAgentJournal, readObserveState } from './observe-state.ts'
import { readObserveSettings, type ObserveSettings } from './observe-settings.ts'
import { PROJECT_ROOT } from './paths.ts'

export type ObserveMode = 'observe' | 'live'

export interface SayRequest {
  /** Preferred: chat id from /api/state (room:<id> | dm:... | self:<agentId>) */
  chatId?: string
  roomId?: string
  roomName?: string
  /** DM / self target when not using chatId */
  toAgentId?: string
  text: string
  as?: 'human'
}

export interface SayResult {
  ok: true
  message: RoomMessage
  roomId: string
  roomName: string
  chatId?: string
  kind?: 'room' | 'dm' | 'self'
}

export interface CreateRoomApiRequest {
  name: string
  memberIds: string[]
}

export interface CreateRoomApiResult {
  ok: true
  roomId: string
  roomName: string
  chatId: string
  members: string[]
}

export interface CreateDmApiRequest {
  agentId: string
}

export interface CreateDmApiResult {
  ok: true
  chatId: string
  agentId: string
  created: boolean
  peers: string[]
}

export interface SpawnAgentApiRequest {
  displayName: string
  persona: string
  /** Optional slug; auto-allocated when omitted. */
  id?: string
  /** Comma string or string array. */
  interests?: string[] | string
  /** Initial mood seed. */
  mood?: string
  openness?: number
  trust?: number
  energy?: number
  /** Explicit free LLM: { provider, model? } — omit for balanced routing. */
  llm?: { provider: string; model?: string }
  /** Flat aliases accepted by POST /api/agents */
  provider?: string
  model?: string
}

export interface SpawnAgentApiResult {
  ok: true
  agent: {
    id: string
    displayName: string
    persona: string
    soul: {
      openness: number
      trust: number
      energy: number
      interests: string[]
      mood?: string
    }
    workspacePath: string
    createdAt: string
  }
  llm: { provider: string; model?: string }
  /** Convenience chat ids for UI navigation. */
  chatIds: { self: string; plaza?: string }
}

export interface ObserveServerOptions {
  mode: ObserveMode
  host?: string
  port?: number
  /** Live only: post human message into society. */
  onSay?: (req: SayRequest) => SayResult | Promise<SayResult>
  /** Live only: create group room. */
  onCreateRoom?: (req: CreateRoomApiRequest) => CreateRoomApiResult | Promise<CreateRoomApiResult>
  /** Live only: ensure human↔agent DM surface. */
  onCreateDm?: (req: CreateDmApiRequest) => CreateDmApiResult | Promise<CreateDmApiResult>
  /** Live only: birth a new agent (explicit llm or balanced free routing). */
  onSpawnAgent?: (req: SpawnAgentApiRequest) => SpawnAgentApiResult | Promise<SpawnAgentApiResult>
  /** Optional live status line for /api/state note override. */
  liveNote?: () => string
  /** Optional settings override (defaults to env-derived caps, no keys). */
  getSettings?: () => ObserveSettings
}

export interface ObserveServer {
  server: http.Server
  host: string
  port: number
  close: () => Promise<void>
}

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

function isLocalhost(req: http.IncomingMessage): boolean {
  const ra = req.socket.remoteAddress || ''
  return (
    ra === '127.0.0.1' ||
    ra === '::1' ||
    ra === '::ffff:127.0.0.1' ||
    ra.endsWith('127.0.0.1')
  )
}

/** When SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 (Docker published ports), allow mutating APIs from non-loopback. */
function allowMutatingApi(req: http.IncomingMessage): boolean {
  const flag = (process.env.SOCIETY_OBSERVE_ALLOW_REMOTE_SAY || '').trim()
  if (flag === '1' || /^true$/i.test(flag) || /^yes$/i.test(flag)) return true
  return isLocalhost(req)
}

function readBody(req: http.IncomingMessage, limit = 16_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function safePublicPath(urlPath: string): string | null {
  let rel = decodeURIComponent(urlPath.split('?')[0] || '/')
  if (rel === '/' || rel === '') rel = '/index.html'
  if (rel.includes('..') || rel.includes('\0')) return null
  const full = path.normalize(path.join(PUBLIC_DIR, rel))
  if (!full.startsWith(PUBLIC_DIR)) return null
  return full
}

function serveStatic(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const ext = path.extname(filePath).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  const body = fs.readFileSync(filePath)
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=30',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

export function createObserveServer(opts: ObserveServerOptions): ObserveServer {
  const host = opts.host || process.env.SOCIETY_OBSERVE_HOST?.trim() || '127.0.0.1'
  const port = opts.port ?? (Number(process.env.SOCIETY_OBSERVE_PORT?.trim() || '8787') || 8787)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`)
    const pathname = url.pathname

    if (isForbiddenObservePath(pathname) || pathname.includes('..')) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      try {
        const state = readObserveState()
        state.mode = opts.mode
        state.canSay = opts.mode === 'live' && !!opts.onSay
        if (opts.mode === 'live' && opts.liveNote) {
          state.note = opts.liveNote()
        } else if (opts.mode === 'live') {
          state.note =
            '直播模式：同一进程跑心跳。在会话里发言后，Agent 会在后续 tick 回复。本接口不暴露 .env / API 密钥。'
        }
        sendJson(res, 200, state)
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, mode: opts.mode })
      return
    }

    if (req.method === 'GET' && pathname === '/api/settings') {
      try {
        const settings = opts.getSettings ? opts.getSettings() : readObserveSettings()
        sendJson(res, 200, { ok: true, mode: opts.mode, ...settings })
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    // Full daily diary / thoughts markdown (read-only; same gate as /api/state)
    if (req.method === 'GET' && pathname === '/api/journal') {
      try {
        const agentId = String(url.searchParams.get('agentId') || '').trim()
        const rel =
          String(url.searchParams.get('path') || url.searchParams.get('journalPath') || '').trim()
        if (!agentId || !rel) {
          sendJson(res, 400, { error: 'agentId and path required' })
          return
        }
        const result = readAgentJournal(agentId, rel)
        if (!result.ok) {
          const status = result.error === 'not found' ? 404 : 400
          sendJson(res, status, { error: result.error })
          return
        }
        sendJson(res, 200, result)
      } catch (err) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (req.method === 'POST' && pathname === '/api/say') {
      if (opts.mode !== 'live' || !opts.onSay) {
        sendJson(res, 404, { error: 'say only available in society-live' })
        return
      }
      if (!allowMutatingApi(req)) {
        sendJson(res, 403, {
          error: 'localhost only (set SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 in Docker)',
        })
        return
      }
      try {
        const raw = await readBody(req)
        let parsed: SayRequest
        try {
          parsed = JSON.parse(raw || '{}') as SayRequest
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const text = String(parsed.text || '').trim()
        if (!text) {
          sendJson(res, 400, { error: 'text required' })
          return
        }
        const as = parsed.as || 'human'
        if (as !== 'human' && as !== HUMAN_SPEAKER_ID) {
          sendJson(res, 400, { error: 'as must be human' })
          return
        }
        const result = await opts.onSay({
          chatId: parsed.chatId,
          roomId: parsed.roomId,
          roomName: parsed.roomName,
          toAgentId: parsed.toAgentId,
          text,
          as: 'human',
        })
        sendJson(res, 200, {
          ok: true,
          roomId: result.roomId,
          roomName: result.roomName,
          chatId: result.chatId,
          kind: result.kind,
          message: {
            id: result.message.id,
            roomId: result.message.roomId,
            from: speakerLabel(result.message.from),
            fromId: result.message.from,
            body: result.message.body,
            createdAt: result.message.createdAt,
          },
        })
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (req.method === 'POST' && pathname === '/api/rooms') {
      if (opts.mode !== 'live' || !opts.onCreateRoom) {
        sendJson(res, 404, { error: 'create room only available in society-live' })
        return
      }
      if (!allowMutatingApi(req)) {
        sendJson(res, 403, {
          error: 'localhost only (set SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 in Docker)',
        })
        return
      }
      try {
        const raw = await readBody(req)
        let parsed: CreateRoomApiRequest
        try {
          parsed = JSON.parse(raw || '{}') as CreateRoomApiRequest
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const name = String(parsed.name || '').trim()
        if (!name) {
          sendJson(res, 400, { error: 'name required' })
          return
        }
        if (name.length > 64) {
          sendJson(res, 400, { error: 'name too long (max 64)' })
          return
        }
        const memberIds = Array.isArray(parsed.memberIds)
          ? [...new Set(parsed.memberIds.map((x) => String(x || '').trim()).filter(Boolean))]
          : []
        if (!memberIds.length) {
          sendJson(res, 400, { error: 'memberIds required (at least one agent)' })
          return
        }
        if (memberIds.length > 32) {
          sendJson(res, 400, { error: 'too many members (max 32)' })
          return
        }
        const result = await opts.onCreateRoom({ name, memberIds })
        sendJson(res, 200, result)
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (req.method === 'POST' && pathname === '/api/dm') {
      if (opts.mode !== 'live' || !opts.onCreateDm) {
        sendJson(res, 404, { error: 'create dm only available in society-live' })
        return
      }
      if (!allowMutatingApi(req)) {
        sendJson(res, 403, {
          error: 'localhost only (set SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 in Docker)',
        })
        return
      }
      try {
        const raw = await readBody(req)
        let parsed: CreateDmApiRequest
        try {
          parsed = JSON.parse(raw || '{}') as CreateDmApiRequest
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const agentId = String(parsed.agentId || '').trim()
        if (!agentId) {
          sendJson(res, 400, { error: 'agentId required' })
          return
        }
        const result = await opts.onCreateDm({ agentId })
        sendJson(res, 200, result)
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (req.method === 'POST' && pathname === '/api/agents') {
      if (opts.mode !== 'live' || !opts.onSpawnAgent) {
        sendJson(res, 404, { error: 'spawn agent only available in society-live' })
        return
      }
      if (!allowMutatingApi(req)) {
        sendJson(res, 403, {
          error: 'localhost only (set SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 in Docker)',
        })
        return
      }
      try {
        const raw = await readBody(req)
        let parsed: SpawnAgentApiRequest
        try {
          parsed = JSON.parse(raw || '{}') as SpawnAgentApiRequest
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const displayName = String(parsed.displayName || '').trim()
        const persona = String(parsed.persona || '').trim()
        if (!displayName) {
          sendJson(res, 400, { error: 'displayName required' })
          return
        }
        if (displayName.length > 48) {
          sendJson(res, 400, { error: 'displayName too long (max 48)' })
          return
        }
        if (!persona) {
          sendJson(res, 400, { error: 'persona required' })
          return
        }
        if (persona.length > 800) {
          sendJson(res, 400, { error: 'persona too long (max 800)' })
          return
        }
        let interests: string[] | undefined
        if (typeof parsed.interests === 'string') {
          interests = parsed.interests
            .split(/[,，、]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 8)
        } else if (Array.isArray(parsed.interests)) {
          interests = parsed.interests.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
        }
        const mood = parsed.mood != null ? String(parsed.mood).trim().slice(0, 32) : undefined
        const id = parsed.id != null && String(parsed.id).trim() ? String(parsed.id).trim() : undefined
        const clamp01 = (v: unknown): number | undefined => {
          if (v == null || v === '') return undefined
          const n = Number(v)
          if (!Number.isFinite(n)) return undefined
          return Math.max(0, Math.min(1, n))
        }
        let llm: { provider: string; model?: string } | undefined
        if (parsed.llm && typeof parsed.llm === 'object' && parsed.llm.provider) {
          llm = {
            provider: String(parsed.llm.provider).trim(),
            ...(parsed.llm.model != null && String(parsed.llm.model).trim()
              ? { model: String(parsed.llm.model).trim() }
              : {}),
          }
        }
        const providerFlat =
          parsed.provider != null && String(parsed.provider).trim()
            ? String(parsed.provider).trim()
            : undefined
        const modelFlat =
          parsed.model != null && String(parsed.model).trim()
            ? String(parsed.model).trim()
            : undefined
        const result = await opts.onSpawnAgent({
          displayName,
          persona,
          id,
          interests,
          mood: mood || undefined,
          openness: clamp01(parsed.openness),
          trust: clamp01(parsed.trust),
          energy: clamp01(parsed.energy),
          llm,
          provider: providerFlat,
          model: modelFlat,
        })
        sendJson(res, 200, result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const conflict =
          /already exists/i.test(msg) ||
          /max agents/i.test(msg) ||
          /reserved/i.test(msg)
        sendJson(res, conflict ? 409 : 400, { error: msg })
      }
      return
    }

    // Static UI (Telegram shell)
    if (req.method === 'GET') {
      const filePath = safePublicPath(pathname)
      if (filePath) {
        serveStatic(res, filePath)
        return
      }
    }

    sendJson(res, 404, { error: 'not found' })
  })

  return {
    server,
    host,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

export function listenObserveServer(srv: ObserveServer): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.server.once('error', reject)
    srv.server.listen(srv.port, srv.host, () => resolve())
  })
}
