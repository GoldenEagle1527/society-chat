/**
 * Social tools smoke (uses Agnes free flash via .env for Bob's wake reply):
 * 1. Alice create_room "lab"
 * 2. Alice invite_to_room Bob
 * 3. Alice post_room
 * 4. Bob auto-replies via wake
 * 5. Assert room exists + history
 *
 * Never prints AGNES_API_KEY.
 */
import assert from 'node:assert/strict'
import { loadDotEnv, requireAgnesConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'

async function main() {
  console.log('=== society-chat social-smoke ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes config: base=${cfg.baseUrl} model=${cfg.model} key=set`)

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  // Alice creates room via tool
  const created = await ctx.societyTools.execute(
    'alice',
    'create_room',
    JSON.stringify({ name: 'lab' }),
  )
  assert.ok(!created.startsWith('Error:'), created)
  const createdObj = JSON.parse(created) as { roomId: string; name: string; members: string[] }
  assert.equal(createdObj.name, 'lab')
  assert.ok(createdObj.members.includes('alice'))
  const roomId = createdObj.roomId
  console.log(`✓ Alice create_room lab → ${roomId}`)

  // Invite Bob
  const invited = await ctx.societyTools.execute(
    'alice',
    'invite_to_room',
    JSON.stringify({ roomId, agentId: 'bob' }),
  )
  assert.ok(!invited.startsWith('Error:'), invited)
  const invitedObj = JSON.parse(invited) as { members: string[] }
  assert.ok(invitedObj.members.includes('bob'), `bob not in members: ${invited}`)
  console.log(`✓ Alice invited Bob → members=${invitedObj.members.join(',')}`)

  // list_rooms / list_agents sanity
  const roomsJson = await ctx.societyTools.execute('alice', 'list_rooms', '{}')
  assert.ok(roomsJson.includes(roomId), roomsJson)
  const agentsJson = await ctx.societyTools.execute('alice', 'list_agents', '{}')
  assert.ok(agentsJson.includes('alice') && agentsJson.includes('bob'), agentsJson)
  console.log('✓ list_rooms / list_agents')

  // Enable Bob auto-reply before post so wake is handled
  ctx.societyScheduler.enableAutoReply({
    maxExchanges: 1,
    onlyAgents: ['bob'],
  })

  const postBody = 'Bob，欢迎来到 lab。请用一句话中文打个招呼。'
  const posted = await ctx.societyTools.execute(
    'alice',
    'post_room',
    JSON.stringify({ roomId, body: postBody }),
  )
  assert.ok(!posted.startsWith('Error:'), posted)
  console.log(`Alice (lab): ${postBody}`)

  await ctx.societyScheduler.drain(180_000)

  const room = ctx.societyRooms.get(roomId)
  assert.ok(room, 'room must exist')
  assert.equal(room!.name, 'lab')
  assert.ok(room!.members.includes('alice') && room!.members.includes('bob'))

  const history = ctx.societyRooms.historyOf(roomId)
  assert.ok(history.length >= 2, `expected >=2 messages, got ${history.length}`)
  assert.equal(history[0]!.from, 'alice')
  const bobMsg = history.find((m) => m.from === 'bob')
  assert.ok(bobMsg, 'Bob did not reply in lab')
  assert.ok(bobMsg!.body.trim().length > 0)
  console.log(`Bob (lab): ${bobMsg!.body}`)

  // Optional: send_dm tool path (no second LLM required)
  const dm = await ctx.societyTools.execute(
    'alice',
    'send_dm',
    JSON.stringify({ to: 'bob', body: 'lab 侧边私信测试' }),
  )
  assert.ok(!dm.startsWith('Error:'), dm)
  const bobInbox = ctx.societyMailbox.list('bob')
  assert.ok(
    bobInbox.some((m) => m.kind === 'direct' && m.from === 'alice' && m.body.includes('侧边私信')),
    'DM not in bob inbox',
  )
  console.log('✓ send_dm delivered to Bob inbox')

  await app.dispose()
  console.log(`=== SOCIAL-SMOKE PASS (room=${roomId} history=${history.length}) ===`)
}

main().catch((e) => {
  console.error('=== SOCIAL-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
