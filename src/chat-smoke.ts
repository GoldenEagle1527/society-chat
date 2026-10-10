/**
 * Chat smoke (requires Agnes free model via .env):
 * 1. Load .env (AGNES_*)
 * 2. Boot society + enable auto-reply (max 1 exchange → Bob only)
 * 3. Alice posts Chinese hello in plaza
 * 4. Bob wakes → Agnes free flash (default 3.0) replies → posts back to room
 * 5. Print both lines; exit 0
 *
 * Depth limits: maxExchanges=1, onlyAgents=['bob'] — Alice must not ping-pong.
 */
import assert from 'node:assert/strict'
import { loadDotEnv, requireAgnesConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'

async function main() {
  console.log('=== society-chat chat-smoke (Agnes) ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes config: base=${cfg.baseUrl} model=${cfg.model} key=set`)

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  const alice = ctx.societyIdentity.require('alice')
  const bob = ctx.societyIdentity.require('bob')
  console.log(`✓ agents: ${alice.displayName}, ${bob.displayName}`)

  // Only Bob auto-replies once — Alice's subsequent wake must not LLM-ping-pong
  ctx.societyScheduler.enableAutoReply({ maxExchanges: 1, onlyAgents: ['bob'] })

  const replied: string[] = []
  ctx.on('society/agent-replied', (p) => {
    if (p.agentId === 'bob') replied.push(p.body)
  })

  const room = ctx.societyRooms.create({
    name: 'plaza',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  })
  console.log(`✓ room: ${room.name}`)

  const hello = '嗨 Bob，欢迎来到社会广场！今天感觉怎么样？'
  const posted = ctx.societyRooms.post({
    roomId: room.id,
    from: 'alice',
    body: hello,
  })
  console.log(`Alice: ${posted.body}`)

  await ctx.societyScheduler.drain(90_000)

  assert.ok(replied.length >= 1, 'Bob did not produce an LLM reply')
  const bobLine = replied[0]!
  console.log(`Bob: ${bobLine}`)

  const history = ctx.societyRooms.historyOf(room.id)
  assert.ok(history.length >= 2, `expected >=2 room messages, got ${history.length}`)
  assert.equal(history[0]!.from, 'alice')
  const bobMsgs = history.filter((m) => m.from === 'bob')
  assert.ok(bobMsgs.length >= 1, 'Bob did not post to room')
  assert.ok(bobMsgs.some((m) => m.body === bobLine) || bobMsgs[0]!.body.length > 0)
  assert.ok(bobLine.length > 0 || bobMsgs[0]!.body.length > 0)

  // Alice may have been woken by Bob's post, but must not auto-reply (onlyAgents + maxExchanges)
  assert.equal(ctx.societyScheduler.exchangeCountOf(), 1)

  await app.dispose()
  console.log('=== CHAT-SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== CHAT-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
