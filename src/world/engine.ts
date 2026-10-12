/**
 * YinYang Field M0 — in-process physics + observe/act API.
 * Energy is conserved: particles + pools + locked organics + waste_heat = baseline.
 */
import { randomUUID } from 'node:crypto'
import type {
  ActAction,
  ActReceipt,
  ActRejectCode,
  ActRequest,
  BotBody,
  ObserveSnapshot,
  Organic,
  Particle,
  ParticleKind,
  Vec2,
  WorldEvent,
  WorldOp,
  WorldState,
} from './types.ts'

export const WORLD_WIDTH = 48
export const WORLD_HEIGHT = 48
export const VIEW_RADIUS = 6
export const INTERACT_RADIUS = 1.6
export const START_POOL = 12
export const BITE_CHUNK = 8
export const ACTION_COST: Record<WorldOp, number> = {
  nudge: 1,
  pull: 1.2,
  adsorb: 1.5,
  catalyze: 2,
  bite: 2,
  digest: 0.5,
  wait: 0.2,
  revive: 8,
}
export const STARVE_TICKS_TO_DIE = 8
export const CORE_DEATH = 0.05

const DIRS: Record<string, Vec2> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
  ne: { x: 1, y: -1 },
  nw: { x: -1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
  上: { x: 0, y: -1 },
  下: { x: 0, y: 1 },
  右: { x: 1, y: 0 },
  左: { x: -1, y: 0 },
  北: { x: 0, y: -1 },
  南: { x: 0, y: 1 },
  东: { x: 1, y: 0 },
  西: { x: -1, y: 0 },
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

function keyOf(p: Vec2): string {
  return `${p.x},${p.y}`
}

function parseDir(raw?: string): Vec2 | null {
  if (!raw) return null
  const d = DIRS[raw.trim().toLowerCase()] || DIRS[raw.trim()]
  return d ? { ...d } : null
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

export function totalEnergy(state: WorldState): number {
  let sum = state.waste_heat
  for (const p of state.particles) sum += p.energy
  for (const o of state.organics) sum += o.energy_locked
  for (const b of state.bots) sum += b.energy_pool + b.stomach
  return Math.round(sum * 1000) / 1000
}

export function pushEvent(state: WorldState, type: string, payload: Record<string, unknown>): void {
  state.events.push({ t: state.tick, type, payload })
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200)
}

function freeParticleAt(state: WorldState, pos: Vec2): Particle | undefined {
  return state.particles.find((p) => !p.boundTo && p.pos.x === pos.x && p.pos.y === pos.y)
}

function occupiedKeys(state: WorldState): Set<string> {
  const keys = new Set<string>()
  for (const p of state.particles) {
    if (!p.boundTo) keys.add(keyOf(p.pos))
  }
  for (const b of state.bots) {
    if (b.alive) keys.add(keyOf(b.pos))
  }
  return keys
}

function inBounds(state: WorldState, pos: Vec2): boolean {
  return pos.x >= 0 && pos.y >= 0 && pos.x < state.width && pos.y < state.height
}

function findBot(state: WorldState, actorId: string): BotBody | undefined {
  return state.bots.find((b) => b.actorId === actorId)
}

function findParticle(state: WorldState, id: string): Particle | undefined {
  return state.particles.find((p) => p.id === id)
}

function findOrganic(state: WorldState, id: string): Organic | undefined {
  return state.organics.find((o) => o.id === id)
}

function spend(bot: BotBody, cost: number): boolean {
  if (bot.energy_pool + 1e-9 < cost) return false
  bot.energy_pool = Math.round((bot.energy_pool - cost) * 1000) / 1000
  return true
}

function recordError(bot: BotBody, code: ActRejectCode, msg: string): void {
  bot.last_errors.unshift({ code, msg, at: new Date().toISOString() })
  if (bot.last_errors.length > 8) bot.last_errors.length = 8
}

/** Seed a fresh world with a big fruit and cast bots near it. */
export function createSeedWorld(actorIds: string[]): WorldState {
  const width = WORLD_WIDTH
  const height = WORLD_HEIGHT
  const cx = Math.floor(width / 2)
  const cy = Math.floor(height / 2)

  const particles: Particle[] = []
  // Sparse ambient yin/yang around the map
  let n = 0
  for (let y = 4; y < height - 4; y += 5) {
    for (let x = 4; x < width - 4; x += 5) {
      if (Math.abs(x - cx) < 5 && Math.abs(y - cy) < 5) continue
      const kind: ParticleKind = n % 2 === 0 ? 'yin' : 'yang'
      particles.push({
        id: newId('p'),
        kind,
        pos: { x, y },
        energy: 2 + (n % 3),
        bond: 0.1,
      })
      n++
    }
  }

  const fruitEnergy = 400
  const fruit: Organic = {
    id: newId('fruit'),
    kind: 'fruit',
    pos: { x: cx, y: cy },
    energy_locked: fruitEnergy,
    radius: 3,
  }

  const bots: BotBody[] = []
  const offsets: Vec2[] = [
    { x: -4, y: -1 },
    { x: 4, y: -1 },
    { x: -3, y: 3 },
    { x: 3, y: 3 },
    { x: 0, y: 5 },
  ]
  actorIds.forEach((actorId, i) => {
    const off = offsets[i % offsets.length]!
    const pos = { x: clamp(cx + off.x, 1, width - 2), y: clamp(cy + off.y, 1, height - 2) }
    // Core particles bound to bot
    const coreYin: Particle = {
      id: newId('core'),
      kind: 'yin',
      pos: { ...pos },
      energy: 3,
      bond: 0.9,
      boundTo: actorId,
    }
    const coreYang: Particle = {
      id: newId('core'),
      kind: 'yang',
      pos: { ...pos },
      energy: 3,
      bond: 0.9,
      boundTo: actorId,
    }
    particles.push(coreYin, coreYang)
    bots.push({
      id: newId('bot'),
      actorId,
      pos,
      energy_pool: START_POOL,
      core_integrity: 1,
      bound_particle_ids: [coreYin.id, coreYang.id],
      stomach: 0,
      alive: true,
      starveTicks: 0,
      last_errors: [],
    })
  })

  const state: WorldState = {
    width,
    height,
    tick: 0,
    particles,
    organics: [fruit],
    bots,
    waste_heat: 0,
    events: [],
    conservation_baseline: 0,
    updatedAt: new Date().toISOString(),
  }
  state.conservation_baseline = totalEnergy(state)
  pushEvent(state, 'world_seeded', {
    actors: actorIds,
    fruit_energy: fruitEnergy,
    baseline: state.conservation_baseline,
  })
  return state
}

export function observe(state: WorldState, actorId: string): ObserveSnapshot {
  const bot = findBot(state, actorId)
  if (!bot) {
    throw new Error(`unknown actor: ${actorId}`)
  }
  const radius = VIEW_RADIUS
  const particles = state.particles
    .filter((p) => !p.boundTo && dist(p.pos, bot.pos) <= radius)
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      pos: { ...p.pos },
      energy: p.energy,
      ...(p.bond != null ? { bond: p.bond } : {}),
    }))
  const organics = state.organics
    .filter((o) => dist(o.pos, bot.pos) <= radius + o.radius)
    .map((o) => ({
      id: o.id,
      kind: o.kind,
      pos: { ...o.pos },
      energy_locked: o.energy_locked,
    }))
  const events_recent = state.events.filter((e) => e.t >= state.tick - 5).slice(-12)
  return {
    tick: state.tick,
    self: {
      id: bot.actorId,
      pos: { ...bot.pos },
      energy_pool: bot.energy_pool,
      core_integrity: bot.core_integrity,
      bound_particle_ids: [...bot.bound_particle_ids],
      stomach: bot.stomach,
      alive: bot.alive,
    },
    view: { radius, particles },
    organics,
    events_recent,
    last_errors: [...bot.last_errors],
  }
}

