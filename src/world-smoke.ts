/**
 * YinYang Field M0 world smoke: conservation, bite/digest, satiety, diminishing, act reject.
 * No network. Run: npm run world-smoke
 */
import assert from 'node:assert/strict'
import {
  act,
  biteCostForStreak,
  biteYieldForStreak,
  conservationOk,
  createSeedWorld,
  observe,
  SATIETY_THRESHOLD,
  stepPhysics,
  totalEnergy,
} from './world/index.ts'

/** Move energy between ledger buckets without minting/destroying. */
function transferPool(bot: { energy_pool: number }, state: { waste_heat: number }, targetPool: number): void {
  const delta = Math.round((targetPool - bot.energy_pool) * 1000) / 1000
  if (delta === 0) return
  bot.energy_pool = Math.round((bot.energy_pool + delta) * 1000) / 1000
  state.waste_heat = Math.round((state.waste_heat - delta) * 1000) / 1000
}

function main(): void {
  console.log('=== world-smoke ===')
  const state = createSeedWorld(['agnes', 'glm', 'human'])
  const base = totalEnergy(state)
  console.log(`seed baseline=${base} tick=${state.tick} bots=${state.bots.length}`)
  assert.ok(conservationOk(state), 'seed conservation')

  for (let i = 0; i < 5; i++) stepPhysics(state)
  assert.ok(conservationOk(state, 0.2), `after physics Σ=${totalEnergy(state)} base=${base}`)
  console.log(`✓ physics×5 conservation Σ=${totalEnergy(state)}`)

  const bot = state.bots.find((b) => b.actorId === 'agnes')!
  const fruit = state.organics.find((o) => o.kind === 'fruit')!
  bot.pos = { x: fruit.pos.x + fruit.radius, y: fruit.pos.y }
  // Drop below satiety so fruit bite is allowed (conserved into waste_heat)
  transferPool(bot, state, SATIETY_THRESHOLD - 2)
  const beforeFruit = fruit.energy_locked
  const beforePool = bot.energy_pool
  assert.ok(bot.energy_pool < SATIETY_THRESHOLD, 'precondition: hungry enough to bite fruit')

  const snap = observe(state, 'agnes')
  assert.equal(snap.self.id, 'agnes')
  assert.equal(snap.self.satiety_threshold, SATIETY_THRESHOLD)
  assert.ok(snap.organics.some((o) => o.kind === 'fruit'))
  console.log(`✓ observe particles=${snap.view.particles.length} organics=${snap.organics.length}`)

  const receipt = act(state, {
    actor_id: 'agnes',
    budget_energy: 20,
    actions: [{ op: 'bite', target_id: fruit.id }, { op: 'digest' }],
  })
  console.log(`act accepted=${receipt.accepted} rejected=${JSON.stringify(receipt.rejected)} spent=${receipt.energy_spent}`)
  assert.ok(receipt.accepted.includes(0), 'bite accepted')
  assert.ok(fruit.energy_locked < beforeFruit || !state.organics.find((o) => o.id === fruit.id), 'fruit decreased')
  assert.ok(conservationOk(state, 0.25), `after bite/digest Σ=${totalEnergy(state)}`)
  console.log(`✓ bite/digest pool ${beforePool}→${bot.energy_pool} stomach=${bot.stomach}`)

  // --- REFUSED_SATIATED ---
  if (bot.energy_pool < SATIETY_THRESHOLD) {
    transferPool(bot, state, SATIETY_THRESHOLD + 1)
  }
  assert.ok(bot.energy_pool >= SATIETY_THRESHOLD, 'precondition: satiated')
  bot.pos = { x: fruit.pos.x + fruit.radius, y: fruit.pos.y }
  const satiated = act(state, {
    actor_id: 'agnes',
    budget_energy: 20,
    actions: [{ op: 'bite', target_id: fruit.id }],
  })
  assert.ok(
    satiated.rejected.some((r) => r.code === 'REFUSED_SATIATED'),
    `expected REFUSED_SATIATED, got ${JSON.stringify(satiated.rejected)}`,
  )
  assert.ok(!satiated.accepted.includes(0), 'satiated bite not accepted')
  console.log(`✓ REFUSED_SATIATED pool=${bot.energy_pool} threshold=${SATIETY_THRESHOLD}`)

  // --- Diminishing returns ---
  // Move stomach back to waste so only bite yields are measured; keep conservation
  if (bot.stomach > 0) {
    state.waste_heat = Math.round((state.waste_heat + bot.stomach) * 1000) / 1000
    bot.stomach = 0
  }
  transferPool(bot, state, 9) // below satiety, enough for 2–3 escalating bites
  bot.biteStreak = 0
  delete bot.biteStreakTargetId
  bot.pos = { x: fruit.pos.x + fruit.radius, y: fruit.pos.y }
  const eventsBefore = state.events.length
  const dim = act(state, {
    actor_id: 'agnes',
    budget_energy: 40,
    actions: [
      { op: 'bite', target_id: fruit.id },
      { op: 'bite', target_id: fruit.id },
      { op: 'bite', target_id: fruit.id },
    ],
  })
  assert.ok(dim.accepted.length >= 2, `expected multiple bites accepted, got ${JSON.stringify(dim)}`)
  const dimBites = state.events
    .slice(eventsBefore)
    .filter((e) => e.type === 'bite' && e.payload.actor === 'agnes')
  assert.ok(dimBites.length >= 2, 'need diminishing bite events')
  for (let i = 1; i < dimBites.length; i++) {
    const prev = dimBites[i - 1]!.payload
    const cur = dimBites[i]!.payload
    assert.ok(Number(cur.cost) > Number(prev.cost), `cost should rise: ${prev.cost} → ${cur.cost}`)
    assert.ok(Number(cur.chunk) < Number(prev.chunk), `yield should fall: ${prev.chunk} → ${cur.chunk}`)
  }
  assert.equal(biteCostForStreak(0), 2)
  assert.ok(biteCostForStreak(2) > biteCostForStreak(0))
  assert.ok(biteYieldForStreak(2) < biteYieldForStreak(0))
  assert.ok(conservationOk(state, 0.35), `after diminishing bites Σ=${totalEnergy(state)}`)
  console.log(
    `✓ diminishing costs=${dimBites.map((e) => e.payload.cost).join(',')} yields=${dimBites.map((e) => e.payload.chunk).join(',')}`,
  )

  // Other op resets streak (wait — always legal if pool covers 0.2)
  transferPool(bot, state, Math.max(bot.energy_pool, 1))
  bot.biteStreak = 3
  bot.biteStreakTargetId = fruit.id
  const waited = act(state, {
    actor_id: 'agnes',
    budget_energy: 2,
    actions: [{ op: 'wait' }],
  })
  assert.ok(waited.accepted.includes(0), 'wait accepted')
  assert.equal(bot.biteStreak, 0, 'wait resets bite streak')
  console.log('✓ other op resets bite streak')

  // Reject: nudge missing target
  const bad = act(state, {
    actor_id: 'agnes',
    budget_energy: 5,
    actions: [{ op: 'nudge', target_id: 'no_such_particle', dir: 'e' }],
  })
  assert.ok(bad.rejected.some((r) => r.code === 'TARGET_GONE' || r.code === 'NOT_ADJACENT' || r.code === 'ILLEGAL_OP'))
  console.log(`✓ reject ${bad.rejected[0]?.code}: ${bad.rejected[0]?.msg}`)

  // Budget exceeded
  transferPool(bot, state, 6)
  bot.pos = { x: fruit.pos.x + fruit.radius, y: fruit.pos.y }
  const broke = act(state, {
    actor_id: 'agnes',
    budget_energy: 0.1,
    actions: [{ op: 'bite', target_id: fruit.id }],
  })
  assert.ok(broke.rejected.some((r) => r.code === 'BUDGET_EXCEEDED'))
  console.log(`✓ BUDGET_EXCEEDED`)

  // Starve path
  const victim = state.bots.find((b) => b.actorId === 'glm')!
  state.waste_heat = Math.round((state.waste_heat + victim.energy_pool + victim.stomach) * 1000) / 1000
  victim.energy_pool = 0
  victim.stomach = 0
  for (let i = 0; i < 12; i++) stepPhysics(state)
  assert.equal(victim.alive, false)
  assert.ok(state.organics.some((o) => o.kind === 'corpse' && o.corpseOf === 'glm'))
  assert.ok(conservationOk(state, 0.35), `after starve Σ=${totalEnergy(state)} base=${state.conservation_baseline}`)
  console.log(`✓ starve→corpse conservation Σ=${totalEnergy(state)}`)

  console.log('=== WORLD-SMOKE OK ===')
}

main()
