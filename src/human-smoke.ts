/**
 * Human insert smoke: post as human, run a few ticks, assert an agent replied.
 * Never prints AGNES_API_KEY. Free Agnes flash only.
 */
import assert from 'node:assert/strict'
import { loadDotEnv, requireAgnesConfig, providerModelLabel } from './env.ts'
import { bootSociety } from './boot.ts'
import { HUMAN_SPEAKER_ID } from './types.ts'

async function main() {
  console.log('=== society-chat human-smoke ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes: ${providerModelLabel(cfg)} key=set`)
  console.log(`✓ routes will resolve per-agent (alice→agnes, bob→glm)`)

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  const human = ctx.societyIdentity.registerHuman()
  assert.equal(human.id, HUMAN_SPEAKER_ID)
  assert.equal(human.displayName, '你')
  assert.equal(
    ctx.societyIdentity.list().some((a) => a.id === HUMAN_SPEAKER_ID),
    false,
    'human must not appear in agent list / pickAgent',
  )
  console.log('✓ registerHuman (not in agent list)')

  ctx.societyScheduler.configure({
    maxExchanges: 4,
    onlyAgents: ['alice', 'bob'],
    cooldownMs: 50,
    agentCooldownMs: 0,
    idleStaleMs: 60_000, // discourage idle; we want reply-to-human
    dailyLlmBudget: 40,
  })

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
  ctx.societyScheduler.setDefaultRoom(room.id)

  const before = ctx.societyRooms.historyOf(room.id).length
  const marker = `人间来信-${Date.now().toString(36)}`
  const humanText = `大家好，我是人类观察者。请用一两句中文打个招呼，并提到口令「${marker}」。`
  const posted = ctx.societyRooms.post({
    roomId: room.id,
    from: HUMAN_SPEAKER_ID,
    body: humanText,
  })
  assert.equal(posted.from, HUMAN_SPEAKER_ID)
  assert.ok(ctx.societyRooms.historyOf(room.id).length === before + 1)
  console.log(`[you] ${humanText}`)

  // Mailboxes should wake members
  const bobUnread = ctx.societyMailbox.list('bob', { unreadOnly: true })
  const aliceUnread = ctx.societyMailbox.list('alice', { unreadOnly: true })
  assert.ok(
    bobUnread.some((m) => m.roomId === room!.id) || aliceUnread.some((m) => m.roomId === room!.id),
    'expected at least one agent wake from human post',
  )
  console.log(`✓ wakes: aliceUnread=${aliceUnread.length} bobUnread=${bobUnread.length}`)

  const replies: { agentId: string; body: string }[] = []
  ctx.on('society/agent-replied', (p) => {
    if (p.kind === 'room' && p.body) {
      replies.push({ agentId: p.agentId, body: p.body })
      const name = p.agentId === 'alice' ? 'Alice' : p.agentId === 'bob' ? 'Bob' : p.agentId
      console.log(`[live] ${name}: ${p.body}`)
    }
  })

  let replied = false
  for (let i = 0; i < 8; i++) {
    const result = await ctx.societyScheduler.runTick()
    console.log(
      `[tick ${result.tick}] action=${result.action}` +
        (result.agentId ? ` agent=${result.agentId}` : '') +
        ` exchanges=${result.exchanges}`,
    )
    if (result.action === 'reply' || replies.length > 0) {
      replied = true
      // Allow one more tick in case we want a second voice — not required
      if (replies.length >= 1) break
    }
    if (result.action === 'capped') break
    await new Promise((r) => setTimeout(r, 200))
  }

  const history = ctx.societyRooms.historyOf(room.id)
  const afterHuman = history.slice(history.findIndex((m) => m.id === posted.id) + 1)
  const agentReply = afterHuman.find((m) => m.from === 'alice' || m.from === 'bob')

  assert.ok(replied || agentReply, 'expected an agent to reply after human message')
  assert.ok(agentReply, 'expected room history to contain agent reply after human')
  console.log('--- transcript (tail) ---')
  for (const m of history.slice(-6)) {
    const name =
      m.from === 'human' ? '你' : m.from === 'alice' ? 'Alice' : m.from === 'bob' ? 'Bob' : m.from
    console.log(`${name}: ${m.body}`)
  }
  console.log('-------------------------')
  console.log(
    `✓ human→agent: ${agentReply!.from} replied (${agentReply!.body.slice(0, 80)}${agentReply!.body.length > 80 ? '…' : ''})`,
  )

  await app.dispose()
  console.log('=== HUMAN-SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== HUMAN-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
