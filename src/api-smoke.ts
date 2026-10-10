/**
 * Cheap API smoke: mock live observe server — rooms / dm / agents / settings / say guard.
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
  type SpawnAgentApiResult,
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
    assert.ok(p.id === 'agnes' || p.id === 'glm' || p.id === 'siliconflow')
    assert.equal(typeof p.configured, 'boolean')
    // Must never leak key material in settings object
    assert.equal((p as any).apiKey, undefined)
  }
  assert.ok(settings.envNote.includes('.env'))
  assert.equal(typeof settings.humanDisplayName, 'string')
  assert.ok(settings.humanDisplayName.length >= 1)
  console.log(
    `✓ settings caps parallel=${settings.maxParallelReplies} exchanges=${settings.maxExchanges} providers=${settings.providers
      .filter((p) => p.configured)
      .map((p) => p.id)
      .join(',') || 'none'}`,
  )

  let roomsCreated = 0
  let dmCreated = 0
  let agentsSpawned = 0
  const spawnedIds = new Set<string>()

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
    onSpawnAgent: async (req): Promise<SpawnAgentApiResult> => {
      const displayName = req.displayName
      const persona = req.persona
      let id = (req.id || displayName.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'agentx').slice(0, 32)
      if (!/^[a-z]/.test(id)) id = `a${id}`
      if (spawnedIds.has(id) || id === 'alice' || id === 'bob') {
        throw new Error(`agent already exists: ${id}`)
      }
      const max = readObserveSettings().maxAgents
      if (agentsSpawned + 2 >= max && max <= 2) {
        throw new Error(`max agents (${max}) reached; set SOCIETY_MAX_AGENTS to raise`)
      }
      agentsSpawned += 1
      spawnedIds.add(id)
      const explicit =
        (req.llm && req.llm.provider) || req.provider
          ? String((req.llm && req.llm.provider) || req.provider).trim().toLowerCase()
          : ''
      if (explicit && !['agnes', 'glm', 'siliconflow'].includes(explicit)) {
        throw new Error(`Unknown or paid provider "${explicit}": use agnes | glm | siliconflow`)
      }
      const providerCycle = (['agnes', 'glm', 'siliconflow'] as const)[(agentsSpawned - 1) % 3]!
      const provider = (explicit || providerCycle) as 'agnes' | 'glm' | 'siliconflow'
      const modelExplicit = (req.llm && req.llm.model) || req.model
      const model =
        modelExplicit && String(modelExplicit).trim()
          ? String(modelExplicit).trim()
          : provider === 'glm'
            ? 'glm-4-flash'
            : provider === 'siliconflow'
              ? 'XingChenAGI/Xing4.0-29B'
              : 'agnes-3.0-flash'
      if (provider === 'agnes' && !/^agnes-[23]\.5-flash$/i.test(model) && !/^agnes-3\.0-flash$/i.test(model) && !/^agnes-2\.5-flash$/i.test(model)) {
        // keep mock permissive for free flash names already set above
      }
      return {
        ok: true,
        agent: {
          id,
          displayName,
          persona,
          soul: {
            openness: 0.5,
            trust: 0.5,
            energy: 0.5,
            interests: Array.isArray(req.interests) ? req.interests : [],
            mood: req.mood || '平静',
          },
          workspacePath: `/tmp/${id}`,
          createdAt: new Date().toISOString(),
        },
        llm: { provider, model },
        chatIds: { self: `self:${id}`, plaza: 'room:plaza-mock' },
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
  assert.equal(typeof setRes.body.humanDisplayName, 'string')
  assert.ok(setRes.body.humanDisplayName.length >= 1)

  const patchName = await jsonFetch(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ humanDisplayName: 'OC测试' }),
  })
  assert.equal(patchName.status, 200)
  assert.equal(patchName.body.ok, true)
  assert.equal(patchName.body.humanDisplayName, 'OC测试')
  const setRes2 = await jsonFetch(base, '/api/settings')
  assert.equal(setRes2.body.humanDisplayName, 'OC测试')
  const patchBack = await jsonFetch(base, '/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ humanDisplayName: '用户' }),
  })
  assert.equal(patchBack.status, 200)
  assert.equal(patchBack.body.humanDisplayName, '用户')
  console.log('✓ PATCH /api/settings humanDisplayName')


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


  // Spawn agent
  const badBirth = await jsonFetch(base, '/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: '', persona: '' }),
  })
  assert.equal(badBirth.status, 400)
  console.log('✓ POST /api/agents rejects empty')

  const birth = await jsonFetch(base, '/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Dana',
      persona: '冷静的运维，喜欢日志与配额。',
      interests: '运维, 日志',
      mood: '专注',
      id: 'dana-api',
    }),
  })
  assert.equal(birth.status, 200, JSON.stringify(birth.body))
  assert.equal(birth.body.ok, true)
  assert.equal(birth.body.agent.id, 'dana-api')
  assert.equal(birth.body.agent.displayName, 'Dana')
  assert.ok(birth.body.llm?.provider)
  assert.equal(birth.body.chatIds.self, 'self:dana-api')
  assert.equal(agentsSpawned, 1)
  assert.ok(!JSON.stringify(birth.body).match(/sk-[A-Za-z0-9]|api[_-]?key/i))
  console.log(`✓ POST /api/agents → ${birth.body.agent.id} llm=${birth.body.llm.provider}`)

  const dupBirth = await jsonFetch(base, '/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Dana2',
      persona: 'dup',
      id: 'dana-api',
    }),
  })
  assert.equal(dupBirth.status, 409)
  console.log('✓ POST /api/agents duplicate → 409')

  const explicitBirth = await jsonFetch(base, '/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Erin',
      persona: '指定硅基流动通道的测试角色。',
      id: 'erin-sf',
      llm: { provider: 'siliconflow', model: 'XingChenAGI/Xing4.0-29B' },
    }),
  })
  assert.equal(explicitBirth.status, 200, JSON.stringify(explicitBirth.body))
  assert.equal(explicitBirth.body.llm.provider, 'siliconflow')
  assert.equal(explicitBirth.body.llm.model, 'XingChenAGI/Xing4.0-29B')
  console.log('✓ POST /api/agents explicit llm=siliconflow')

  const flatBirth = await jsonFetch(base, '/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Finn',
      persona: 'flat provider 字段。',
      id: 'finn-glm',
      provider: 'glm',
      model: 'glm-4-flash',
    }),
  })
  assert.equal(flatBirth.status, 200, JSON.stringify(flatBirth.body))
  assert.equal(flatBirth.body.llm.provider, 'glm')
  assert.equal(flatBirth.body.llm.model, 'glm-4-flash')
  console.log('✓ POST /api/agents flat provider=glm')

  const badProv = await jsonFetch(base, '/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Bad',
      persona: 'paid',
      id: 'bad-paid',
      provider: 'openai',
    }),
  })
  assert.equal(badProv.status, 400)
  console.log('✓ POST /api/agents rejects unknown provider')

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