function reject(
  receipt: ActReceipt,
  bot: BotBody,
  idx: number,
  code: ActRejectCode,
  msg: string,
): void {
  receipt.rejected.push({ idx, code, msg })
  recordError(bot, code, msg)
}

function applyOne(
  state: WorldState,
  bot: BotBody,
  action: ActAction,
  idx: number,
  receipt: ActReceipt,
  budgetLeft: { n: number },
): void {
  if (!bot.alive) {
    reject(receipt, bot, idx, 'ILLEGAL_OP', 'bot is dead (corpse); needs revive')
    return
  }
  const op = action.op
  if (!op || !(op in ACTION_COST)) {
    reject(receipt, bot, idx, 'ILLEGAL_OP', `unknown op: ${String(op)}`)
    return
  }
  const cost = ACTION_COST[op]
  if (budgetLeft.n + 1e-9 < cost) {
    reject(receipt, bot, idx, 'BUDGET_EXCEEDED', `need ${cost}, budget left ${budgetLeft.n}`)
    return
  }
  if (bot.energy_pool + 1e-9 < cost && op !== 'digest') {
    // digest can run with low pool (costs little); still check
    if (bot.energy_pool + 1e-9 < cost) {
      reject(receipt, bot, idx, 'NO_ENERGY', `pool ${bot.energy_pool} < cost ${cost}`)
      return
    }
  }

  switch (op) {
    case 'wait': {
      if (!spend(bot, cost)) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'cannot wait')
        return
      }
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      pushEvent(state, 'wait', { actor: bot.actorId })
      return
    }
    case 'nudge':
    case 'pull': {
      const target = action.target_id ? findParticle(state, action.target_id) : undefined
      if (!target || target.boundTo) {
        reject(receipt, bot, idx, 'TARGET_GONE', 'particle missing or bound')
        return
      }
      if (dist(bot.pos, target.pos) > INTERACT_RADIUS + 0.1) {
        reject(receipt, bot, idx, 'NOT_ADJACENT', 'target not adjacent')
        return
      }
      const dir = parseDir(action.dir) || (op === 'pull'
        ? {
            x: Math.sign(bot.pos.x - target.pos.x) || 0,
            y: Math.sign(bot.pos.y - target.pos.y) || 0,
          }
        : null)
      if (!dir || (dir.x === 0 && dir.y === 0)) {
        reject(receipt, bot, idx, 'ILLEGAL_OP', 'dir required (n/s/e/w/…)')
        return
      }
      const mag = clamp(Math.round(action.mag ?? 1), 1, 2)
      const next = {
        x: clamp(target.pos.x + dir.x * mag, 0, state.width - 1),
        y: clamp(target.pos.y + dir.y * mag, 0, state.height - 1),
      }
      const occ = occupiedKeys(state)
      occ.delete(keyOf(target.pos))
      if (occ.has(keyOf(next))) {
        reject(receipt, bot, idx, 'ILLEGAL_OP', 'destination occupied')
        return
      }
      if (!spend(bot, cost)) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'pool empty')
        return
      }
      target.pos = next
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      pushEvent(state, op, { actor: bot.actorId, particle: target.id, to: next })
      return
    }
    case 'adsorb': {
      const target = action.target_id ? findParticle(state, action.target_id) : undefined
      if (!target || target.boundTo) {
        reject(receipt, bot, idx, 'TARGET_GONE', 'particle missing or already bound')
        return
      }
      if (dist(bot.pos, target.pos) > INTERACT_RADIUS + 0.1) {
        reject(receipt, bot, idx, 'NOT_ADJACENT', 'target not adjacent')
        return
      }
      if (bot.bound_particle_ids.length >= 6) {
        reject(receipt, bot, idx, 'ILLEGAL_OP', 'bound capacity full')
        return
      }
      if (!spend(bot, cost)) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'pool empty')
        return
      }
      target.boundTo = bot.actorId
      target.pos = { ...bot.pos }
      bot.bound_particle_ids.push(target.id)
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      pushEvent(state, 'adsorb', { actor: bot.actorId, particle: target.id })
      return
    }
    case 'catalyze': {
      const target = action.target_id ? findParticle(state, action.target_id) : undefined
      if (!target) {
        reject(receipt, bot, idx, 'TARGET_GONE', 'particle missing')
        return
      }
      if (dist(bot.pos, target.pos) > INTERACT_RADIUS + 1) {
        reject(receipt, bot, idx, 'NOT_ADJACENT', 'too far')
        return
      }
      if (!spend(bot, cost)) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'pool empty')
        return
      }
      target.bond = clamp((target.bond ?? 0.2) + 0.25, 0, 1)
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      pushEvent(state, 'catalyze', { actor: bot.actorId, particle: target.id, bond: target.bond })
      return
    }
    case 'bite': {
      const org = action.target_id ? findOrganic(state, action.target_id) : undefined
      if (!org || org.energy_locked <= 0) {
        reject(receipt, bot, idx, 'TARGET_GONE', 'organic missing or empty')
        return
      }
      if (dist(bot.pos, org.pos) > org.radius + INTERACT_RADIUS) {
        reject(receipt, bot, idx, 'NOT_ADJACENT', 'not close enough to bite')
        return
      }
      if (!spend(bot, cost)) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'pool empty')
        return
      }
      const chunk = Math.min(BITE_CHUNK, org.energy_locked)
      org.energy_locked = Math.round((org.energy_locked - chunk) * 1000) / 1000
      bot.stomach = Math.round((bot.stomach + chunk) * 1000) / 1000
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      pushEvent(state, 'bite', {
        actor: bot.actorId,
        organic: org.id,
        kind: org.kind,
        chunk,
        remaining: org.energy_locked,
      })
      if (org.energy_locked <= 0.01 && org.kind !== 'corpse') {
        state.organics = state.organics.filter((o) => o.id !== org.id)
        pushEvent(state, 'organic_gone', { id: org.id, kind: org.kind })
      }
      return
    }
    case 'digest': {
      if (bot.stomach <= 0) {
        reject(receipt, bot, idx, 'ILLEGAL_OP', 'stomach empty')
        return
      }
      // Cost may be paid from stomach conversion if pool is empty
      const take = Math.min(bot.stomach, BITE_CHUNK)
      const toPool = Math.round(take * 0.85 * 1000) / 1000
      const toHeat = Math.round((take - toPool) * 1000) / 1000
      if (toPool + 1e-9 < cost && bot.energy_pool + 1e-9 < cost) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'cannot cover digest cost')
        return
      }
      bot.stomach = Math.round((bot.stomach - take) * 1000) / 1000
      bot.energy_pool = Math.round((bot.energy_pool + toPool) * 1000) / 1000
      if (!spend(bot, cost)) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'digest cost failed')
        return
      }
      state.waste_heat = Math.round((state.waste_heat + toHeat + cost) * 1000) / 1000
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      receipt.accepted.push(idx)
      pushEvent(state, 'digest', { actor: bot.actorId, toPool, toHeat })
      return
    }
    case 'revive': {
      const org = action.target_id ? findOrganic(state, action.target_id) : undefined
      if (!org || org.kind !== 'corpse' || !org.corpseOf) {
        reject(receipt, bot, idx, 'TARGET_GONE', 'need a corpse organic')
        return
      }
      if (dist(bot.pos, org.pos) > INTERACT_RADIUS + 1) {
        reject(receipt, bot, idx, 'NOT_ADJACENT', 'corpse too far')
        return
      }
      const dead = findBot(state, org.corpseOf)
      if (!dead || dead.alive) {
        reject(receipt, bot, idx, 'ILLEGAL_OP', 'corpse bot missing or already alive')
        return
      }
      if (!spend(bot, cost)) {
        reject(receipt, bot, idx, 'NO_ENERGY', 'need energy to revive')
        return
      }
      // Transfer locked corpse energy back into revived pool partially
      const unlock = Math.min(org.energy_locked, 6)
      org.energy_locked = Math.round((org.energy_locked - unlock) * 1000) / 1000
      dead.alive = true
      dead.core_integrity = 0.55
      dead.energy_pool = Math.round((dead.energy_pool + unlock) * 1000) / 1000
      dead.starveTicks = 0
      dead.pos = { ...org.pos }
      state.organics = state.organics.filter((o) => o.id !== org.id)
      if (org.energy_locked > 0.01) {
        state.waste_heat = Math.round((state.waste_heat + org.energy_locked) * 1000) / 1000
      }
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      pushEvent(state, 'revive', { actor: bot.actorId, revived: dead.actorId })
      return
    }
    default:
      reject(receipt, bot, idx, 'ILLEGAL_OP', `op not implemented: ${op}`)
  }
}

