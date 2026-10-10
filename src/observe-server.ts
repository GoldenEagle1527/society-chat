/**
 * Shared observe / society-live HTTP server (Node http only).
 * - Serves Telegram-style UI from public/
 * - observe mode: read-only
 * - live mode: POST /api/say (room / DM / self-note) + composer
 * Never serves .env or API keys.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { RoomMessage } from './types.ts'
import { HUMAN_SPEAKER_ID, speakerLabel } from './types.ts'
import { isForbiddenObservePath, readObserveState } from './observe-state.ts'
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

export interface ObserveServerOptions {
  mode: ObserveMode
  host?: string
  port?: number
  /** Live only: post human message into society. */
  onSay?: (req: SayRequest) => SayResult | Promise<SayResult>
  /** Optional live status line for /api/state note override. */
  liveNote?: () => string
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

/** When SOCIETY_OBSERVE_ALLOW_REMOTE_SAY=1 (Docker published ports), allow /api/say from non-loopback. */
function allowSay(req: http.IncomingMessage): boolean {
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

    if (req.method === 'POST' && pathname === '/api/say') {
      if (opts.mode !== 'live' || !opts.onSay) {
        sendJson(res, 404, { error: 'say only available in society-live' })
        return
      }
      if (!allowSay(req)) {
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
