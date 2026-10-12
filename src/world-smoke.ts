/**
 * YinYang Field M0 world smoke: conservation, bite/digest, act reject.
 * No network. Run: npm run world-smoke
 */
import assert from 'node:assert/strict'
import {
  act,
  conservationOk,
  createSeedWorld,
  observe,
  stepPhysics,
  totalEnergy,
} from './world/index.ts'

function main(): void {
  console.log('=== world-smoke ===')
  const state = createSeedWorld(['agnes', 'glm', 'human'])
  const base = totalEnergy(state)
  console.log(`seed baseline=${base} tick=${state.tick} bots=${state.bots.length}`)
  assert.ok(conservationOk(state), 'seed conservation')

  // Physics steps keep conservation
  for (let i = 0; i < 5; i++) stepPhysics(state)
  assert.ok(conservationOk(state, 0.2), `after physics Σ=${totalEnergy(state)} base=${base}`)
  console.log(`✓ physics×5 conservation Σ=${totalEnergy(state)}`)

  const bot = state.bots.find((b) => b.actorId === 'agnes')!
  const fruit = state.organics.find((o) => o.kind === 'fruit')!
  // Place bot adjacent to fruit
  bot.pos = { x: fruit.pos.x + fruit.radius, y: fruit.pos.y }
  const beforeFruit = fruit.energy_locked
  const beforePool = bot.energy_pool

  const snap = observe(state, 'agnes')
  assert.equal(snap.self.id, 'agnes')
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

  // Reject: nudge missing target
  const bad = act(state, {
    actor_id: 'agnes',
    budget_energy: 5,
    actions: [{ op: 'nudge', target_id: 'no_such_particle', dir: 'e' }],
  })
  assert.ok(bad.rejected.some((r) => r.code === 'TARGET_GONE' || r.code === 'NOT_ADJACENT' || r.code === 'ILLEGAL_OP'))
  console.log(`✓ reject ${bad.rejected[0]?.code}: ${bad.rejected[0]?.msg}`)

  // Budget exceeded (pool already > cost; budget_energy too small)
  const broke = act(state, {
    actor_id: 'agnes',
    budget_energy: 0.1,
    actions: [{ op: 'bite', target_id: fruit.id }],
  })
  assert.ok(broke.rejected.some((r) => r.code === 'BUDGET_EXCEEDED'))
  console.log(`✓ BUDGET_EXCEEDED`)

  // Starve path: empty pool for many ticks (dump remaining pool/stomach into waste — no invented loss)
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