/** Advance physics one tick (drift / interact / megamorph / metabolism). */
export function stepPhysics(state: WorldState): WorldEvent[] {
  const beforeEvents = state.events.length
  state.tick += 1

  // 1) Same-kind attract: move free particle one step toward nearest same kind
  const free = state.particles.filter((p) => !p.boundTo)
  const moved = new Set<string>()
  for (const p of free) {
    if (moved.has(p.id)) continue
    let best: Particle | null = null
    let bestD = 3.5
    for (const q of free) {
      if (q.id === p.id || q.kind !== p.kind) continue
      const d = dist(p.pos, q.pos)
      if (d > 0.1 && d < bestD) {
        bestD = d
        best = q
      }
    }
    if (!best) continue
    const step = {
      x: Math.sign(best.pos.x - p.pos.x),
      y: Math.sign(best.pos.y - p.pos.y),
    }
    if (step.x === 0 && step.y === 0) continue
    const next = {
      x: clamp(p.pos.x + step.x, 0, state.width - 1),
      y: clamp(p.pos.y + step.y, 0, state.height - 1),
    }
    const occ = occupiedKeys(state)
    occ.delete(keyOf(p.pos))
    if (!occ.has(keyOf(next))) {
      p.pos = next
      moved.add(p.id)
      p.bond = clamp((p.bond ?? 0.1) + 0.02, 0, 1)
    }
  }

  // 2) Yin-yang attract + collide transfer
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      const a = free[i]!
      const b = free[j]!
      if (a.kind === b.kind) continue
      const d = dist(a.pos, b.pos)
      if (d > 1.6) continue
      if (d <= 1.05) {
        // collide: transfer energy toward equilibrium, small heat
        const avg = (a.energy + b.energy) / 2
        const transfer = (a.energy - avg) * 0.35
        a.energy = Math.round((a.energy - transfer) * 1000) / 1000
        b.energy = Math.round((b.energy + transfer) * 1000) / 1000
        const heat = 0.05
        a.energy = Math.max(0.1, a.energy - heat / 2)
        b.energy = Math.max(0.1, b.energy - heat / 2)
        state.waste_heat = Math.round((state.waste_heat + heat) * 1000) / 1000
        pushEvent(state, 'collide_transfer', { a: a.id, b: b.id })
      } else {
        // attract: step toward each other if free
        const occ = occupiedKeys(state)
        const stepA = {
          x: clamp(a.pos.x + Math.sign(b.pos.x - a.pos.x), 0, state.width - 1),
          y: clamp(a.pos.y + Math.sign(b.pos.y - a.pos.y), 0, state.height - 1),
        }
        occ.delete(keyOf(a.pos))
        if (!occ.has(keyOf(stepA))) a.pos = stepA
      }
    }
  }

  // 3) Density + ratio threshold → megamorph (3x3 window)
  const gridCount = new Map<string, { yin: number; yang: number; ids: string[] }>()
  for (const p of state.particles.filter((x) => !x.boundTo)) {
    const wx = Math.floor(p.pos.x / 3) * 3
    const wy = Math.floor(p.pos.y / 3) * 3
    const k = `${wx},${wy}`
    const cell = gridCount.get(k) || { yin: 0, yang: 0, ids: [] }
    if (p.kind === 'yin') cell.yin++
    else cell.yang++
    cell.ids.push(p.id)
    gridCount.set(k, cell)
  }
  for (const [k, cell] of gridCount) {
    const total = cell.yin + cell.yang
    if (total < 5) continue
    const ratio = Math.min(cell.yin, cell.yang) / Math.max(cell.yin, cell.yang)
    if (ratio < 0.4) continue
    // Megamorph: consume up to 4 particles into a clump, release KE (nudge neighbors)
    const [wx, wy] = k.split(',').map(Number) as [number, number]
    const victims = cell.ids
      .map((id) => findParticle(state, id)!)
      .filter(Boolean)
      .slice(0, 4)
    if (victims.length < 4) continue
    let locked = 0
    for (const v of victims) {
      locked += v.energy
      state.particles = state.particles.filter((p) => p.id !== v.id)
    }
    const ke = Math.round(locked * 0.15 * 1000) / 1000
    locked = Math.round((locked - ke) * 1000) / 1000
    state.waste_heat = Math.round((state.waste_heat + ke * 0.3) * 1000) / 1000
    const clump: Organic = {
      id: newId('clump'),
      kind: 'clump',
      pos: { x: wx + 1, y: wy + 1 },
      energy_locked: locked,
      radius: 1,
    }
    state.organics.push(clump)
    // KE shock: nudge nearby free particles outward
    for (const p of state.particles.filter((x) => !x.boundTo)) {
      if (dist(p.pos, clump.pos) <= 3) {
        const sx = Math.sign(p.pos.x - clump.pos.x) || (Math.random() > 0.5 ? 1 : -1)
        const sy = Math.sign(p.pos.y - clump.pos.y) || (Math.random() > 0.5 ? 1 : -1)
        const next = {
          x: clamp(p.pos.x + sx, 0, state.width - 1),
          y: clamp(p.pos.y + sy, 0, state.height - 1),
        }
        const occ = occupiedKeys(state)
        occ.delete(keyOf(p.pos))
        if (!occ.has(keyOf(next))) p.pos = next
      }
    }
    // Remaining KE as tiny heat for conservation bookkeeping
    state.waste_heat = Math.round((state.waste_heat + ke * 0.7) * 1000) / 1000
    pushEvent(state, 'megamorph', { at: clump.pos, clump: clump.id, ke })
  }

  // Metabolism / starve
  for (const bot of state.bots) {
    if (!bot.alive) continue
    // Passive upkeep
    const upkeep = 0.15
    if (bot.energy_pool >= upkeep) {
      bot.energy_pool = Math.round((bot.energy_pool - upkeep) * 1000) / 1000
      state.waste_heat = Math.round((state.waste_heat + upkeep) * 1000) / 1000
      bot.starveTicks = 0
    } else {
      bot.starveTicks += 1
      const deficit = upkeep - bot.energy_pool
      state.waste_heat = Math.round((state.waste_heat + bot.energy_pool) * 1000) / 1000
      bot.energy_pool = 0
      bot.core_integrity = clamp(bot.core_integrity - 0.04 - deficit * 0.01, 0, 1)
      if (bot.starveTicks >= STARVE_TICKS_TO_DIE || bot.core_integrity <= CORE_DEATH) {
        killBot(state, bot, 'starve')
      }
    }
    // Sync bound particle positions
    for (const pid of bot.bound_particle_ids) {
      const p = findParticle(state, pid)
      if (p) p.pos = { ...bot.pos }
    }
  }

  state.updatedAt = new Date().toISOString()
  // Snap conservation drift into waste_heat (floating error only)
  const now = totalEnergy(state)
  const drift = Math.round((state.conservation_baseline - now) * 1000) / 1000
  if (Math.abs(drift) > 0 && Math.abs(drift) < 0.05) {
    state.waste_heat = Math.round((state.waste_heat + drift) * 1000) / 1000
  }
  return state.events.slice(beforeEvents)
}

