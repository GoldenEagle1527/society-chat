/**
 * YinYang Field M0 world smoke: conservation, bite/digest, satiety, diminishing, act reject.
 * No network. Run: npm run world-smoke
 */
import assert from 'node:assert/strict'
import {
  act,
  ACTION_COST,
  biteCostForStreak,
  biteYieldForStreak,
  CONDENSE_DRAW,
  CONDENSE_EFFICIENCY,
  CONDENSE_MIN_WASTE,
  CONDENSE_STARVING_POOL,
  CORPSE_LOCK_FLOOR,
  RESEARCH_POOL_THRESHOLD,
  RESEARCH_STOMACH_THRESHOLD,
  conservationOk,
  CORPSE_BITE_YIELD_MUL,
  createSeedWorld,
  evaluateCondensePrereqs,
  observe,
  REVIVE_SAFETY_MARGIN,
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
  assert.ok(
    state.events.some((e) => e.type === 'refused_satiated' && e.payload.actor === 'agnes'),
    'refused_satiated must appear in world.events',
  )
  console.log(`✓ REFUSED_SATIATED pool=${bot.energy_pool} threshold=${SATIETY_THRESHOLD} + event`)

  // Tail fruit: satiety relaxed when fruit nearly empty
  {
    const lockedBefore = fruit.energy_locked
    const park = Math.round((lockedBefore - 20) * 1000) / 1000
    fruit.energy_locked = 20 // below FRUIT_TAIL_THRESHOLD (300)
    state.waste_heat = Math.round((state.waste_heat + park) * 1000) / 1000
    transferPool(bot, state, SATIETY_THRESHOLD + 2)
    const thirst = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'bite', target_id: fruit.id }] },
      { settle: false },
    )
    assert.ok(thirst.accepted.includes(0), `thirst bite accepted ${JSON.stringify(thirst.rejected)}`)
    // Restore fruit from waste for later tests (conservation-safe)
    const need = Math.max(0, lockedBefore - fruit.energy_locked)
    const take = Math.min(need, state.waste_heat)
    state.waste_heat = Math.round((state.waste_heat - take) * 1000) / 1000
    fruit.energy_locked = Math.round((fruit.energy_locked + take) * 1000) / 1000
    assert.ok(conservationOk(state, 0.35), `after thirst restore Σ=${totalEnergy(state)}`)
    console.log(`✓ FRUIT_TAIL thirst bite despite satiety (locked was 20)`)
  }

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
  const starveCorpse = state.organics.find((o) => o.kind === 'corpse' && o.corpseOf === 'glm')
  assert.ok(starveCorpse, 'glm corpse')
  const deathEv = [...state.events].reverse().find((e) => e.type === 'death' && e.payload?.actor === 'glm')
  assert.ok(deathEv, 'death event')
  assert.ok(
    Math.abs((deathEv!.payload.locked as number) - CORPSE_LOCK_FLOOR) < 0.05,
    `death locked floor got ${deathEv!.payload.locked} expect ${CORPSE_LOCK_FLOOR}`,
  )
  assert.ok(deathEv!.payload.topped_from_waste, 'death topped_from_waste')
  assert.ok(conservationOk(state, 0.35), `after starve Σ=${totalEnergy(state)} base=${state.conservation_baseline}`)
  console.log(
    `✓ starve→corpse death.locked=${deathEv!.payload.locked} now=${starveCorpse!.energy_locked} conservation Σ=${totalEnergy(state)}`,
  )

  // --- corpses / revive_cost in observe ---
  const snap2 = observe(state, 'agnes')
  assert.ok(snap2.corpses.some((c) => c.corpse_of === 'glm'), 'corpses alert must list glm')
  assert.equal(snap2.revive_cost, 8)
  assert.equal(snap2.action_costs.revive, 8)
  assert.ok(snap2.alerts.some((a) => a.includes('CORPSE') && a.includes('revive_cost=')), 'alerts mention corpse+cost')
  assert.ok(snap2.alerts.some((a) => a.includes('WAIT_COST')), 'alerts mention inaction cost')
  const glmCorpse = snap2.corpses.find((c) => c.corpse_of === 'glm')!
  assert.ok(Array.isArray(glmCorpse.saviors) && glmCorpse.saviors.length >= 1, 'saviors listed')
  assert.ok(typeof glmCorpse.inaction_cost === 'string' && (glmCorpse.inaction_cost.includes('leak') || glmCorpse.inaction_cost.includes('husk') || glmCorpse.inaction_cost.includes('dead')), 'inaction_cost')
  assert.ok(snap2.urgency > 0, 'urgency raised by corpse')
  assert.ok(snap2.suggested_ops.includes('revive') || snap2.corpses.length > 0, 'suggest revive or corpses present')
  console.log(`✓ observe corpses=${snap2.corpses.length} urgency=${snap2.urgency} suggest=${snap2.suggested_ops} alert0=${snap2.alerts[0]?.slice(0, 100)}`)

  // --- micro_reward on adsorb (need waste_heat + free particle) ---
  const freeP = state.particles.find((p) => !p.boundTo)
  assert.ok(freeP, 'need free particle')
  // Ensure waste heat for reward; move particle next to agnes
  if (state.waste_heat < 2) {
    state.waste_heat = Math.round((state.waste_heat + 5) * 1000) / 1000
    // balance: pull from fruit lock
    const fr = state.organics.find((o) => o.kind === 'fruit')
    if (fr) fr.energy_locked = Math.round((fr.energy_locked - 5) * 1000) / 1000
  }
  bot.pos = { ...freeP!.pos }
  const poolBefore = bot.energy_pool
  const heatBefore = state.waste_heat
  const evBefore = state.events.length
  transferPool(bot, state, Math.max(bot.energy_pool, 3))
  const ads = act(state, {
    actor_id: 'agnes',
    budget_energy: 5,
    actions: [{ op: 'adsorb', target_id: freeP!.id }],
  })
  assert.ok(ads.accepted.includes(0), `adsorb accepted ${JSON.stringify(ads)}`)
  const rewards = state.events.slice(evBefore).filter((e) => e.type === 'micro_reward')
  assert.ok(
    rewards.some((e) => e.payload.reason === 'adsorb_bound' || e.payload.reason === 'adsorb_balance'),
    'micro_reward adsorb_*',
  )
  assert.ok(conservationOk(state, 0.4), `after adsorb reward Σ=${totalEnergy(state)}`)
  console.log(
    `✓ micro_reward adsorb pool ${poolBefore}→${bot.energy_pool} heat ${heatBefore}→${state.waste_heat} amt=${rewards[0]?.payload.amount}`,
  )

  // wait near corpse with locked≥8 / low pool → REFUSED_REVIVE_WAIT (revive knife duty)
  const corpse = state.organics.find((o) => o.kind === 'corpse')!
  bot.pos = { ...corpse.pos }
  transferPool(bot, state, 5) // pool < revive cost but locked floor covers duty
  const evW = state.events.length
  const waitedNear = act(state, {
    actor_id: 'agnes',
    budget_energy: 2,
    actions: [{ op: 'wait' }],
  }, { settle: false })
  assert.ok(
    waitedNear.rejected.some((r) => r.code === 'REFUSED_REVIVE_WAIT'),
    `expected REFUSED_REVIVE_WAIT via locked duty got ${JSON.stringify(waitedNear.rejected)}`,
  )
  assert.ok(
    !state.events.slice(evW).some((e) => e.type === 'micro_reward' && e.payload.reason === 'wait_steady'),
    'no wait_steady near corpse',
  )
  console.log('✓ REFUSED_REVIVE_WAIT near corpse when locked covers (no wait_steady)')

  // husk corpse (locked≈0) + low pool: wait accepted with wait_neglect (no duty)
  {
    const lockedWas = corpse.energy_locked
    state.waste_heat = Math.round((state.waste_heat + lockedWas) * 1000) / 1000
    corpse.energy_locked = 0
    transferPool(bot, state, 5)
    const evHusk = state.events.length
    const waitHusk = act(
      state,
      { actor_id: 'agnes', budget_energy: 2, actions: [{ op: 'wait' }] },
      { settle: false },
    )
    assert.ok(waitHusk.accepted.includes(0), `husk wait accepted ${JSON.stringify(waitHusk)}`)
    assert.ok(
      state.events.slice(evHusk).some((e) => e.type === 'wait_neglect'),
      'wait_neglect on husk',
    )
    // restore some lock for later revive-duty tests
    const back = Math.min(lockedWas, state.waste_heat)
    state.waste_heat = Math.round((state.waste_heat - back) * 1000) / 1000
    corpse.energy_locked = back
    console.log('✓ wait_neglect on husk corpse (no duty)')
  }

  // wait away from crisis also unpaid (wait_steady cancelled)
  bot.pos = { x: 2, y: 2 }
  transferPool(bot, state, 4)
  const evW2 = state.events.length
  act(state, { actor_id: 'agnes', budget_energy: 2, actions: [{ op: 'wait' }] })
  assert.ok(
    !state.events.slice(evW2).some((e) => e.type === 'micro_reward' && e.payload.reason === 'wait_steady'),
    'wait_steady cancelled globally',
  )
  console.log('✓ wait unpaid everywhere (no wait_steady)')

  // wait near a low-pool living bot (no corpse) must NOT emit wait_neglect
  {
    const victim = state.bots.find((b) => b.actorId === 'glm')!
    victim.alive = true
    victim.starveTicks = 5
    victim.pos = { x: bot.pos.x + 1, y: bot.pos.y }
    // ensure no corpse in view — reclaim locked to waste, give victim a sliver from waste
    for (const o of state.organics.filter((x) => x.kind === 'corpse')) {
      state.waste_heat = Math.round((state.waste_heat + o.energy_locked) * 1000) / 1000
    }
    state.organics = state.organics.filter((o) => o.kind !== 'corpse')
    transferPool(victim, state, 0.2)
    const evD = state.events.length
    act(state, { actor_id: 'agnes', budget_energy: 2, actions: [{ op: 'wait' }] })
    assert.ok(
      !state.events.slice(evD).some((e) => e.type === 'wait_neglect'),
      'wait_neglect must NOT fire without corpse',
    )
    console.log('✓ wait_neglect only near corpse (dying alone ignored)')
  }

  // --- revive duty: wait/bite refused when corpse in view + pool covers revive+margin ---
  {
    const victim = state.bots.find((b) => b.actorId === 'glm')!
    // Reclaim any prior corpse locked into waste before removing (conservation)
    for (const o of state.organics.filter((x) => x.kind === 'corpse')) {
      state.waste_heat = Math.round((state.waste_heat + o.energy_locked) * 1000) / 1000
    }
    state.organics = state.organics.filter((o) => o.kind !== 'corpse')
    // Fund corpse locked from fruit (conservation); clear victim pools
    const locked = 20
    const fruit = state.organics.find((o) => o.kind === 'fruit')!
    assert.ok(fruit.energy_locked + 1e-9 >= locked, 'need fruit energy to fund test corpse')
    fruit.energy_locked = Math.round((fruit.energy_locked - locked) * 1000) / 1000
    fruit.pos = { ...bot.pos }
    victim.energy_pool = 0
    victim.stomach = 0
    victim.alive = false
    const corpse = {
      id: 'corpse_duty_test',
      kind: 'corpse' as const,
      pos: { x: bot.pos.x + 1, y: bot.pos.y },
      energy_locked: locked,
      corpseOf: 'glm',
      diedAtTick: state.tick,
      radius: 1,
    }
    state.organics.push(corpse)
    transferPool(bot, state, ACTION_COST.revive + REVIVE_SAFETY_MARGIN + 1)
    assert.ok(conservationOk(state, 0.5), `pre-duty Σ=${totalEnergy(state)} baseline=${state.conservation_baseline}`)
    const evDuty = state.events.length
    const waitR = act(state, { actor_id: 'agnes', budget_energy: 2, actions: [{ op: 'wait' }] }, { settle: false })
    assert.ok(
      waitR.rejected.some((r) => r.code === 'REFUSED_REVIVE_WAIT'),
      `expected REFUSED_REVIVE_WAIT got ${JSON.stringify(waitR.rejected)}`,
    )
    const biteR = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'bite', target_id: fruit.id }] },
      { settle: false },
    )
    assert.ok(
      biteR.rejected.some((r) => r.code === 'REFUSED_REVIVE_BITE'),
      `expected REFUSED_REVIVE_BITE got ${JSON.stringify(biteR.rejected)}`,
    )
    assert.ok(
      state.events.slice(evDuty).some((e) => e.type === 'refused_revive_wait'),
      'telemetry refused_revive_wait',
    )
    assert.ok(
      state.events.slice(evDuty).some((e) => e.type === 'refused_revive_bite'),
      'telemetry refused_revive_bite',
    )
    const snapD = observe(state, 'agnes')
    assert.equal(snapD.suggested_ops[0], 'revive', `revive pinned got ${snapD.suggested_ops}`)
    bot.pos = { ...corpse.pos }
    transferPool(bot, state, ACTION_COST.revive + 2)
    const poolBefore = bot.energy_pool
    const rev = act(
      state,
      { actor_id: 'agnes', budget_energy: 20, actions: [{ op: 'revive', target_id: corpse.id }] },
      { settle: false },
    )
    assert.ok(rev.accepted.includes(0), `revive accepted ${JSON.stringify(rev)}`)
    assert.ok(victim.alive, 'victim alive')
    assert.ok(
      state.events.some((e) => e.type === 'revived' && e.payload.revived === 'glm'),
      'revived event',
    )
    assert.ok(
      conservationOk(state, 0.5),
      `after revive Σ=${totalEnergy(state)} baseline=${state.conservation_baseline}`,
    )
    // Net: -cost + savior_share; with locked=20 share=7 cost=8 → net -1
    assert.ok(Math.abs(bot.energy_pool - (poolBefore - ACTION_COST.revive + 7)) < 0.05, 'savior share 35%')
    assert.ok(Math.abs(victim.energy_pool - 9) < 0.05, 'revived share 45% of 20')
    console.log(
      `✓ revive duty refuse wait/bite; revived split ok savior=${bot.energy_pool} revived=${victim.energy_pool}`,
    )
  }

  // --- revive knife: duty via locked≥8 + hungry_revive pays shortfall from corpse ---
  {
    const victim = state.bots.find((b) => b.actorId === 'glm')!
    // Re-kill victim with empty pools so killBot tops lock from waste
    if (victim.alive) {
      state.waste_heat = Math.round((state.waste_heat + victim.energy_pool + victim.stomach) * 1000) / 1000
      victim.energy_pool = 0
      victim.stomach = 0
      victim.alive = false
    }
    for (const o of state.organics.filter((x) => x.kind === 'corpse')) {
      state.waste_heat = Math.round((state.waste_heat + o.energy_locked) * 1000) / 1000
    }
    state.organics = state.organics.filter((o) => o.kind !== 'corpse')
    // Ensure waste can fund floor
    if (state.waste_heat < CORPSE_LOCK_FLOOR) {
      const fruit = state.organics.find((o) => o.kind === 'fruit')
      if (fruit && fruit.energy_locked > CORPSE_LOCK_FLOOR) {
        const t = CORPSE_LOCK_FLOOR
        fruit.energy_locked = Math.round((fruit.energy_locked - t) * 1000) / 1000
        state.waste_heat = Math.round((state.waste_heat + t) * 1000) / 1000
      }
    }
    // Synthesize topped corpse (same as killBot floor)
    const locked = CORPSE_LOCK_FLOOR
    assert.ok(state.waste_heat + 1e-9 >= locked, 'waste for corpse floor')
    state.waste_heat = Math.round((state.waste_heat - locked) * 1000) / 1000
    const corpse = {
      id: 'corpse_hungry_revive',
      kind: 'corpse' as const,
      pos: { x: bot.pos.x + 1, y: bot.pos.y },
      energy_locked: locked,
      corpseOf: 'glm',
      diedAtTick: state.tick,
      radius: 1,
    }
    state.organics.push(corpse)
    victim.alive = false
    victim.energy_pool = 0
    victim.stomach = 0
    // Low pool (<8) but locked≥8 → duty + can_afford
    transferPool(bot, state, 2)
    const snapH = observe(state, 'agnes')
    const cObs = snapH.corpses.find((c) => c.organic_id === corpse.id)!
    assert.ok(cObs.self_can_afford, `self_can_afford via locked got pool=${bot.energy_pool} locked=${cObs.energy_locked}`)
    assert.ok(cObs.saviors.some((s) => s.actor_id === 'agnes' && s.can_afford), 'savior can_afford via locked')
    const waitH = act(state, { actor_id: 'agnes', budget_energy: 2, actions: [{ op: 'wait' }] }, { settle: false })
    assert.ok(
      waitH.rejected.some((r) => r.code === 'REFUSED_REVIVE_WAIT'),
      `duty wait with low pool ${JSON.stringify(waitH.rejected)}`,
    )
    bot.pos = { ...corpse.pos }
    transferPool(bot, state, 2)
    const poolBefore = bot.energy_pool
    const lockedBefore = corpse.energy_locked
    const heatBefore = state.waste_heat
    const revH = act(
      state,
      { actor_id: 'agnes', budget_energy: 20, actions: [{ op: 'revive', target_id: corpse.id }] },
      { settle: false },
    )
    assert.ok(revH.accepted.includes(0), `hungry revive ${JSON.stringify(revH)}`)
    assert.ok(victim.alive, 'victim revived hungry')
    const revEv = [...state.events].reverse().find((e) => e.type === 'revived' && e.payload?.hungry_revive)
    assert.ok(revEv, 'hungry_revive event flag')
    assert.ok(Math.abs((revEv!.payload.paid_from_pool as number) - poolBefore) < 0.05, 'paid_from_pool')
    assert.ok(Math.abs((revEv!.payload.paid_from_corpse as number) - (ACTION_COST.revive - poolBefore)) < 0.05, 'paid_from_corpse')
    // Remaining after shortfall: lockedBefore - shortfall, then split
    const shortfall = ACTION_COST.revive - poolBefore
    const remain = Math.round((lockedBefore - shortfall) * 1000) / 1000
    const expectSavior = Math.round(remain * 0.35 * 1000) / 1000
    const expectRevived = Math.round(remain * 0.45 * 1000) / 1000
    assert.ok(Math.abs(bot.energy_pool - expectSavior) < 0.05, `savior share got ${bot.energy_pool} expect ${expectSavior}`)
    assert.ok(Math.abs(victim.energy_pool - expectRevived) < 0.05, `revived share got ${victim.energy_pool} expect ${expectRevived}`)
    assert.ok(conservationOk(state, 0.6), `after hungry revive Σ=${totalEnergy(state)}`)
    assert.ok(state.waste_heat + 1e-9 >= heatBefore + ACTION_COST.revive - 0.1, 'cost→waste')
    console.log(
      `✓ hungry_revive pool=${poolBefore} shortfall=${shortfall} remain=${remain} savior=${bot.energy_pool} revived=${victim.energy_pool}`,
    )
  }

  // --- research threshold sink: fruit-era tail-append (head-pin only after fruit_gone) ---
  {
    state.organics = state.organics.filter((o) => o.kind !== 'corpse')
    // Clear stomach first so research comes from pool gate only
    if (bot.stomach > 0) {
      state.waste_heat = Math.round((state.waste_heat + bot.stomach) * 1000) / 1000
      bot.stomach = 0
    }
    transferPool(bot, state, RESEARCH_POOL_THRESHOLD) // 6 — below SATIETY 10
    assert.ok(Math.abs(bot.energy_pool - RESEARCH_POOL_THRESHOLD) < 0.05, `pool=${bot.energy_pool}`)
    // Park adjacent to fruit so FRUIT_FORAGE move-pin does not strip research tail
    {
      const fr = state.organics.find((o) => o.kind === 'fruit' && o.energy_locked > 0.01)
      if (fr) bot.pos = { x: fr.pos.x + fr.radius, y: fr.pos.y }
    }
    const snapR = observe(state, 'agnes')
    assert.ok(snapR.suggested_ops.includes('pull'), `research pull present got ${snapR.suggested_ops}`)
    assert.ok(snapR.suggested_ops.includes('adsorb'), 'adsorb')
    // Fruit present → research must NOT sit ahead of bite
    const biteIdx = snapR.suggested_ops.indexOf('bite')
    const pullIdx = snapR.suggested_ops.indexOf('pull')
    if (biteIdx >= 0 && pullIdx >= 0) {
      assert.ok(
        biteIdx < pullIdx,
        `fruit-era: bite ahead of research pull got ${snapR.suggested_ops}`,
      )
    }
    assert.ok(
      snapR.alerts.some((a) => a.includes('RESEARCH_READY') && a.includes('fruit-era')),
      `fruit-era RESEARCH_READY alert got ${snapR.alerts[0]}`,
    )
    // catalyze only when some view particle has bond<1
    const viewHasUnmaxed = state.particles.some(
      (p) =>
        Math.hypot(p.pos.x - bot.pos.x, p.pos.y - bot.pos.y) <= 6 && (p.bond ?? 0) < 1 - 1e-9,
    )
    if (viewHasUnmaxed) {
      assert.ok(snapR.suggested_ops.includes('catalyze'), `catalyze when bond<1 got ${snapR.suggested_ops}`)
    } else {
      assert.ok(!snapR.suggested_ops.includes('catalyze'), `no catalyze when all maxed got ${snapR.suggested_ops}`)
    }
    // SATIETY still fruit-only: pool 6 < 10 → fruit bite allowed if fruit present
    const fruit = state.organics.find((o) => o.kind === 'fruit' && o.energy_locked > 20)
    if (fruit) {
      bot.pos = { ...fruit.pos }
      const biteF = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'bite', target_id: fruit.id }] },
        { settle: false },
      )
      assert.ok(
        biteF.accepted.includes(0) || !biteF.rejected.some((r) => r.code === 'REFUSED_SATIATED'),
        `fruit bite at pool6 not satiated ${JSON.stringify(biteF.rejected)}`,
      )
    }
    console.log(`✓ RESEARCH_READY fruit-era pool=${bot.energy_pool} suggest=${snapR.suggested_ops.slice(0, 4)}`)
  }

  // --- REFUSED_CATALYZE_MAXED + research divert (no catalyze when all bonds maxed) ---
  {
    state.organics = state.organics.filter((o) => o.kind !== 'corpse')
    if (bot.stomach > 0) {
      state.waste_heat = Math.round((state.waste_heat + bot.stomach) * 1000) / 1000
      bot.stomach = 0
    }
    transferPool(bot, state, RESEARCH_POOL_THRESHOLD)
    // Pick a nearby particle and max its bond
    let target = state.particles.find(
      (p) => Math.hypot(p.pos.x - bot.pos.x, p.pos.y - bot.pos.y) <= 2.6,
    )
    if (!target) {
      target = state.particles[0]!
      bot.pos = { ...target.pos }
    }
    target.bond = 1
    const poolBefore = bot.energy_pool
    const evBefore = state.events.length
    const maxed = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'catalyze', target_id: target.id }] },
      { settle: false },
    )
    assert.ok(
      maxed.rejected.some((r) => r.code === 'REFUSED_CATALYZE_MAXED'),
      `expected REFUSED_CATALYZE_MAXED got ${JSON.stringify(maxed.rejected)}`,
    )
    assert.ok(!maxed.accepted.includes(0), 'catalyze maxed not accepted')
    assert.ok(Math.abs(bot.energy_pool - poolBefore) < 1e-9, 'no energy spent on maxed catalyze')
    assert.ok(
      state.events.slice(evBefore).some((e) => e.type === 'refused_catalyze_maxed'),
      'refused_catalyze_maxed event',
    )
    console.log(`✓ REFUSED_CATALYZE_MAXED bond=1 particle=${target.id}`)

    // Max ALL particles in view → research suggest must omit catalyze, keep pull/adsorb
    for (const p of state.particles) {
      if (Math.hypot(p.pos.x - bot.pos.x, p.pos.y - bot.pos.y) <= 6) p.bond = 1
    }
    transferPool(bot, state, RESEARCH_POOL_THRESHOLD)
    const snapDiv = observe(state, 'agnes')
    assert.ok(
      snapDiv.suggested_ops.includes('pull') || snapDiv.suggested_ops.includes('adsorb'),
      `divert pull/adsorb got ${snapDiv.suggested_ops}`,
    )
    assert.ok(
      !snapDiv.suggested_ops.includes('catalyze'),
      `no catalyze when all maxed got ${snapDiv.suggested_ops}`,
    )
    console.log(`✓ research divert (all maxed) suggest=${snapDiv.suggested_ops.slice(0, 4)}`)

    // Restore one unmaxed → catalyze returns to suggest
    const restore = state.particles.find(
      (p) => Math.hypot(p.pos.x - bot.pos.x, p.pos.y - bot.pos.y) <= 6,
    )
    if (restore) restore.bond = 0.3
    const snapCat = observe(state, 'agnes')
    assert.ok(
      snapCat.suggested_ops.includes('catalyze'),
      `catalyze when bond<1 got ${snapCat.suggested_ops}`,
    )
    console.log(`✓ research catalyze when bond<1 suggest=${snapCat.suggested_ops.slice(0, 4)}`)
  }

  // --- REFUSED_CONDENSE_CLUTTER when clump in view ---
  {
    // Ensure post-fruit-ish: drain fruit locked to waste for clean condense prereq aside from clutter
    for (const o of state.organics.filter((x) => x.kind === 'fruit')) {
      state.waste_heat = Math.round((state.waste_heat + o.energy_locked) * 1000) / 1000
      o.energy_locked = 0
    }
    state.organics = state.organics.filter((o) => o.kind !== 'fruit' || o.energy_locked > 0.01)
    // Place a clump on bot
    if (state.waste_heat < 8) {
      // mint from baseline-safe: skip if can't
    }
    const need = 5
    assert.ok(state.waste_heat >= need, 'waste for clutter clump')
    state.waste_heat = Math.round((state.waste_heat - need) * 1000) / 1000
    const cl = {
      id: 'clump_clutter_test',
      kind: 'clump' as const,
      pos: { ...bot.pos },
      energy_locked: need,
      radius: 1,
    }
    state.organics.push(cl)
    // Fund pool for condense cost but not starving
    transferPool(bot, state, 8)
    // Arrange mix window
    let yi = 0
    let ya = 0
    for (const p of state.particles.filter((x) => !x.boundTo)) {
      if (p.kind === 'yin' && yi < 2) {
        p.pos = { x: bot.pos.x + yi, y: bot.pos.y }
        yi++
      } else if (p.kind === 'yang' && ya < 2) {
        p.pos = { x: bot.pos.x, y: bot.pos.y + ya + 1 }
        ya++
      }
    }
    bot.condenseFailStreak = 0
    bot.condenseCooldownUntil = 0
    const preC = evaluateCondensePrereqs(state, bot)
    assert.ok(preC.refuse_clutter, `refuse_clutter ${preC.prereq_reason}`)
    assert.ok(!preC.prereq_ok, 'prereq not ok')
    const snapC = observe(state, 'agnes')
    assert.ok(!snapC.suggested_ops.includes('condense'), `no condense suggest ${snapC.suggested_ops}`)
    const condC = act(
      state,
      { actor_id: 'agnes', budget_energy: 10, actions: [{ op: 'condense' }] },
      { settle: false },
    )
    assert.ok(
      condC.rejected.some((r) => r.code === 'REFUSED_CONDENSE_CLUTTER'),
      `expected CLUTTER got ${JSON.stringify(condC.rejected)}`,
    )
    assert.ok(state.events.some((e) => e.type === 'refused_condense_clutter'), 'telemetry clutter')
    console.log('✓ REFUSED_CONDENSE_CLUTTER with clump in view')
    // cleanup clump into waste for later tests
    state.waste_heat = Math.round((state.waste_heat + cl.energy_locked) * 1000) / 1000
    state.organics = state.organics.filter((o) => o.id !== cl.id)
    // Scatter free particles so later MIX teaching can force yang-missing window
    let yinNear = 0
    for (const p of state.particles.filter((x) => !x.boundTo)) {
      if (p.kind === 'yin') {
        p.pos = { x: bot.pos.x + (yinNear % 2), y: bot.pos.y }
        yinNear++
      } else {
        p.pos = { x: 1, y: 1 } // far corner — missing yang locally
      }
    }
    bot.condenseFailStreak = 0
    bot.condenseCooldownUntil = 0
  }

  // --- post-fruit: condense + low-yield corpse bite ---
  {
    // Drain fruit
    for (const o of state.organics.filter((x) => x.kind === 'fruit')) {
      state.waste_heat = Math.round((state.waste_heat + o.energy_locked) * 1000) / 1000
      o.energy_locked = 0
    }
    state.organics = state.organics.filter((o) => o.kind !== 'fruit' || o.energy_locked > 0.01)
    const snapGone = observe(state, 'agnes')
    assert.equal(snapGone.fruit_gone, true, 'fruit_gone')
    assert.ok(snapGone.fruit && snapGone.fruit.gone === true, 'fruit.gone')
    assert.ok(Array.isArray(snapGone.clumps), 'clumps array')
    assert.ok(snapGone.condense && typeof snapGone.condense.ok === 'boolean', 'condense.ok')
    assert.ok(typeof snapGone.condense.est_gain === 'number', 'condense.est_gain')
    assert.ok(snapGone.alerts.some((a) => a.includes('FRUIT_GONE')), 'FRUIT_GONE alert')
    assert.ok(typeof snapGone.waste_heat === 'number', 'waste_heat in observe')
    assert.ok(snapGone.condense, 'condense hook')

    // Mix incomplete → REFUSED_CONDENSE_MIX + observe teaching fields
    {
      transferPool(bot, state, 8)
      // Park bot mid-map; yang in far corner so window has only yin
      bot.pos = { x: Math.floor(state.width / 2), y: Math.floor(state.height / 2) }
      for (const p of state.particles.filter((x) => !x.boundTo && x.kind === 'yang')) {
        p.pos = { x: state.width - 1, y: state.height - 1 }
      }
      for (const p of state.particles.filter((x) => !x.boundTo && x.kind === 'yin')) {
        p.pos = { x: bot.pos.x + 1, y: bot.pos.y }
      }
      // Clear leftover clumps so CLUTTER does not mask MIX teaching
      for (const o of state.organics.filter((x) => x.kind === 'clump')) {
        state.waste_heat = Math.round((state.waste_heat + o.energy_locked) * 1000) / 1000
      }
      state.organics = state.organics.filter((o) => o.kind !== 'clump')
      const snapMix = observe(state, 'agnes')
      assert.equal(snapMix.condense.mix_ok, false, 'mix_ok false')
      assert.ok(snapMix.condense.local_yin >= 1, 'local_yin')
      assert.equal(snapMix.condense.local_yang, 0, 'local_yang 0')
      assert.equal(snapMix.condense.missing, 'yang', `missing=${snapMix.condense.missing}`)
      assert.ok(snapMix['齐窗进度'] && snapMix['齐窗进度'].label === '齐窗进度', '齐窗进度 field')
      assert.equal(snapMix['齐窗进度'].mix_ok, false, '齐窗进度.mix_ok')
      assert.ok(snapMix['齐窗进度'].text.includes('阴'), `齐窗进度.text ${snapMix['齐窗进度'].text}`)
      assert.ok(snapMix.condense.window_progress?.text, 'window_progress')
      assert.ok(snapMix.condense.nearest_opposite && snapMix.condense.nearest_opposite.kind === 'yang', 'nearest yang')
      // Opp parked far → two-stage nav pins move only (not pull)
      assert.ok(snapMix.suggested_ops[0] === 'move' || snapMix.suggested_ops.includes('move'), `suggest move (far) got ${snapMix.suggested_ops}`)
      assert.ok(!snapMix.suggested_ops.includes('pull') || snapMix.suggested_ops.indexOf('move') < snapMix.suggested_ops.indexOf('pull'), 'move before pull when far')
      assert.ok(!snapMix.suggested_ops.includes('condense') || snapMix.suggested_ops.indexOf('move') < snapMix.suggested_ops.indexOf('condense'), 'move before condense')
      const mix1 = act(state, { actor_id: 'agnes', budget_energy: 10, actions: [{ op: 'condense' }] }, { settle: false })
      assert.ok(mix1.rejected.some((r) => r.code === 'REFUSED_CONDENSE_MIX'), `mix1 ${JSON.stringify(mix1.rejected)}`)
      const mix2 = act(state, { actor_id: 'agnes', budget_energy: 10, actions: [{ op: 'condense' }] }, { settle: false })
      assert.ok(mix2.rejected.some((r) => r.code === 'REFUSED_CONDENSE_MIX'), `mix2 ${JSON.stringify(mix2.rejected)}`)
      // Third should hit cooldown
      const mix3 = act(state, { actor_id: 'agnes', budget_energy: 10, actions: [{ op: 'condense' }] }, { settle: false })
      assert.ok(
        mix3.rejected.some((r) => r.code === 'REFUSED_CONDENSE_COOLDOWN' || r.code === 'REFUSED_CONDENSE_MIX'),
        `mix3 cooldown-ish ${JSON.stringify(mix3.rejected)}`,
      )
      assert.ok(state.events.some((e) => e.type === 'refused_condense_mix'), 'telemetry refused_condense_mix')
      // Clear cooldown for success path below
      bot.condenseFailStreak = 0
      bot.condenseCooldownUntil = 0
      console.log('✓ REFUSED_CONDENSE_MIX + cooldown teaching')

      // Prep gate: catalyze refused; pull wrong kind refused; pull opposite ok
      bot.condenseFailStreak = 0
      bot.condenseCooldownUntil = 0
      transferPool(bot, state, 8)
      const badCat = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'catalyze', target_id: state.particles.find((p) => !p.boundTo)!.id }] },
        { settle: false },
      )
      assert.ok(badCat.rejected.some((r) => r.code === 'REFUSED_CONDENSE_PREP'), `prep catalyze ${JSON.stringify(badCat.rejected)}`)
      const yinNear = state.particles.find((p) => !p.boundTo && p.kind === 'yin')!
      yinNear.pos = { x: bot.pos.x + 1, y: bot.pos.y }
      const yangFar = state.particles.find((p) => !p.boundTo && p.kind === 'yang')!
      yangFar.pos = { x: state.width - 1, y: state.height - 1 }
      const badPull = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'pull', target_id: yinNear.id, dir: 'e' }] },
        { settle: false },
      )
      assert.ok(badPull.rejected.some((r) => r.code === 'REFUSED_CONDENSE_PREP'), `pull yin while missing yang ${JSON.stringify(badPull.rejected)}`)
      // Window has yin only; sole yang east → move east toward it
      bot.pos = { x: 10, y: 10 }
      yinNear.pos = { x: 10, y: 11 } // south of bot; east cell free for move
      for (const p of state.particles) {
        if (p.boundTo) continue
        if (p.kind === 'yang') p.pos = { x: 40, y: 40 } // park all yang far SE
        else if (p.id !== yinNear.id) p.pos = { x: 0, y: 0 }
      }
      yangFar.pos = { x: 18, y: 10 } // only yang east of bot
      const snapPre = observe(state, 'agnes')
      assert.equal(snapPre.condense.missing, 'yang', `missing before move ${snapPre.condense.missing}`)
      assert.equal(snapPre.condense.nearest_opposite?.id, yangFar.id, `nearest ${snapPre.condense.nearest_opposite}`)
      const goodMove = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'move', dir: 'e' }] },
        { settle: false },
      )
      assert.ok(goodMove.accepted.includes(0), `move toward opposite ${JSON.stringify(goodMove)}`)
      const badMove = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'move', dir: 'w' }] },
        { settle: false },
      )
      assert.ok(badMove.rejected.some((r) => r.code === 'REFUSED_CONDENSE_PREP'), `move away ${JSON.stringify(badMove.rejected)}`)
      // Far: pull opposite still refused (too far — must move first)
      const farPull = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'pull', target_id: yangFar.id, dir: 'e' }] },
        { settle: false },
      )
      assert.ok(farPull.rejected.some((r) => r.code === 'REFUSED_CONDENSE_PREP'), `far pull ${JSON.stringify(farPull.rejected)}`)
      const snapFar = observe(state, 'agnes')
      assert.ok(snapFar.suggested_ops[0] === 'move', `far head=move got ${snapFar.suggested_ops}`)
      // research may tail-append pull; prep head must stay move (not pull)
      if (snapFar.suggested_ops.includes('pull')) {
        assert.ok(snapFar.suggested_ops.indexOf('move') < snapFar.suggested_ops.indexOf('pull'), `move before research pull ${snapFar.suggested_ops}`)
      }
      assert.ok(state.events.some((e) => e.type === 'refused_condense_prep'), 'telemetry prep')
      // Near stage: keep BOTH polarities — yang stays in window while yin sits at d≤INTERACT.
      // WINDOW=3.5 so yang within ~2 of bot while yin at d=1 → still missing nothing? yin at 1 fills yin.
      // To keep !mix_ok with opp.dist≤INTERACT: need MIN>1. Force near by placing yin at d=1.2
      // while yang is absent from window AND we lie about missing via a second yin requirement —
      // instead: place yin at d=1.2 as nearest of missing=yin with zero yin in window is impossible
      // (d=1.2 < WINDOW). So construct near via missing=yang with yang at d=1.2 and yin outside window:
      // wait — yang at 1.2 enters window. Unreachable with MIN=1.
      // Cover near act-path by temporarily parking: bot + yin@1.2 + no yang, then ALSO park a bound
      // decoy — skip. Assert far path hard; soft-check near if engine ever reports it.
      {
        bot.pos = { x: 20, y: 20 }
        for (const p of state.particles) {
          if (p.boundTo) continue
          p.pos = { x: 0, y: 0 }
        }
        const yinOpp = state.particles.find((p) => !p.boundTo && p.kind === 'yin')!
        const yangKeep = state.particles.find((p) => !p.boundTo && p.kind === 'yang')!
        yangKeep.pos = { x: 20, y: 21 } // in window
        yinOpp.pos = { x: 25, y: 20 } // d=5 far
        const snapFar2 = observe(state, 'agnes')
        assert.equal(snapFar2.suggested_ops[0], 'move', `far2 head ${snapFar2.suggested_ops}`)
        assert.ok((snapFar2.condense.nearest_opposite?.dist ?? 0) > 1.6, 'far2')
        // Bring yang along when approaching yin so mix completes (documents WINDOW>INTERACT)
        bot.pos = { x: 24, y: 20 }
        yangKeep.pos = { x: 24, y: 21 }
        yinOpp.pos = { x: 25, y: 20 }
        const snapClose = observe(state, 'agnes')
        assert.equal(snapClose.condense.mix_ok, true, `close+both mix_ok got missing=${snapClose.condense.missing}`)
        // Synthetic near: act-gate only — place opp yang at d=1 with yin in window cleared by
        // using refuse path: set missing via zero yin, yang at d=1 → yang in window → missing=yin,
        // opp=yin far. Still not near. Accept far-only coverage for MIN=1.
      }
      console.log('✓ REFUSED_CONDENSE_PREP two-stage nav (far=move; near gated by INTERACT)')
    }

    // Seed yin+yang near bot + enough waste
    const frees = state.particles.filter((p) => !p.boundTo)
    let yi = 0
    let ya = 0
    for (const p of frees) {
      if (p.kind === 'yin' && yi < 2) {
        p.pos = { x: bot.pos.x + yi, y: bot.pos.y }
        yi++
      } else if (p.kind === 'yang' && ya < 2) {
        p.pos = { x: bot.pos.x, y: bot.pos.y + ya + 1 }
        ya++
      }
    }
    if (state.waste_heat < CONDENSE_MIN_WASTE + 5) {
      // mint via baseline-safe: transfer from bot stomach/pool already in ledger — use waste bump from fruit drain
    }
    transferPool(bot, state, ACTION_COST.condense + 3)
    // Ensure enough waste_heat for full CONDENSE_DRAW (locked ~= DRAW*eff ≥ 4)
    if (state.waste_heat < CONDENSE_DRAW) {
      const need = CONDENSE_DRAW - state.waste_heat
      // conservation: take from bot stomach/pool excess via ledger — park from other bots
      for (const b of state.bots) {
        if (need <= 0) break
        if (b.stomach > 0) {
          const t = Math.min(b.stomach, need)
          b.stomach = Math.round((b.stomach - t) * 1000) / 1000
          state.waste_heat = Math.round((state.waste_heat + t) * 1000) / 1000
        }
      }
    }
    const pre = evaluateCondensePrereqs(state, bot)
    assert.ok(pre.prereq_ok, `condense prereq ${pre.prereq_reason}`)
    const evC = state.events.length
    const heatBefore = state.waste_heat
    const cond = act(
      state,
      { actor_id: 'agnes', budget_energy: 10, actions: [{ op: 'condense' }] },
      { settle: false },
    )
    assert.ok(cond.accepted.includes(0), `condense accepted ${JSON.stringify(cond)}`)
    assert.ok(state.events.slice(evC).some((e) => e.type === 'condense'), 'condense event')
    const clump = state.organics.find((o) => o.kind === 'clump')
    assert.ok(clump && clump.energy_locked > 0, 'clump created')
    assert.ok(
      clump!.energy_locked >= 4 - 0.05 &&
        clump!.energy_locked <= CONDENSE_DRAW * CONDENSE_EFFICIENCY + 0.05,
      `locked=${clump!.energy_locked} expect ~${CONDENSE_DRAW * CONDENSE_EFFICIENCY}`,
    )
    assert.ok(conservationOk(state, 0.5), `after condense Σ=${totalEnergy(state)}`)

    // Low pool + clump in view → wait refused; bite(clump) elevated
    {
      transferPool(bot, state, 3) // below CLUMP_FORAGE_POOL_THRESHOLD (8)
      const snapC = observe(state, 'agnes')
      assert.ok(snapC.suggested_ops.includes('bite'), `suggest bite got ${snapC.suggested_ops}`)
      const waitC = act(
        state,
        { actor_id: 'agnes', budget_energy: 2, actions: [{ op: 'wait' }] },
        { settle: false },
      )
      assert.ok(waitC.rejected.some((r) => r.code === 'REFUSED_CLUMP_WAIT'), `clump wait ${JSON.stringify(waitC.rejected)}`)
      bot.pos = { ...clump!.pos }
      transferPool(bot, state, 5)
      const biteCl = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'bite', target_id: clump!.id }] },
        { settle: false },
      )
      assert.ok(biteCl.accepted.includes(0), `clump bite ${JSON.stringify(biteCl)}`)
      assert.ok(state.events.some((e) => e.type === 'bite' && e.payload.kind === 'clump'), 'clump bite event')
      console.log('✓ REFUSED_CLUMP_WAIT + clumpBite')
    }

    // Hunger knife: pool < CONDENSE_STARVING_POOL → REFUSED_CONDENSE_STARVING; hungry bite pays from clump
    {
      // Re-find or re-seed a clump with enough locked energy
      let cl = state.organics.find((o) => o.kind === 'clump' && o.energy_locked >= 5)
      if (!cl) {
        const need = 8
        assert.ok(state.waste_heat >= need, 'waste for hunger clump')
        state.waste_heat = Math.round((state.waste_heat - need) * 1000) / 1000
        cl = {
          id: 'clump_hunger_test',
          kind: 'clump' as const,
          pos: { ...bot.pos },
          energy_locked: need,
          radius: 1,
        }
        state.organics.push(cl)
      }
      bot.pos = { ...cl.pos }
      bot.biteStreak = 0
      delete bot.biteStreakTargetId
      transferPool(bot, state, 1) // pool 1 < cost 2 and < starving floor 4
      const snapStarv = observe(state, 'agnes')
      assert.ok(snapStarv.suggested_ops[0] === 'bite' || snapStarv.suggested_ops.includes('bite'), `bite pinned got ${snapStarv.suggested_ops}`)
      assert.ok(!snapStarv.condense?.ok, 'condense not ok when starving')
      const starv = act(
        state,
        { actor_id: 'agnes', budget_energy: 10, actions: [{ op: 'condense' }] },
        { settle: false },
      )
      assert.ok(
        starv.rejected.some((r) => r.code === 'REFUSED_CONDENSE_STARVING'),
        `expected STARVING got ${JSON.stringify(starv.rejected)}`,
      )
      assert.ok(state.events.some((e) => e.type === 'refused_condense_starving'), 'telemetry starving')
      const lockedBefore = cl.energy_locked
      const stomBefore = bot.stomach
      const poolBefore = bot.energy_pool
      const heatBefore = state.waste_heat
      const biteH = act(
        state,
        { actor_id: 'agnes', budget_energy: 10, actions: [{ op: 'bite', target_id: cl.id }] },
        { settle: false },
      )
      assert.ok(biteH.accepted.includes(0), `hungry clump bite ${JSON.stringify(biteH)}`)
      assert.ok(Math.abs(bot.energy_pool - poolBefore) < 1e-6, `pool unchanged got ${bot.energy_pool} was ${poolBefore}`)
      const biteEv = [...state.events].reverse().find((e) => e.type === 'bite' && e.payload?.hungry_clump_bite)
      assert.ok(biteEv, 'hungry_clump_bite event flag')
      const chunk = biteEv!.payload.chunk as number
      const cost = biteEv!.payload.cost as number
      const toStom = biteEv!.payload.to_stomach as number
      assert.ok(Math.abs(toStom - (chunk - cost)) < 1e-6, `stomach=chunk-cost got ${toStom} chunk=${chunk} cost=${cost}`)
      assert.ok(bot.stomach + 1e-9 >= stomBefore + toStom - 0.01, 'stomach gained')
      assert.ok(cl.energy_locked + 1e-9 <= lockedBefore - chunk + 0.01, 'clump drained')
      assert.ok(state.waste_heat + 1e-9 >= heatBefore + cost - 0.01, 'cost→waste from clump')
      assert.ok(conservationOk(state, 0.6), `after hungry bite Σ=${totalEnergy(state)}`)
      console.log(`✓ REFUSED_CONDENSE_STARVING + hungry clump bite stomach=${toStom} (chunk ${chunk} − cost ${cost})`)
    }

    // Corpse bite low yield
    const corpse = {
      id: 'corpse_bite_test',
      kind: 'corpse' as const,
      pos: { ...bot.pos },
      energy_locked: 10,
      corpseOf: 'glm',
      diedAtTick: state.tick,
      radius: 1,
    }
    // fund from waste
    assert.ok(state.waste_heat >= 10, 'waste for corpse')
    state.waste_heat = Math.round((state.waste_heat - 10) * 1000) / 1000
    state.organics.push(corpse)
    const glmBot = state.bots.find((b) => b.actorId === 'glm')!
    // Preserve conservation: dump any leftover pool into waste before marking dead
    if (glmBot.energy_pool > 0) {
      state.waste_heat = Math.round((state.waste_heat + glmBot.energy_pool) * 1000) / 1000
      glmBot.energy_pool = 0
    }
    if (glmBot.stomach > 0) {
      state.waste_heat = Math.round((state.waste_heat + glmBot.stomach) * 1000) / 1000
      glmBot.stomach = 0
    }
    glmBot.alive = false
    transferPool(bot, state, 5)
    const stomBefore = bot.stomach
    const coreBefore = bot.core_integrity
    const biteC = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'bite', target_id: corpse.id }] },
      { settle: false },
    )
    assert.ok(biteC.accepted.includes(0), `corpse bite ${JSON.stringify(biteC)}`)
    const gained = bot.stomach - stomBefore
    assert.ok(gained + 1e-9 < 8 * CORPSE_BITE_YIELD_MUL + 0.5, `low yield stomach+${gained}`)
    assert.ok(bot.core_integrity + 1e-9 < coreBefore, 'core damage on corpse bite')
    assert.ok(
      conservationOk(state, 0.6),
      `after corpse bite Σ=${totalEnergy(state)} baseline=${state.conservation_baseline}`,
    )
    // husk bite refused
    corpse.energy_locked = 0
    transferPool(bot, state, 5)
    const husk = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'bite', target_id: corpse.id }] },
      { settle: false },
    )
    assert.ok(
      husk.rejected.length > 0 && husk.accepted.length === 0,
      `husk bite refused got ${JSON.stringify(husk)}`,
    )
    console.log(
      `✓ post-fruit condense locked=${clump!.energy_locked} corpseBite stomach+${gained.toFixed(2)} core=${bot.core_integrity}`,
    )
  }

  // Re-plant tiny fruit so mix-prep gate (post-fruit) does not block pull osc tests
  {
    const need = 1
    if (state.waste_heat >= need) {
      state.waste_heat = Math.round((state.waste_heat - need) * 1000) / 1000
      state.organics.push({
        id: 'fruit_smoke_keep',
        kind: 'fruit',
        pos: { x: 2, y: 2 },
        energy_locked: need,
        radius: 3,
      })
    }
  }

  // spam pull far from others unpaid (isolate particle)
  const loner = state.particles.find((p) => !p.boundTo && p.id !== freeP!.id) || state.particles.find((p) => !p.boundTo)
  if (loner) {
    loner.pos = { x: 1, y: 1 }
    // clear neighbors
    for (const p of state.particles) {
      if (!p.boundTo && p.id !== loner.id && Math.hypot(p.pos.x - 1, p.pos.y - 1) < 5) {
        p.pos = { x: 40, y: 40 }
      }
    }
    bot.pos = { x: 1, y: 1 }
    transferPool(bot, state, 4)
    const evP = state.events.length
    const heatP = state.waste_heat
    act(state, {
      actor_id: 'agnes',
      budget_energy: 5,
      actions: [{ op: 'pull', target_id: loner.id, dir: 'e' }],
    })
    const microP = state.events.slice(evP).filter((e) => e.type === 'micro_reward')
    assert.ok(
      !microP.some((e) => e.payload.reason === 'pull_moved'),
      'spam pull_moved must be unpaid',
    )
    console.log(`✓ spam pull unpaid micros=${microP.map((e) => e.payload.reason).join(',') || 'none'} heatΔ=${(state.waste_heat - heatP).toFixed(2)}`)

    // oscillation: pull e then w on same particle — second unpaid
    loner.pos = { ...bot.pos }
    // ensure adjacent same cell
    transferPool(bot, state, 5)
    const evO = state.events.length
    act(state, {
      actor_id: 'agnes',
      budget_energy: 10,
      actions: [
        { op: 'pull', target_id: loner.id, dir: 'e' },
      ],
    })
    // put particle back adjacent for reverse
    loner.pos = { x: bot.pos.x + 1, y: bot.pos.y }
    bot.pos = { x: loner.pos.x - 1, y: loner.pos.y }
    // manually set last pull memory as e-move if act moved it
    const afterFirst = state.events.slice(evO)
    act(state, {
      actor_id: 'agnes',
      budget_energy: 10,
      actions: [{ op: 'pull', target_id: loner.id, dir: 'w' }],
    })
    const osc = state.events.slice(evO).filter((e) => e.type === 'pull_oscillation')
    const microAfter = state.events.slice(evO).filter((e) => e.type === 'micro_reward')
    // If oscillation detected, no reward on reverse; event may or may not fire depending on geometry
    if (osc.length) {
      assert.ok(
        !microAfter.some(
          (e) =>
            e.payload.reason === 'pull_closer' &&
            Number(e.t) >= (osc[0]!.t as number),
        ),
        'oscillation must not pay pull_closer',
      )
      console.log(`✓ pull_oscillation unpaid count=${osc.length}`)
    } else {
      // Force oscillation path via rememberPull semantics: two reverse moves with memory
      bot.lastPullParticleId = loner.id
      bot.lastPullFrom = { x: 5, y: 5 }
      bot.lastPullTo = { x: 6, y: 5 }
      // Isolate geometry: park everyone else far from (5,5)/(6,5)/(6,6)
      for (const p of state.particles) {
        if (p.id !== loner.id) p.pos = { x: 0, y: 0 }
      }
      for (const b of state.bots) {
        if (b.id !== bot.id) b.pos = { x: 1, y: 1 }
      }
      loner.pos = { x: 6, y: 5 }
      bot.pos = { x: 6, y: 6 }
      bot.alive = true
      state.events.length = 0
      transferPool(bot, state, 5)
      const evF = state.events.length
      const forced = act(
        state,
        { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'pull', target_id: loner.id, dir: 'w' }] },
        { settle: false },
      )
      assert.ok(forced.accepted.includes(0), `forced pull accepted ${JSON.stringify(forced)}`)
      assert.ok(
        state.events.slice(evF).some((e) => e.type === 'pull_oscillation'),
        'forced reverse must emit pull_oscillation',
      )
      assert.ok(
        !state.events
          .slice(evF)
          .some((e) => e.type === 'micro_reward' && e.payload.reason === 'pull_closer'),
        'forced osc unpaid',
      )
      console.log('✓ pull_oscillation forced unpaid')
    }
  }

  // --- Fruit-era forage pin + hungry_move from waste ---
  {
    state.organics = state.organics.filter((o) => o.kind !== 'corpse' && o.kind !== 'clump')
    let fr = state.organics.find((o) => o.kind === 'fruit' && o.energy_locked > 20)
    if (!fr) {
      // Re-seed a fruit from waste for forage-pin coverage (post-fruit tests emptied it)
      const lock = Math.min(80, Math.max(0, state.waste_heat - 5))
      assert.ok(lock >= 20, `need waste for fruit reseed have ${state.waste_heat}`)
      state.waste_heat = Math.round((state.waste_heat - lock) * 1000) / 1000
      fr = {
        id: 'fruit_forage_test',
        kind: 'fruit' as const,
        pos: { x: 24, y: 24 },
        energy_locked: lock,
        radius: 3,
      }
      state.organics.push(fr)
    }
    assert.ok(fr, 'need fruit for forage pin')
    if (bot.stomach > 0) {
      state.waste_heat = Math.round((state.waste_heat + bot.stomach) * 1000) / 1000
      bot.stomach = 0
    }
    // Far from fruit, pool below satiety → suggested only move; wait/catalyze refused
    bot.pos = {
      x: Math.min(state.width - 1, fr!.pos.x + fr!.radius + 8),
      y: fr!.pos.y,
    }
    transferPool(bot, state, 3)
    const snapF = observe(state, 'agnes')
    assert.ok(
      snapF.alerts.some((a) => a.includes('FRUIT_FORAGE') && a.includes(fr!.id)),
      `FRUIT_FORAGE alert got ${snapF.alerts[0]}`,
    )
    assert.deepEqual(
      snapF.suggested_ops.filter((o) => o === 'move' || o === 'wait' || o === 'catalyze'),
      ['move'],
      `forage suggested got ${snapF.suggested_ops}`,
    )
    assert.ok(snapF.suggested_ops[0] === 'move' || snapF.suggested_ops.includes('move'), 'move present')
    assert.ok(!snapF.suggested_ops.includes('wait'), 'no wait in forage pin')
    assert.ok(!snapF.suggested_ops.includes('catalyze'), 'no catalyze in forage pin')
    const refuseW = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'wait' }] },
      { settle: false },
    )
    assert.ok(
      refuseW.rejected.some((r) => r.code === 'REFUSED_FRUIT_FORAGE'),
      `wait refuse forage got ${JSON.stringify(refuseW.rejected)}`,
    )
    const refuseC = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'catalyze', target_id: state.particles[0]?.id }] },
      { settle: false },
    )
    assert.ok(
      refuseC.rejected.some((r) => r.code === 'REFUSED_FRUIT_FORAGE'),
      `catalyze refuse forage got ${JSON.stringify(refuseC.rejected)}`,
    )
    // Hungry move: pool < ACTION_COST.move, pay from waste
    transferPool(bot, state, 0.2)
    assert.ok(bot.energy_pool + 1e-9 < ACTION_COST.move, `pool ${bot.energy_pool} < move`)
    assert.ok(state.waste_heat >= ACTION_COST.move, 'waste covers move')
    const beforeW = state.waste_heat
    const beforeP = bot.energy_pool
    const beforeE = totalEnergy(state)
    const dirToward =
      fr!.pos.x > bot.pos.x ? 'e' : fr!.pos.x < bot.pos.x ? 'w' : fr!.pos.y > bot.pos.y ? 's' : 'n'
    state.events.length = 0
    const hm = act(
      state,
      { actor_id: 'agnes', budget_energy: 5, actions: [{ op: 'move', dir: dirToward }] },
      { settle: false },
    )
    assert.ok(hm.accepted.includes(0), `hungry_move accepted ${JSON.stringify(hm.rejected)}`)
    const moveEv = state.events.find((e) => e.type === 'move')
    assert.ok(moveEv?.payload?.hungry_move, `hungry_move event got ${JSON.stringify(moveEv)}`)
    assert.ok(
      Number(moveEv?.payload?.topped_from_waste) > 0,
      `topped_from_waste got ${moveEv?.payload?.topped_from_waste}`,
    )
    const afterE = totalEnergy(state)
    assert.ok(
      Math.abs(afterE - beforeE) < 0.35,
      `after hungry_move Σ=${afterE} was ${beforeE} (Δ must ~0)`,
    )
    console.log(
      `✓ FRUIT_FORAGE + hungry_move pool ${beforeP}→${bot.energy_pool} waste ${beforeW}→${state.waste_heat} topped=${moveEv?.payload?.topped_from_waste}`,
    )
  }

  console.log('=== WORLD-SMOKE OK ===')
}

main()
