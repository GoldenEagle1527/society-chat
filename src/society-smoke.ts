/**
 * Multi-turn society smoke (requires Agnes free flash via .env):
 * 1. Load .env (AGNES_*), default model agnes-3.0-flash
 * 2. Boot + enable auto-reply for alice & bob, maxExchanges=SOCIETY_MAX_EXCHANGES||3
 * 3. Alice starts a topic in plaza (manual post, not counted as exchange)
 * 4. Bounded drain: Bob replies → Alice may reply → Bob may reply once more
 * 5. Print transcript + memory/soul file paths and key soul deltas
 *
 * Guards (see society-scheduler):
 * - global exchange counter
 * - onlyAgents: alice, bob
 * - same agent cannot reply twice in a row
 * - cooldown between exchanges
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, requireAgnesConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'
import { agentDataDir } from './paths.ts'

async function main() {
  console.log('=== society-chat society-smoke (multi-turn) ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes config: base=${cfg.baseUrl} model=${cfg.model} key=set`)

  const maxExchanges = (() => {
    const raw = process.env.SOCIETY_MAX_EXCHANGES?.trim()
    if (raw && /^\d+$/.test(raw)) return Math.max(1, parseInt(raw, 10))
    return 3
  })()
  console.log(`✓ maxExchanges=${maxExchanges} onlyAgents=alice,bob`)

  // Fresh-ish soul/memory for readable deltas (keep workspace)
  for (const id of ['alice', 'bob']) {
    const dir = agentDataDir(id)
    for (const f of ['memory.json', 'soul.json', 'soul-log.jsonl']) {
      const p = path.join(dir, f)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
  }

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  const alice = ctx.societyIdentity.require('alice')
  const bob = ctx.societyIdentity.require('bob')
  console.log(`✓ agents: ${alice.displayName}, ${bob.displayName}`)

  // Seed soul files from profile before chat
  const aliceSoul0 = ctx.societySoul.load('alice')
  const bobSoul0 = ctx.societySoul.load('bob')
  console.log(
    `✓ soul seed alice openness=${aliceSoul0.openness} trust=${aliceSoul0.trust} energy=${aliceSoul0.energy}`,
  )
  console.log(
    `✓ soul seed bob openness=${bobSoul0.openness} trust=${bobSoul0.trust} energy=${bobSoul0.energy}`,
  )

  ctx.societyScheduler.enableAutoReply({
    maxExchanges,
    onlyAgents: ['alice', 'bob'],
  })

  const room = ctx.societyRooms.create({
    name: 'plaza',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  })
  console.log(`✓ room: ${room.name}`)

  const topic =
    '嗨 Bob！我想和你聊聊：如果多个 Agent 要长期共处，最值得先做好的安全隔离是什么？'
  ctx.societyRooms.post({
    roomId: room.id,
    from: 'alice',
    body: topic,
  })
  console.log(`Alice (start): ${topic}`)

  await ctx.societyScheduler.drain(180_000)

  const history = ctx.societyRooms.historyOf(room.id)
  console.log('--- transcript ---')
  for (const m of history) {
    const name = m.from === 'alice' ? 'Alice' : m.from === 'bob' ? 'Bob' : m.from
    console.log(`${name}: ${m.body}`)
  }
  console.log('------------------')

  // Manual start + up to maxExchanges auto-replies
  assert.ok(history.length >= 2, `expected at least 2 messages, got ${history.length}`)
  assert.equal(history[0]!.from, 'alice')
  assert.ok(
    history.slice(1).every((m) => m.from === 'alice' || m.from === 'bob'),
    'auto replies should be alice or bob',
  )
  const autoCount = history.length - 1
  assert.ok(autoCount <= maxExchanges, `auto replies ${autoCount} > maxExchanges ${maxExchanges}`)
  assert.equal(ctx.societyScheduler.exchangeCountOf(), autoCount)
  assert.ok(autoCount >= 2, 'expected multi-turn (>=2 auto replies)')

  // Alternation: no consecutive same speaker in auto portion when both can talk
  for (let i = 2; i < history.length; i++) {
    assert.notEqual(
      history[i]!.from,
      history[i - 1]!.from,
      `consecutive same speaker at index ${i} (scheduler should block)`,
    )
  }

  const aliceMemPath = path.join(agentDataDir('alice'), 'memory.json')
  const bobMemPath = path.join(agentDataDir('bob'), 'memory.json')
  const aliceSoulPath = path.join(agentDataDir('alice'), 'soul.json')
  const bobSoulPath = path.join(agentDataDir('bob'), 'soul.json')
  const aliceLogPath = path.join(agentDataDir('alice'), 'soul-log.jsonl')
  const bobLogPath = path.join(agentDataDir('bob'), 'soul-log.jsonl')

  assert.ok(fs.existsSync(aliceMemPath), 'alice memory.json missing')
  assert.ok(fs.existsSync(bobMemPath), 'bob memory.json missing')
  assert.ok(fs.existsSync(aliceSoulPath), 'alice soul.json missing')
  assert.ok(fs.existsSync(bobSoulPath), 'bob soul.json missing')
  assert.ok(fs.existsSync(aliceLogPath), 'alice soul-log.jsonl missing')
  assert.ok(fs.existsSync(bobLogPath), 'bob soul-log.jsonl missing')

  const aliceSoul1 = ctx.societySoul.get('alice')
  const bobSoul1 = ctx.societySoul.get('bob')
  const aliceMem = ctx.societyMemory.load('alice')
  const bobMem = ctx.societyMemory.load('bob')

  console.log('--- memory / soul ---')
  console.log(`alice memory: ${aliceMemPath} working=${aliceMem.working.length} episodic=${aliceMem.episodic.length} semantic=${aliceMem.semantic.length}`)
  console.log(`bob memory:   ${bobMemPath} working=${bobMem.working.length} episodic=${bobMem.episodic.length} semantic=${bobMem.semantic.length}`)
  console.log(
    `alice soul:   ${aliceSoulPath} Δopenness=${(aliceSoul1.openness - aliceSoul0.openness).toFixed(4)} Δtrust=${(aliceSoul1.trust - aliceSoul0.trust).toFixed(4)} Δenergy=${(aliceSoul1.energy - aliceSoul0.energy).toFixed(4)} mood=${aliceSoul1.mood}`,
  )
  console.log(
    `bob soul:     ${bobSoulPath} Δopenness=${(bobSoul1.openness - bobSoul0.openness).toFixed(4)} Δtrust=${(bobSoul1.trust - bobSoul0.trust).toFixed(4)} Δenergy=${(bobSoul1.energy - bobSoul0.energy).toFixed(4)} mood=${bobSoul1.mood}`,
  )
  console.log(`alice soul-log: ${aliceLogPath}`)
  console.log(`bob soul-log:   ${bobLogPath}`)

  assert.ok(aliceMem.working.length >= 1, 'alice working memory empty')
  assert.ok(bobMem.working.length >= 1, 'bob working memory empty')

  await app.dispose()
  console.log(`=== SOCIETY-SMOKE PASS (exchanges=${autoCount}/${maxExchanges}) ===`)
}

main().catch((e) => {
  console.error('=== SOCIETY-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