function killBot(state: WorldState, bot: BotBody, reason: string): void {
  if (!bot.alive) return
  bot.alive = false
  const locked = Math.round((bot.energy_pool + bot.stomach) * 1000) / 1000
  bot.energy_pool = 0
  bot.stomach = 0
  const corpse: Organic = {
    id: newId('corpse'),
    kind: 'corpse',
    pos: { ...bot.pos },
    energy_locked: locked,
    corpseOf: bot.actorId,
    radius: 1,
  }
  state.organics.push(corpse)
  pushEvent(state, 'death', { actor: bot.actorId, reason, corpse: corpse.id })
}

export function act(state: WorldState, req: ActRequest): ActReceipt {
  const bot = findBot(state, req.actor_id)
  const receipt: ActReceipt = {
    accepted: [],
    rejected: [],
    energy_spent: 0,
    tick_advanced: state.tick,
  }
  if (!bot) {
    receipt.rejected.push({ idx: -1, code: 'TARGET_GONE', msg: `unknown actor ${req.actor_id}` })
    return receipt
  }
  const budgetLeft = { n: Math.max(0, Number(req.budget_energy) || 0) }
  const actions = Array.isArray(req.actions) ? req.actions.slice(0, 12) : []
  for (let i = 0; i < actions.length; i++) {
    applyOne(state, bot, actions[i]!, i, receipt, budgetLeft)
  }
  // After acts, advance physics one tick
  stepPhysics(state)
  receipt.tick_advanced = state.tick
  state.updatedAt = new Date().toISOString()
  return receipt
}

