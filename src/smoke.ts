/**
 * Smoke test (no LLM required):
 * 1. Boot society plugins
 * 2. Ensure Alice & Bob exist with workspaces
 * 3. Create a room, both join
 * 4. Alice posts → Bob's mailbox receives a room fan-out
 * 5. Assert wake event for Bob
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { bootSociety } from './boot.ts'
import type { InboxMessage } from './types.ts'

async function main() {
  console.log('=== society-chat smoke test ===')
  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  const alice = ctx.societyIdentity.require('alice')
  const bob = ctx.societyIdentity.require('bob')
  assert.ok(fs.existsSync(alice.workspacePath), 'alice workspace missing')
  assert.ok(fs.existsSync(bob.workspacePath), 'bob workspace missing')
  console.log(`✓ agents registered: ${alice.displayName}, ${bob.displayName}`)

  const wakes: InboxMessage[] = []
  ctx.on('society/agent-wake', (p) => {
    if (p.agentId === 'bob') wakes.push(p.message)
  })

  const room = ctx.societyRooms.create({
    name: 'plaza',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  })
  console.log(`✓ room created: ${room.name} (${room.id.slice(0, 8)}…) members=${room.members.join(',')}`)

  assert.deepEqual(new Set(ctx.societyRooms.listMembers(room.id)), new Set(['alice', 'bob']))

  const posted = ctx.societyRooms.post({
    roomId: room.id,
    from: 'alice',
    body: '嗨 Bob，欢迎来到社会广场！',
  })
  console.log(`✓ alice posted: ${posted.body}`)

  // settle event handlers
  await new Promise((r) => setTimeout(r, 30))

  const bobInbox = ctx.societyMailbox.list('bob')
  assert.ok(bobInbox.length >= 1, 'bob inbox empty')
  const last = bobInbox[bobInbox.length - 1]!
  assert.equal(last.kind, 'room')
  assert.equal(last.roomId, room.id)
  assert.match(last.body, /Alice|alice|嗨 Bob/)
  console.log(`✓ bob inbox received: ${last.body}`)

  assert.ok(wakes.length >= 1, 'bob was not woken')
  console.log(`✓ bob wake events: ${wakes.length}`)

  // Alice should not receive her own room post
  const aliceRoomMail = ctx.societyMailbox.list('alice').filter((m) => m.kind === 'room' && m.roomId === room.id)
  assert.equal(aliceRoomMail.length, 0, 'alice should not get her own room fan-out')
  console.log('✓ alice did not self-receive')

  // Direct mail path
  ctx.societyMailbox.deliver({
    to: 'alice',
    from: 'bob',
    kind: 'direct',
    body: '收到，Alice。我的工作区已就绪。',
  })
  const aliceDirect = ctx.societyMailbox.list('alice', { unreadOnly: true })
  assert.ok(aliceDirect.some((m) => m.kind === 'direct' && m.from === 'bob'))
  console.log('✓ bob → alice direct mail ok')

  // Scheduler stub records wakes
  const recent = ctx.societyScheduler.recentWakes()
  assert.ok(recent.some((w) => w.agentId === 'bob'))
  console.log(`✓ scheduler recorded ${recent.length} wake(s)`)

  const history = ctx.societyRooms.historyOf(room.id)
  assert.equal(history.length, 1)
  console.log(`✓ room history length=${history.length}`)

  await app.dispose()
  console.log('=== SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== SMOKE FAIL ===')
  console.error(e)
  process.exit(1)
})
