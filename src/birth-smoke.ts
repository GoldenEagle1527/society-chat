/**
 * Birth smoke: Alice spawns Carol (curious artist), invites to plaza or new room,
 * one greeting exchange. Asserts Carol on disk.
 * Never prints AGNES_API_KEY. Free Agnes flash only.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, requireAgnesConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'
import { agentDataDir, agentWorkspaceDir } from './paths.ts'

async function wipeCarol(): Promise<void> {
  const dir = agentDataDir('carol')
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('=== society-chat birth-smoke ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes config: base=${cfg.baseUrl} model=${cfg.model} key=set`)

  await wipeCarol()

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  assert.ok(ctx.societyIdentity.get('alice'), 'alice seed required')
  assert.ok(ctx.societyIdentity.get('bob'), 'bob seed required')
  assert.equal(ctx.societyIdentity.get('carol'), undefined, 'carol must not exist yet')

  const tools = ctx.societyTools.getToolDefinitions().map((t) => t.function.name)
  assert.ok(tools.includes('spawn_agent'), `spawn_agent missing from schemas: ${tools.join(',')}`)
  console.log('✓ spawn_agent in actAsAgent tool schemas')

  const born = await ctx.societyTools.execute(
    'alice',
    'spawn_agent',
    JSON.stringify({
      id: 'carol',
      displayName: 'Carol',
      persona: '好奇的艺术家，喜欢色彩、构图与轻松闲聊，愿意交新朋友。',
      openness: 0.85,
      trust: 0.55,
      energy: 0.75,
      interests: ['绘画', '色彩', '聊天'],
      mood: '好奇',
    }),
  )
  assert.ok(!born.startsWith('Error:'), born)
  const bornObj = JSON.parse(born) as {
    id: string
    displayName: string
    workspacePath: string
  }
  assert.equal(bornObj.id, 'carol')
  assert.equal(bornObj.displayName, 'Carol')
  console.log(`✓ Alice spawn_agent → Carol workspace=${bornObj.workspacePath}`)

  const carolProfilePath = path.join(agentDataDir('carol'), 'profile.json')
  const carolSoulPath = path.join(agentDataDir('carol'), 'soul.json')
  const carolMemPath = path.join(agentDataDir('carol'), 'memory.json')
  const carolWs = agentWorkspaceDir('carol')
  assert.ok(fs.existsSync(carolProfilePath), 'carol profile.json missing')
  assert.ok(fs.existsSync(carolSoulPath), 'carol soul.json missing')
  assert.ok(fs.existsSync(carolMemPath), 'carol memory.json missing')
  assert.ok(fs.existsSync(carolWs), 'carol workspace missing')
  const profile = JSON.parse(fs.readFileSync(carolProfilePath, 'utf8')) as {
    displayName: string
    persona: string
  }
  assert.equal(profile.displayName, 'Carol')
  assert.match(profile.persona, /艺术/)
  console.log('✓ Carol on disk: profile + soul + memory + workspace')

  // Cap check: spawn duplicate should fail
  const dup = await ctx.societyTools.execute(
    'alice',
    'spawn_agent',
    JSON.stringify({
      id: 'carol',
      displayName: 'Carol2',
      persona: 'dup',
    }),
  )
  assert.ok(dup.startsWith('Error:'), `expected duplicate error, got ${dup}`)
  console.log('✓ duplicate spawn rejected')

  // Room: reuse plaza or create
  let room = ctx.societyRooms.listRooms().find((r) => r.name === 'plaza')
  if (!room) {
    room = ctx.societyRooms.create({
      name: 'plaza',
      createdBy: 'alice',
      members: ['alice', 'bob'],
    })
  } else {
    ctx.societyRooms.join(room.id, 'alice')
    ctx.societyRooms.join(room.id, 'bob')
  }
  const invite = await ctx.societyTools.execute(
    'alice',
    'invite_to_room',
    JSON.stringify({ roomId: room.id, agentId: 'carol' }),
  )
  assert.ok(!invite.startsWith('Error:'), invite)
  const members = ctx.societyRooms.require(room.id).members
  assert.ok(members.includes('carol'), `carol not in room: ${members.join(',')}`)
  console.log(`✓ Carol invited to ${room.name} (${room.id.slice(0, 8)}…)`)

  // One greeting exchange: only Carol auto-replies
  ctx.societyScheduler.enableAutoReply({
    maxExchanges: 1,
    onlyAgents: ['carol'],
  })

  const greet = 'Carol，欢迎加入社会广场！我是 Alice。用一句话中文打个招呼吧。'
  ctx.societyRooms.post({
    roomId: room.id,
    from: 'alice',
    body: greet,
  })
  console.log(`Alice (${room.name}): ${greet}`)

  await ctx.societyScheduler.drain(180_000)

  const history = ctx.societyRooms.historyOf(room.id)
  const carolMsg = [...history].reverse().find((m) => m.from === 'carol')
  assert.ok(carolMsg, `expected Carol reply in history, got ${history.length} msgs`)
  console.log(`Carol (${room.name}): ${carolMsg!.body}`)

  // Cap tool visibility in list_agents
  const agentsJson = await ctx.societyTools.execute('alice', 'list_agents', '{}')
  assert.ok(agentsJson.includes('carol'), agentsJson)

  await app.dispose()
  console.log('=== BIRTH-SMOKE PASS ===')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