/** Move bot one step (helper for human / simple locomotion via wait+nudge self). */
export function moveBot(state: WorldState, actorId: string, dirRaw: string): ActReceipt {
  const bot = findBot(state, actorId)
  const receipt: ActReceipt = { accepted: [], rejected: [], energy_spent: 0, tick_advanced: state.tick }
  if (!bot || !bot.alive) {
    receipt.rejected.push({ idx: 0, code: 'ILLEGAL_OP', msg: 'bot dead or missing' })
    return receipt
  }
  const dir = parseDir(dirRaw)
  if (!dir) {
    receipt.rejected.push({ idx: 0, code: 'ILLEGAL_OP', msg: 'bad dir' })
    return receipt
  }
  const cost = 1
  if (bot.energy_pool < cost) {
    receipt.rejected.push({ idx: 0, code: 'NO_ENERGY', msg: 'cannot move' })
    recordError(bot, 'NO_ENERGY', 'cannot move')
    return receipt
  }
  const next = {
    x: clamp(bot.pos.x + dir.x, 0, state.width - 1),
    y: clamp(bot.pos.y + dir.y, 0, state.height - 1),
  }
  const occ = occupiedKeys(state)
  occ.delete(keyOf(bot.pos))
  if (occ.has(keyOf(next))) {
    receipt.rejected.push({ idx: 0, code: 'ILLEGAL_OP', msg: 'blocked' })
    return receipt
  }
  bot.energy_pool = Math.round((bot.energy_pool - cost) * 1000) / 1000
  state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
  bot.pos = next
  for (const pid of bot.bound_particle_ids) {
    const p = findParticle(state, pid)
    if (p) p.pos = { ...bot.pos }
  }
  receipt.accepted.push(0)
  receipt.energy_spent = cost
  pushEvent(state, 'move', { actor: actorId, to: next })
  stepPhysics(state)
  receipt.tick_advanced = state.tick
  return receipt
}

