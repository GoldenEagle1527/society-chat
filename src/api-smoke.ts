/**
 * Cheap API smoke: mock live observe server — rooms / dm / settings / say guard.
 * No LLM calls. Never prints API keys.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { loadDotEnv } from './env.ts'
import {
  createObserveServer,
  listenObserveServer,
  type CreateDmApiResult,
  type CreateRoomApiResult,
  type SayResult,
} from './observe-server.ts'
import { ensureHumanDm, listDmThreads } from './dm-threads.ts'
import { readObserveSettings } from './observe-settings.ts'
import { HUMAN_SPEAKER_ID } from './types.ts'
import { readObserveState } from './observe-state.ts'

async function jsonFetch(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function main(): Promise<void> {
  console.log('=== society-chat api-smoke ===')
  loadDotEnv()

  const settings = readObserveSettings()
  assert.ok(settings.maxParallelReplies >= 1)
  assert.ok(Array.isArray(settings.providers))
  for (const p of settings.providers) {
    assert.ok(p.id === 'agnes' || p.id === 'glm')
    assert.equal(typeof p.configured, 'boolean')
    // Must never leak key material in settings object
    assert.equal((p as any).apiKey, undefined)
  }
  assert.ok(settings.envNote.includes('.env'))
  console.log(
    `✓ settings caps parallel=${settings.maxParallelReplies} exchanges=${settings.maxExchanges} providers=${settings.providers
      .filter((p) => p.configured)
      .map((p) => p.id)
      .join(',') || 'none'}`,
  )

  let roomsCreated = 0
  let dmCreated = 0

  const srv = createObserveServer({
    mode: 'live',
    host: '127.0.0.1',
    port: 0, // ephemeral — we'll read address after listen
    onSay: async (req): Promise<SayResult> => {
      return {
        ok: true,
        message: {
          id: 'msg-test',
          roomId: 'room-test',
          from: HUMAN_SPEAKER_ID,
          body: req.text,
          createdAt: new Date().toISOString(),
        },
        roomId: 'room-test',
        roomName: 'test',
        chatId: req.chatId || 'room:test',
        kind: 'room',
      }
    },
    onCreateRoom: async (req): Promise<CreateRoomApiResult> => {
      roomsCreated += 1
      const roomId = `room-${roomsCreated}`
      return {
        ok: true,
        roomId,
        roomName: req.name,
        chatId: `room:${roomId}`,
        members: req.memberIds,
      }
    },
    onCreateDm: async (req): Promise<CreateDmApiResult> => {
      dmCreated += 1
      const ensured = ensureHumanDm(req.agentId)
      return {
        ok: true,
        chatId: ensured.chatId,
        agentId: req.agentId,
        created: ensured.created,
        peers: [...ensured.peers],
      }
    },
    getSettings: () => readObserveSettings(),
  })

  // Listen on ephemeral port
  await new Promise<void>((resolve, reject) => {
    srv.server.once('error', reject)
    srv.server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = srv.server.address()
  assert.ok(addr && typeof addr === 'object')
  const port = addr.port
  const base = `http://127.0.0.1:${port}`
  console.log(`✓ listen ${base}`)

  const health = await jsonFetch(base, '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  assert.equal(health.body.mode, 'live')
  console.log('✓ GET /api/health')

  const setRes = await jsonFetch(base, '/api/settings')
  assert.equal(setRes.status, 200)
  assert.equal(setRes.body.ok, true)
  assert.ok(!JSON.stringify(setRes.body).match(/sk-[A-Za-z0-9]/i))
  assert.equal(setRes.body.AGNES_API_KEY, undefined)
  assert.equal(setRes.body.GLM_API_KEY, undefined)
  console.log('✓ GET /api/settings (no keys)')

  const badRoom = await jsonFetch(base, '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', memberIds: [] }),
  })
  assert.equal(badRoom.status, 400)
  console.log('✓ POST /api/rooms rejects empty')

  const room = await jsonFetch(base, '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'api-smoke-room', memberIds: ['alice', 'bob'] }),
  })
  assert.equal(room.status, 200)
  assert.equal(room.body.ok, true)
  assert.equal(room.body.roomName, 'api-smoke-room')
  assert.ok(String(room.body.chatId).startsWith('room:'))
  assert.deepEqual(room.body.members, ['alice', 'bob'])
  assert.equal(roomsCreated, 1)
  console.log(`✓ POST /api/rooms → ${room.body.chatId}`)

  const dm = await jsonFetch(base, '/api/dm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'alice' }),
  })
  assert.equal(dm.status, 200)
  assert.equal(dm.body.ok, true)
  assert.ok(String(dm.body.chatId).includes('alice'))
  assert.ok(String(dm.body.chatId).startsWith('dm:'))
  assert.equal(dmCreated, 1)
  console.log(`✓ POST /api/dm → ${dm.body.chatId}`)

  const dm2 = await jsonFetch(base, '/api/dm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'alice' }),
  })
  assert.equal(dm2.status, 200)
  assert.equal(dm2.body.created, false)
  assert.equal(dm2.body.chatId, dm.body.chatId)
  console.log('✓ POST /api/dm idempotent')

  const threads = listDmThreads()
  assert.ok(threads.some((t) => t.pair.includes('alice')))
  console.log(`✓ dm-threads.json has ${threads.length} thread(s)`)

  // Observe state should surface the ensured DM (even without messages)
  const snap = readObserveState()
  assert.ok(
    snap.chats.some((c) => c.id === dm.body.chatId && c.kind === 'dm'),
    'observe state should list ensured DM chat',
  )
  console.log('✓ observe state lists DM chat')

  const say = await jsonFetch(base, '/api/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: room.body.chatId, text: 'hello api-smoke', as: 'human' }),
  })
  assert.equal(say.status, 200)
  assert.equal(say.body.ok, true)
  console.log('✓ POST /api/say')

  // Forbidden paths
  const envLeak = await new Promise<{ status: number }>((resolve, reject) => {
    http
      .get(`${base}/.env`, (res) => {
        res.resume()
        resolve({ status: res.statusCode || 0 })
      })
      .on('error', reject)
  })
  assert.ok(envLeak.status === 403 || envLeak.status === 404)
  console.log('✓ /.env blocked')

  await srv.close()
  console.log('=== API-SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== API-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