export function formatEventLine(ev: WorldEvent): string {
  const p = ev.payload
  switch (ev.type) {
    case 'bite':
      return `[世界 t=${ev.t}] ${p.actor} 啃了 ${p.kind}（+${p.chunk} 入胃，剩余 ${p.remaining}）`
    case 'digest':
      return `[世界 t=${ev.t}] ${p.actor} 消化：能池+${p.toPool}，废热+${p.toHeat}`
    case 'death':
      return `[世界 t=${ev.t}] ${p.actor} 死亡（${p.reason}），留下尸体 ${p.corpse}`
    case 'revive':
      return `[世界 t=${ev.t}] ${p.actor} 复活了 ${p.revived}`
    case 'megamorph':
      return `[世界 t=${ev.t}] 局部巨变 → 团块 ${p.clump} @(${(p.at as Vec2).x},${(p.at as Vec2).y})`
    case 'collide_transfer':
      return `[世界 t=${ev.t}] 阴阳碰撞转能 ${p.a}↔${p.b}`
    case 'move':
      return `[世界 t=${ev.t}] ${p.actor} 移动到 (${(p.to as Vec2).x},${(p.to as Vec2).y})`
    case 'world_seeded':
      return `[世界 t=${ev.t}] 阴阳场开机 · 守恒基线=${p.baseline} · 硕果能量=${p.fruit_energy}`
    default:
      return `[世界 t=${ev.t}] ${ev.type} ${JSON.stringify(p).slice(0, 120)}`
  }
}

export function conservationOk(state: WorldState, eps = 0.15): boolean {
  return Math.abs(totalEnergy(state) - state.conservation_baseline) <= eps
}
