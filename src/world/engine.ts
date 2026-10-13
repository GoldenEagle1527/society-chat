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
  ObserveSavior,
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
/** Opening pool — hungry but not dead in first live tick. */
export const START_POOL = 6
export const BITE_CHUNK = 8
/**
 * Passive metabolism per physics tick: pool → waste_heat (conservation).
 * Fruit phase softer (teaching); post-fruit slightly harsher (force forage).
 * Legacy METABOLISM_UPKEEP = fruit-phase value.
 */
export const METABOLISM_FRUIT = 0.015
export const METABOLISM_POST_FRUIT = 0.025
/** @deprecated use METABOLISM_FRUIT / METABOLISM_POST_FRUIT */
export const METABOLISM_UPKEEP = METABOLISM_FRUIT
export const ACTION_COST: Record<WorldOp, number> = {
  nudge: 1,
  pull: 1.2,
  adsorb: 1.5,
  catalyze: 2,
  bite: 2,
  digest: 0.5,
  wait: 0.2,
  revive: 8,
  move: 1,
  /** Spend pool to rebind waste_heat → small clump (post-fruit). */
  condense: 2,
}
export const STARVE_TICKS_TO_DIE = 8
export const CORE_DEATH = 0.05
/** Hard-reject fruit `bite` when energy_pool >= this (「刚好够」> hoarding). */
export const SATIETY_THRESHOLD = 10
/** Research sink (not fruit satiety): pin pull/adsorb/catalyze when no corpse duty. */
export const RESEARCH_POOL_THRESHOLD = 6
/** Research sink via stomach buffer (digest side-ok). */
export const RESEARCH_STOMACH_THRESHOLD = 4
/** Extra bite cost per consecutive same-target bite after the first. */
export const BITE_STREAK_COST_STEP = 1.5
/** Yield loss per consecutive same-target bite (floors at 25% of BITE_CHUNK). */
/** Harsher diminishing → fruit lasts longer (teaching window). */
export const BITE_STREAK_YIELD_STEP = 0.28
/**
 * Micro-op rewards: recycle a sliver of waste_heat → energy_pool.
 * Never mint — if waste_heat is empty, reward is 0 (conservation holds).
 * Prefer structural progress (cluster / pair / morph-prep / bond) over spam moved.
 */
export const MICRO_REWARD_PULL = 0.35
export const MICRO_REWARD_PULL_CLOSER = 0.08
export const MICRO_REWARD_ADSORB = 0.25
export const MICRO_REWARD_ADSORB_BALANCE = 0.55
export const MICRO_REWARD_CATALYZE = 0.4
/** wait_steady REMOVED — lying flat must not pay (was 0.12). */
export const MICRO_REWARD_WAIT_STEADY = 0
/** Revive adjacency (same as act revive gate). */
export const REVIVE_RANGE = INTERACT_RADIUS + 1
/** Unrevived corpse: locked energy slowly bleeds to waste_heat (conservation). */
export const CORPSE_LOCK_LEAK = 0.08
/** After this many ticks without revive, harden corpse alerts. */
export const CORPSE_NEGLECT_HARDEN_TICKS = 4
/** Pool must cover revive cost + this margin before wait/bite are hard-refused. */
/** 0 = duty when pool can exactly cover revive (soft-metabolism worlds rarely hold +1). */
export const REVIVE_SAFETY_MARGIN = 0
/** Fraction of corpse locked energy granted to savior / revived (rest → waste). */
export const REVIVE_SHARE_SAVIOR = 0.35
export const REVIVE_SHARE_REVIVED = 0.45
/** Starve death: if pool+stomach < this, pull waste_heat to top up corpse.locked (conservation). */
export const CORPSE_LOCK_FLOOR = 12
/** Post-fruit condense: waste_heat → clump locked at this efficiency (15–25%). */
/** M0-friendly upper band (15–25%); tune down later. */
export const CONDENSE_EFFICIENCY = 0.25
/** Below this fruit locked energy, satiety no longer blocks fruit bite (thirst). */
export const FRUIT_TAIL_THRESHOLD = 300
/** Suggest bite(clump) when pool below this and clumps exist. */
export const CLUMP_FORAGE_POOL_THRESHOLD = 8
/** Reject condense when pool below this (hunger knife — still allow bite(clump)/digest/revive/move). */
export const CONDENSE_STARVING_POOL = 4
/** Boost condense/bite when fruit locked at or below this (nearly gone). */
export const FRUIT_NEARLY_GONE = 80
export const CONDENSE_MIN_WASTE = 8
export const CONDENSE_DRAW = 20
export const CONDENSE_WINDOW_RADIUS = 3.5
export const CONDENSE_MIN_YIN = 1
export const CONDENSE_MIN_YANG = 1
/** Softened for M0 visibility (was 3). */
export const CONDENSE_MIN_PARTICLES = 2
/** After this many consecutive condense fails, enter cooldown. */
export const CONDENSE_FAIL_COOLDOWN_AFTER = 2
/** Cooldown length in world ticks (blocks empty condense smashes). */
export const CONDENSE_COOLDOWN_TICKS = 5
/** Extra energy cost per fail-streak step when mix is otherwise ok (cap 3). */
export const CONDENSE_STREAK_COST_STEP = 1
/** Corpse/clump bite: low yield + high waste (emergency, not riches). */
export const CORPSE_BITE_YIELD_MUL = 0.35
export const CORPSE_BITE_WASTE_FRAC = 0.55
export const CORPSE_BITE_CORE_DAMAGE = 0.02
export const CLUMP_BITE_YIELD_MUL = 0.55
export const CLUMP_BITE_WASTE_FRAC = 0.35
/** Reject codes that emit a world event (design telemetry; avoid flood). */
const TELEMETRY_REJECT_CODES: ReadonlySet<ActRejectCode> = new Set([
  'REFUSED_SATIATED',
  'REFUSED_REVIVE_WAIT',
  'REFUSED_REVIVE_BITE',
  'REFUSED_CONDENSE_MIX',
  'REFUSED_CONDENSE_COOLDOWN',
  'REFUSED_CONDENSE_PREP',
  'REFUSED_CLUMP_WAIT',
  'REFUSED_CONDENSE_STARVING',
  'REFUSED_CONDENSE_CLUTTER',
  'REFUSED_CATALYZE_MAXED',
  'REFUSED_FRUIT_FORAGE',
])

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

function ensureBiteFields(bot: BotBody): void {
  if (typeof bot.biteStreak !== 'number' || Number.isNaN(bot.biteStreak)) bot.biteStreak = 0
}

function ensureCondenseFields(bot: BotBody): void {
  if (typeof bot.condenseFailStreak !== 'number' || Number.isNaN(bot.condenseFailStreak)) {
    bot.condenseFailStreak = 0
  }
  if (typeof bot.condenseCooldownUntil !== 'number' || Number.isNaN(bot.condenseCooldownUntil)) {
    bot.condenseCooldownUntil = 0
  }
}

/** Effective bite cost given prior consecutive bites on the same target. */
export function biteCostForStreak(priorStreak: number): number {
  const s = Math.max(0, Math.floor(priorStreak))
  return Math.round((ACTION_COST.bite + s * BITE_STREAK_COST_STEP) * 1000) / 1000
}

/** Bite chunk yield given prior consecutive bites on the same target. */
export function biteYieldForStreak(priorStreak: number): number {
  const s = Math.max(0, Math.floor(priorStreak))
  const mul = Math.max(0.25, 1 - s * BITE_STREAK_YIELD_STEP)
  return Math.round(BITE_CHUNK * mul * 1000) / 1000
}

function resetBiteStreak(bot: BotBody): void {
  ensureBiteFields(bot)
  bot.biteStreak = 0
  delete bot.biteStreakTargetId
}

function bumpBiteStreak(bot: BotBody, targetId: string): void {
  ensureBiteFields(bot)
  if (bot.biteStreakTargetId === targetId) {
    bot.biteStreak += 1
  } else {
    bot.biteStreakTargetId = targetId
    bot.biteStreak = 1
  }
}

/**
 * Conservation-safe micro reward: waste_heat → bot.energy_pool (never mint).
 * Returns amount actually granted (0 if no waste heat left).
 */
export function grantMicroReward(
  state: WorldState,
  bot: BotBody,
  amount: number,
  reason: string,
  extra: Record<string, unknown> = {},
): number {
  const want = Math.max(0, Math.round(amount * 1000) / 1000)
  const take = Math.min(want, Math.max(0, state.waste_heat))
  if (take <= 0.001) return 0
  state.waste_heat = Math.round((state.waste_heat - take) * 1000) / 1000
  bot.energy_pool = Math.round((bot.energy_pool + take) * 1000) / 1000
  pushEvent(state, 'micro_reward', {
    actor: bot.actorId,
    amount: take,
    reason,
    waste_heat_left: state.waste_heat,
    ...extra,
  })
  return take
}

/** @deprecated alias — use grantMicroReward */
export function maybeGrantProbeReward(
  state: WorldState,
  bot: BotBody,
  kind: 'steady_config' | 'megamorph' | 'hypothesis',
): void {
  const map = { steady_config: MICRO_REWARD_WAIT_STEADY, megamorph: 0.4, hypothesis: 0.2 } as const
  grantMicroReward(state, bot, map[kind], kind)
}

function freeParticles(state: WorldState): Particle[] {
  return state.particles.filter((p) => !p.boundTo)
}

/** Same-kind neighbors within r (excluding self). */
function sameKindNear(state: WorldState, p: Particle, at: Vec2, r: number): number {
  let n = 0
  for (const q of freeParticles(state)) {
    if (q.id === p.id || q.kind !== p.kind) continue
    if (dist(at, q.pos) <= r) n++
  }
  return n
}

/** Distance to nearest opposite-kind free particle (Infinity if none). */
function nearestOppDist(state: WorldState, p: Particle, at: Vec2): number {
  let best = Infinity
  for (const q of freeParticles(state)) {
    if (q.id === p.id || q.kind === p.kind) continue
    const d = dist(at, q.pos)
    if (d < best) best = d
  }
  return best
}

/** 3×3 megamorph cell key. */
function morphCellKey(pos: Vec2): string {
  return `${Math.floor(pos.x / 3) * 3},${Math.floor(pos.y / 3) * 3}`
}

/** How close a cell is to megamorph (0–1-ish); particle at `at` counted as kind. */
function morphCellScore(state: WorldState, at: Vec2, kind: ParticleKind, selfId: string): number {
  const key = morphCellKey(at)
  let yin = 0
  let yang = 0
  for (const q of freeParticles(state)) {
    if (q.id === selfId) continue
    if (morphCellKey(q.pos) !== key) continue
    if (q.kind === 'yin') yin++
    else yang++
  }
  if (kind === 'yin') yin++
  else yang++
  const total = yin + yang
  if (total === 0) return 0
  const ratio = Math.min(yin, yang) / Math.max(yin, yang)
  // Reward density toward 5 + balance (megamorph needs ≥5 & ratio≥0.4)
  return Math.min(total, 5) / 5 + (ratio >= 0.4 ? 0.35 : ratio * 0.5)
}

/**
 * Score a particle relocation for config progress.
 * Returns reward amount + reason, or null if unpaid spam move.
 */
export function scorePullConfig(
  state: WorldState,
  particle: Particle,
  from: Vec2,
  to: Vec2,
): { amount: number; reason: string } | null {
  if (from.x === to.x && from.y === to.y) return null
  const clusterBefore = sameKindNear(state, particle, from, 2.5)
  const clusterAfter = sameKindNear(state, particle, to, 2.5)
  const oppBefore = nearestOppDist(state, particle, from)
  const oppAfter = nearestOppDist(state, particle, to)
  const morphBefore = morphCellScore(state, from, particle.kind, particle.id)
  const morphAfter = morphCellScore(state, to, particle.kind, particle.id)

  if (morphAfter > morphBefore + 0.05) {
    return { amount: MICRO_REWARD_PULL, reason: 'pull_morph_prep' }
  }
  if (clusterAfter > clusterBefore) {
    return { amount: MICRO_REWARD_PULL * 0.9, reason: 'pull_cluster' }
  }
  if (oppAfter + 1e-9 < oppBefore && oppAfter <= 2.2) {
    return { amount: MICRO_REWARD_PULL * 0.85, reason: 'pull_pair' }
  }
  // Spam relocation / only "closer to self" — unpaid or tiny
  return null
}

function corpseNear(state: WorldState, bot: BotBody, radius: number): boolean {
  return state.organics.some((o) => o.kind === 'corpse' && dist(bot.pos, o.pos) <= radius)
}

/** True when savior can cover revive: pool≥cost OR corpse.locked≥cost (hungry revive). */
export function canCoverRevive(bot: BotBody, corpseLocked: number, cost = ACTION_COST.revive): boolean {
  const need = cost + REVIVE_SAFETY_MARGIN
  return bot.energy_pool + 1e-9 >= need || corpseLocked + 1e-9 >= need
}

/** Nearest corpse in view if pool≥cost OR locked≥cost (engine revive pressure). */
function reviveDutyCorpse(state: WorldState, bot: BotBody): Organic | null {
  const need = ACTION_COST.revive + REVIVE_SAFETY_MARGIN
  let best: Organic | null = null
  let bestD = Infinity
  for (const o of state.organics) {
    if (o.kind !== 'corpse' || !o.corpseOf) continue
    if (!canCoverRevive(bot, o.energy_locked, ACTION_COST.revive)) continue
    const d = dist(bot.pos, o.pos)
    if (d <= VIEW_RADIUS + o.radius && d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

/** Free particles within radius of pos. */
function localFreeParticles(state: WorldState, at: Vec2, radius: number): Particle[] {
  return freeParticles(state).filter((p) => dist(p.pos, at) <= radius + 1e-9)
}

export type CondenseMissing = 'yin' | 'yang' | 'both' | null

export type CondensePrereqInfo = {
  cost: number
  efficiency: number
  min_waste: number
  draw: number
  window_radius: number
  local_yin: number
  local_yang: number
  local_particles: number
  can_afford: boolean
  mix_ok: boolean
  missing: CondenseMissing
  nearest_opposite: { id: string; kind: 'yin' | 'yang'; dist: number } | null
  fail_streak: number
  cooldown_ticks_left: number
  prereq_ok: boolean
  prereq_reason?: string
  /** True when refusal should be REFUSED_CONDENSE_MIX (not other prereq). */
  refuse_mix: boolean
  refuse_cooldown: boolean
  /** True when pool < CONDENSE_STARVING_POOL — refuse condense, forage bite. */
  refuse_starving: boolean
  /** True when biteable clump(s) in view — eat before more condense. */
  refuse_clutter: boolean
}

/** Nearest free particle of a given kind (any distance). */
export function nearestFreeParticleOfKind(
  state: WorldState,
  at: Vec2,
  kind: 'yin' | 'yang',
): { id: string; kind: 'yin' | 'yang'; dist: number } | null {
  let best: { id: string; kind: 'yin' | 'yang'; dist: number } | null = null
  for (const p of freeParticles(state)) {
    if (p.kind !== kind) continue
    const d = dist(p.pos, at)
    if (!best || d < best.dist) best = { id: p.id, kind: p.kind, dist: Math.round(d * 1000) / 1000 }
  }
  return best
}

/** M0 condense prerequisites + mix teaching hooks for observe. */
export function evaluateCondensePrereqs(
  state: WorldState,
  bot: BotBody,
): CondensePrereqInfo {
  ensureCondenseFields(bot)
  const streak = bot.condenseFailStreak ?? 0
  const cooldownLeft = Math.max(0, (bot.condenseCooldownUntil ?? 0) - state.tick)
  const streakCost =
    Math.round(Math.min(3, Math.max(0, streak)) * CONDENSE_STREAK_COST_STEP * 1000) / 1000
  const cost = Math.round((ACTION_COST.condense + streakCost) * 1000) / 1000
  const locals = localFreeParticles(state, bot.pos, CONDENSE_WINDOW_RADIUS)
  let yin = 0
  let yang = 0
  for (const p of locals) {
    if (p.kind === 'yin') yin++
    else yang++
  }
  const needYin = yin < CONDENSE_MIN_YIN
  const needYang = yang < CONDENSE_MIN_YANG
  let missing: CondenseMissing = null
  if (needYin && needYang) missing = 'both'
  else if (needYin) missing = 'yin'
  else if (needYang) missing = 'yang'
  const mix_ok = missing === null
  let nearest_opposite: CondensePrereqInfo['nearest_opposite'] = null
  if (missing === 'yin' || missing === 'yang') {
    nearest_opposite = nearestFreeParticleOfKind(state, bot.pos, missing)
  } else if (missing === 'both') {
    const a = nearestFreeParticleOfKind(state, bot.pos, 'yin')
    const b = nearestFreeParticleOfKind(state, bot.pos, 'yang')
    if (a && b) nearest_opposite = a.dist <= b.dist ? a : b
    else nearest_opposite = a || b
  }
  const can_afford = bot.energy_pool + 1e-9 >= cost
  const base: Omit<CondensePrereqInfo, 'prereq_ok' | 'prereq_reason' | 'refuse_mix' | 'refuse_cooldown' | 'refuse_starving' | 'refuse_clutter'> & {
    refuse_mix: boolean
    refuse_cooldown: boolean
    refuse_starving: boolean
    refuse_clutter: boolean
  } = {
    cost,
    efficiency: CONDENSE_EFFICIENCY,
    min_waste: CONDENSE_MIN_WASTE,
    draw: CONDENSE_DRAW,
    window_radius: CONDENSE_WINDOW_RADIUS,
    local_yin: yin,
    local_yang: yang,
    local_particles: locals.length,
    can_afford,
    mix_ok,
    missing,
    nearest_opposite,
    fail_streak: streak,
    cooldown_ticks_left: cooldownLeft,
    refuse_mix: false,
    refuse_cooldown: false,
    refuse_starving: false,
    refuse_clutter: false,
  }
  if (bot.energy_pool + 1e-9 < CONDENSE_STARVING_POOL) {
    return {
      ...base,
      prereq_ok: false,
      refuse_starving: true,
      can_afford: false,
      prereq_reason: `pool ${bot.energy_pool} < starving floor ${CONDENSE_STARVING_POOL} — bite(clump)/digest/revive/move; condense REFUSED_CONDENSE_STARVING`,
    }
  }
  {
    const clutter = clumpInView(state, bot)
    if (clutter) {
      return {
        ...base,
        prereq_ok: false,
        refuse_clutter: true,
        prereq_reason: `clump ${clutter.id} in view (locked=${clutter.energy_locked}) — bite inventory before condense (REFUSED_CONDENSE_CLUTTER)`,
      }
    }
  }
  if (cooldownLeft > 0) {
    return {
      ...base,
      prereq_ok: false,
      refuse_cooldown: true,
      prereq_reason: `condense cooldown ${cooldownLeft}t left after ${streak} fails — pull/nudge opposite into r=${CONDENSE_WINDOW_RADIUS}`,
    }
  }
  if (!can_afford) {
    return { ...base, prereq_ok: false, prereq_reason: `pool ${bot.energy_pool} < condense ${cost}` }
  }
  if (state.waste_heat + 1e-9 < CONDENSE_MIN_WASTE) {
    return {
      ...base,
      prereq_ok: false,
      prereq_reason: `waste_heat ${state.waste_heat} < min ${CONDENSE_MIN_WASTE}`,
    }
  }
  if (!mix_ok) {
    const opp = nearest_opposite
      ? ` nearest_${nearest_opposite.kind}=${nearest_opposite.id}@${nearest_opposite.dist}`
      : ''
    return {
      ...base,
      prereq_ok: false,
      refuse_mix: true,
      prereq_reason: `need yin≥${CONDENSE_MIN_YIN} & yang≥${CONDENSE_MIN_YANG} in r=${CONDENSE_WINDOW_RADIUS} (have yin=${yin} yang=${yang}; missing=${missing})${opp}`,
    }
  }
  if (locals.length < CONDENSE_MIN_PARTICLES) {
    return {
      ...base,
      prereq_ok: false,
      prereq_reason: `need ≥${CONDENSE_MIN_PARTICLES} free particles nearby (have ${locals.length})`,
    }
  }
  return { ...base, prereq_ok: true }
}

function noteCondenseFail(state: WorldState, bot: BotBody): void {
  ensureCondenseFields(bot)
  bot.condenseFailStreak = (bot.condenseFailStreak ?? 0) + 1
  if (bot.condenseFailStreak >= CONDENSE_FAIL_COOLDOWN_AFTER) {
    bot.condenseCooldownUntil = state.tick + CONDENSE_COOLDOWN_TICKS
  }
}

function noteCondenseSuccess(bot: BotBody): void {
  ensureCondenseFields(bot)
  bot.condenseFailStreak = 0
  bot.condenseCooldownUntil = 0
}


function fruitPresent(state: WorldState): boolean {
  return state.organics.some((o) => o.kind === 'fruit' && o.energy_locked > 0.01)
}

/** Nearest living fruit (or null). */
function nearestFruit(state: WorldState, at: Vec2): Organic | null {
  let best: Organic | null = null
  let bestD = Infinity
  for (const o of state.organics) {
    if (o.kind !== 'fruit' || o.energy_locked <= 0.01) continue
    const d = dist(at, o.pos)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

/** True when bot is within bite/interact range of fruit. */
function adjacentToFruit(bot: BotBody, fruit: Organic): boolean {
  return dist(bot.pos, fruit.pos) <= fruit.radius + INTERACT_RADIUS + 1e-9
}



/** Research micro-ops: catalyze only if view has bond<1; else divert pull/adsorb. */
export function researchMicroOps(state: WorldState, bot: BotBody): WorldOp[] {
  const inView = state.particles.filter((p) => dist(p.pos, bot.pos) <= VIEW_RADIUS)
  const hasUnmaxed = inView.some((p) => (p.bond ?? 0) < 1 - 1e-9)
  if (hasUnmaxed) {
    return ['pull', 'adsorb', 'catalyze']
  }
  // All bonds maxed (or empty view): divert to pull/adsorb by mix / proximity
  const unboundNear = inView.filter((p) => !p.boundTo)
  const missing = evaluateCondensePrereqs(state, bot).missing
  if (missing === 'yin' || missing === 'yang' || missing === 'both') {
    // Mix prep: pull missing polarity first, then adsorb
    return ['pull', 'adsorb']
  }
  // Balanced / no mix pressure: prefer adsorb on unbound near, else pull
  return unboundNear.length ? ['adsorb', 'pull'] : ['pull', 'adsorb']
}



/** Post-fruit mix incomplete → prep gate (pull/nudge/move toward opposite only). */
export function mixPrepGateActive(state: WorldState, bot: BotBody): boolean {
  if (fruitPresent(state)) return false
  const pre = evaluateCondensePrereqs(state, bot)
  return !pre.mix_ok
}

function clumpInView(state: WorldState, bot: BotBody): Organic | null {
  let best: Organic | null = null
  let bestD = Infinity
  for (const o of state.organics) {
    if (o.kind !== 'clump' || o.energy_locked <= 0.01) continue
    const d = dist(bot.pos, o.pos)
    if (d <= VIEW_RADIUS + o.radius && d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

/** Cardinal/diagonal unit step that reduces distance to target (or null if none). */
function stepToward(from: Vec2, to: Vec2): Vec2 | null {
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  if (dx === 0 && dy === 0) return null
  return { x: dx, y: dy }
}

function moveReducesDist(from: Vec2, dir: Vec2, target: Vec2, width: number, height: number): boolean {
  const next = {
    x: clamp(from.x + dir.x, 0, width - 1),
    y: clamp(from.y + dir.y, 0, height - 1),
  }
  return dist(next, target) + 1e-9 < dist(from, target)
}


/** Compass label from `from` toward `to` (n/s/e/w/ne/…). */
export function compassDir(from: Vec2, to: Vec2): string {
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  if (dx === 0 && dy === 0) return 'here'
  if (dx === 0 && dy < 0) return 'n'
  if (dx === 0 && dy > 0) return 's'
  if (dy === 0 && dx > 0) return 'e'
  if (dy === 0 && dx < 0) return 'w'
  if (dx > 0 && dy < 0) return 'ne'
  if (dx < 0 && dy < 0) return 'nw'
  if (dx > 0 && dy > 0) return 'se'
  return 'sw'
}

/** Stage-aware mix-prep allow list (UX). Far=move-only; near=pull-only. */
const PREP_ALLOWED_FAR = 'move(dir+target_id 走近对面) · revive · digest · bite(clump)（饿时造团费从团付）— 太远拒 pull/nudge'
const PREP_ALLOWED_NEAR = 'pull(target_id=对面) · revive · digest · bite(clump)（饿时造团费从团付）— 齐窗距内拒 move/catalyze/nudge'
const PREP_ALLOWED = '远：只 move；近：只 pull · revive · digest · bite(clump)'

/** Human-readable REFUSED_CONDENSE_PREP message (UX only). */
function formatCondensePrepRefuse(
  bot: BotBody,
  state: WorldState,
  pre: CondensePrereqInfo,
  refusedOp: string,
  detail?: string,
): string {
  const yin = `阴${pre.local_yin}/${CONDENSE_MIN_YIN}`
  const yang = `阳${pre.local_yang}/${CONDENSE_MIN_YANG}`
  const mix = pre.mix_ok ? '已齐窗' : '未齐窗'
  let oppLine = '对面：暂无（场上无对应粒子）'
  if (pre.nearest_opposite) {
    const p = findParticle(state, pre.nearest_opposite.id)
    const dir = p ? compassDir(bot.pos, p.pos) : '?'
    oppLine = `对面：${pre.nearest_opposite.kind} ${pre.nearest_opposite.id} 方向=${dir} 距离=${pre.nearest_opposite.dist}`
  }
  const why = detail ? `；${detail}` : ''
  const allowed =
    pre.nearest_opposite && pre.nearest_opposite.dist > INTERACT_RADIUS
      ? PREP_ALLOWED_FAR
      : pre.nearest_opposite
        ? PREP_ALLOWED_NEAR
        : PREP_ALLOWED
  return (
    `齐窗未成（缺 ${pre.missing}；${yin} ${yang} — ${mix}）。` +
    `允许：${allowed}。` +
    `${oppLine}。` +
    `已拒：${refusedOp}${why}`
  )
}

function buildWindowProgress(
  bot: BotBody,
  state: WorldState,
  pre: CondensePrereqInfo,
): {
  label: '齐窗进度'
  yin: { have: number; need: number }
  yang: { have: number; need: number }
  mix_ok: boolean
  text: string
} {
  const yin = { have: pre.local_yin, need: CONDENSE_MIN_YIN }
  const yang = { have: pre.local_yang, need: CONDENSE_MIN_YANG }
  let opp = ''
  if (pre.nearest_opposite) {
    const p = findParticle(state, pre.nearest_opposite.id)
    const dir = p ? compassDir(bot.pos, p.pos) : '?'
    opp = `；对面 ${pre.nearest_opposite.kind} ${pre.nearest_opposite.id} 在${dir} d=${pre.nearest_opposite.dist}`
  }
  let status: string
  if (pre.mix_ok) {
    status = '已齐窗，可 condense'
  } else if (pre.nearest_opposite && pre.nearest_opposite.dist > INTERACT_RADIUS) {
    status = `未齐窗（缺 ${pre.missing}）— 远 d=${pre.nearest_opposite.dist}>${INTERACT_RADIUS}：只 move 走近再 pull`
  } else if (pre.nearest_opposite) {
    status = `未齐窗（缺 ${pre.missing}）— 近 d=${pre.nearest_opposite.dist}≤${INTERACT_RADIUS}：只 pull 对面`
  } else {
    status = `未齐窗（缺 ${pre.missing}）— 寻对面：move`
  }
  const text = `齐窗进度：阴${yin.have}/${yin.need} 阳${yang.have}/${yang.need} — ${status}${opp}`
  return { label: '齐窗进度', yin, yang, mix_ok: pre.mix_ok, text }
}


/** True if this relocate reverses the bot's previous pull/nudge on the same particle. */
export function isPullOscillation(
  bot: BotBody,
  particleId: string,
  from: Vec2,
  to: Vec2,
): boolean {
  if (bot.lastPullParticleId !== particleId || !bot.lastPullFrom || !bot.lastPullTo) return false
  return (
    bot.lastPullTo.x === from.x &&
    bot.lastPullTo.y === from.y &&
    bot.lastPullFrom.x === to.x &&
    bot.lastPullFrom.y === to.y
  )
}

function rememberPull(bot: BotBody, particleId: string, from: Vec2, to: Vec2): void {
  bot.lastPullParticleId = particleId
  bot.lastPullFrom = { ...from }
  bot.lastPullTo = { ...to }
  // Prep progress: decay condense fail streak so cooldown eases after arranging
  ensureCondenseFields(bot)
  if ((bot.condenseFailStreak ?? 0) > 0) {
    bot.condenseFailStreak = Math.max(0, (bot.condenseFailStreak ?? 0) - 1)
  }
}

function listSaviors(state: WorldState, corpsePos: Vec2, corpseLocked: number): ObserveSavior[] {
  const cost = ACTION_COST.revive
  const out: ObserveSavior[] = []
  for (const b of state.bots) {
    if (!b.alive) continue
    const d = Math.round(dist(b.pos, corpsePos) * 10) / 10
    const in_range = d <= REVIVE_RANGE + 1e-9
    const can_afford = canCoverRevive(b, corpseLocked, cost)
    out.push({
      actor_id: b.actorId,
      energy_pool: b.energy_pool,
      dist: d,
      in_range,
      can_afford,
      can_revive_now: in_range && can_afford,
    })
  }
  out.sort((a, b) => {
    if (a.can_revive_now !== b.can_revive_now) return a.can_revive_now ? -1 : 1
    if (a.can_afford !== b.can_afford) return a.can_afford ? -1 : 1
    return a.dist - b.dist
  })
  return out
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

  /** Larger teaching fruit (was 400). */
  const fruitEnergy = 560
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
      biteStreak: 0,
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

  const reviveCost = ACTION_COST.revive
  const corpses = state.organics
    .filter((o) => o.kind === 'corpse' && o.corpseOf)
    .map((o) => {
      const d = Math.round(dist(bot.pos, o.pos) * 10) / 10
      const in_range = d <= REVIVE_RANGE + 1e-9
      const self_can_afford = canCoverRevive(bot, o.energy_locked, reviveCost)
      const saviors = listSaviors(state, o.pos, o.energy_locked)
      const diedAt = typeof o.diedAtTick === 'number' ? o.diedAtTick : state.tick
      const ticks_unrevived = Math.max(0, state.tick - diedAt)
      const neglect_hardened = ticks_unrevived >= CORPSE_NEGLECT_HARDEN_TICKS
      const ticksLeftRough =
        o.energy_locked > 0 ? Math.ceil(o.energy_locked / CORPSE_LOCK_LEAK) : 0
      const inaction_cost =
        o.energy_locked > 0
          ? `locked ${o.energy_locked} stuck until revive; leaks ${CORPSE_LOCK_LEAK}/tick→waste (~${ticksLeftRough}t to empty); companion stays dead`
          : `locked=0 (husk); need waste top-up on next death or forage; revive costs ${reviveCost}`
      return {
        organic_id: o.id,
        corpse_of: o.corpseOf!,
        pos: { ...o.pos },
        energy_locked: o.energy_locked,
        revive_cost: reviveCost,
        dist: d,
        in_range,
        self_can_afford,
        self_can_revive_now: in_range && self_can_afford && bot.alive,
        saviors,
        inaction_cost,
        ticks_unrevived,
        neglect_hardened,
      }
    })

  const dying = state.bots
    .filter(
      (b) =>
        b.alive &&
        b.actorId !== bot.actorId &&
        (b.starveTicks >= 3 || b.core_integrity < 0.35 || b.energy_pool < 1),
    )
    .map((b) => ({
      actor_id: b.actorId,
      pos: { ...b.pos },
      energy_pool: b.energy_pool,
      core_integrity: b.core_integrity,
      starve_ticks: b.starveTicks,
      dist: Math.round(dist(bot.pos, b.pos) * 10) / 10,
    }))

  const alerts: string[] = []
  for (const c of corpses) {
    const whoNow = c.saviors.filter((s) => s.can_revive_now).map((s) => s.actor_id)
    const whoAfford = c.saviors
      .filter((s) => s.can_afford)
      .map((s) => `${s.actor_id}(pool=${s.energy_pool})`)
    const whoShould = (
      whoNow.length
        ? whoNow
        : c.saviors.filter((s) => s.can_afford).map((s) => s.actor_id)
    ).slice(0, 4)
    const saviorHint =
      whoNow.length > 0
        ? `can_revive_now=[${whoNow.join(',')}]`
        : `need pool≥${c.revive_cost} OR locked≥${c.revive_cost} (hungry_revive); afford=[${whoAfford.join(',') || 'none'}]`
    const base =
      `CORPSE ${c.corpse_of} id=${c.organic_id} @(${c.pos.x},${c.pos.y}) locked=${c.energy_locked} revive_cost=${c.revive_cost} unrevived=${c.ticks_unrevived}t dist=${c.dist} in_range=${c.in_range} self_afford=${c.self_can_afford} self_now=${c.self_can_revive_now} | ${saviorHint} | WAIT_COST: ${c.inaction_cost}`
    alerts.push(base)
    if (c.neglect_hardened) {
      const named = whoShould.length ? whoShould.join(',') : 'anyone_with_pool'
      alerts.unshift(
        `REVIVE_NEGLECT ${c.corpse_of} unrevived=${c.ticks_unrevived}t≥${CORPSE_NEGLECT_HARDEN_TICKS} — MUST revive: who=[${named}] cost=${c.revive_cost} else locked→waste + companion stays dead`,
      )
    }
    if (c.in_range) {
      alerts.unshift(
        `REVIVE_HARD ${c.corpse_of} adjacent dist=${c.dist} cost=${c.revive_cost} self_afford=${c.self_can_afford} self_now=${c.self_can_revive_now} — revive NOW (do not condense/wait/wander)`,
      )
    }
  }
  for (const d of dying) {
    alerts.push(
      `DYING ${d.actor_id} @(${d.pos.x},${d.pos.y}) pool=${d.energy_pool} core=${d.core_integrity} starve=${d.starve_ticks} — feed/help before corpse`,
    )
  }
  const fruitLockedEarly = state.organics
    .filter((o) => o.kind === 'fruit')
    .reduce((s, o) => s + o.energy_locked, 0)
  if (bot.energy_pool >= SATIETY_THRESHOLD && fruitLockedEarly > FRUIT_TAIL_THRESHOLD) {
    alerts.push(
      `SATIATED pool=${bot.energy_pool}≥${SATIETY_THRESHOLD} — fruit bite REFUSED_SATIATED; prefer revive/probe/config`,
    )
  } else if (bot.energy_pool >= SATIETY_THRESHOLD && fruitLockedEarly > 0) {
    alerts.push(
      `FRUIT_TAIL locked=${fruitLockedEarly}≤${FRUIT_TAIL_THRESHOLD} — thirst bite of remaining fruit allowed despite satiety`,
    )
  }
  const fruit_gone = !fruitPresent(state)
  if (fruit_gone) {
    alerts.unshift(
      `FRUIT_GONE — no living fruit; forage via condense (waste_heat→clump @${CONDENSE_EFFICIENCY * 100}% eff) or emergency corpse/clump bite (low yield, high waste)`,
    )
  }

  // Urgency + suggested ops: revive pinned when corpse present & affordable
  let urgency = 0
  const suggested_ops: WorldOp[] = []
  const duty = reviveDutyCorpse(state, bot)
  if (corpses.some((c) => c.in_range)) {
    urgency = Math.min(100, urgency + 95)
    // Hard pin revive when standing on/near corpse
    suggested_ops.length = 0
    if (corpses.some((c) => c.self_can_revive_now)) suggested_ops.push('revive')
    else if (corpses.some((c) => c.self_can_afford)) suggested_ops.push('revive')
    else suggested_ops.push('adsorb', 'bite', 'move') // earn then revive
  } else if (corpses.some((c) => c.self_can_revive_now)) {
    urgency += 90
    suggested_ops.push('revive')
  } else if (corpses.some((c) => c.self_can_afford)) {
    urgency += 70
    // Path then revive — move is first-class for locomotion toward corpse
    suggested_ops.push('move', 'revive')
  } else if (corpses.length) {
    urgency += 40
    suggested_ops.push('move', 'adsorb') // earn pool then revive
  }
  if (duty) {
    urgency = Math.min(100, urgency + 15)
    // Pin revive at top; keep move if not yet adjacent
    const pinned: WorldOp[] = duty && dist(bot.pos, duty.pos) > REVIVE_RANGE + 1e-9
      ? ['move', 'revive']
      : ['revive']
    for (const op of suggested_ops) {
      if (!pinned.includes(op)) pinned.push(op)
    }
    suggested_ops.length = 0
    suggested_ops.push(...pinned)
  }
  if (corpses.some((c) => c.neglect_hardened)) {
    urgency = Math.min(100, urgency + 25)
    if (!suggested_ops.includes('revive')) suggested_ops.unshift('revive')
  }
  if (dying.length) {
    urgency += 25
    if (!suggested_ops.includes('revive')) {
      // no revive yet — nudge toward help via wait denial; suggest adsorb/pull only if no corpse
    }
  }
  // Research sink soft-append: SATIETY stays fruit-bite only; research opens at pool≥6 or stomach≥4
  // (head-pin only after fruit_gone AND mix_ok AND !clutter/forage — see final RESEARCH_READY block)
  if (
    !duty &&
    (bot.energy_pool + 1e-9 >= RESEARCH_POOL_THRESHOLD ||
      bot.stomach + 1e-9 >= RESEARCH_STOMACH_THRESHOLD) &&
    !suggested_ops.includes('revive')
  ) {
    for (const op of researchMicroOps(state, bot)) {
      if (!suggested_ops.includes(op)) suggested_ops.push(op)
    }
    urgency = Math.max(urgency, 20)
  }
  if (bot.energy_pool < 5) {
    urgency += 40
    suggested_ops.unshift('bite', 'digest')
  }
  const condenseInfo = evaluateCondensePrereqs(state, bot)
  const fruitLocked = state.organics
    .filter((o) => o.kind === 'fruit')
    .reduce((s, o) => s + o.energy_locked, 0)
  const clumpsList = state.organics
    .filter((o) => o.kind === 'clump' && o.energy_locked > 0.01)
    .map((o) => ({ id: o.id, pos: { ...o.pos }, energy_locked: o.energy_locked }))
  const fruitNearlyGone = fruit_gone || fruitLocked <= FRUIT_NEARLY_GONE
  // Empty stomach when full — but never ahead of revive duty
  if (bot.stomach >= 2 && !suggested_ops.includes('digest')) {
    const revivePinned = suggested_ops[0] === 'revive'
    if (revivePinned) suggested_ops.splice(1, 0, 'digest')
    else suggested_ops.unshift('digest')
    urgency = Math.max(urgency, 28)
  }
  if (fruit_gone) {
    // Post-fruit: teach mix prep — two-stage nav (far=move / near=pull) when unbalanced
    urgency = Math.max(urgency, 40)
    if (condenseInfo.refuse_cooldown || (!condenseInfo.mix_ok && condenseInfo.fail_streak > 0)) {
      urgency = Math.max(urgency, 48)
    }
    // Hungry + clump: pin bite(clump) at top (wait hard-refused; starving blocks condense)
    if (clumpsList.length && bot.energy_pool < CLUMP_FORAGE_POOL_THRESHOLD) {
      urgency = Math.max(urgency, 55)
      alerts.unshift(
        `CLUMP_FORAGE pool=${bot.energy_pool}<${CLUMP_FORAGE_POOL_THRESHOLD} clumps=${clumpsList.length} — bite(clump) FIRST; wait REFUSED_CLUMP_WAIT; hungry bite pays cost from clump`,
      )
      // Pin bite at absolute top unless revive duty already owns slot 0
      const revivePinned = suggested_ops[0] === 'revive' || suggested_ops[0] === 'move'
      const rest = suggested_ops.filter((o) => o !== 'bite' && o !== 'digest')
      suggested_ops.length = 0
      if (revivePinned && (rest[0] === 'revive' || rest[0] === 'move')) {
        // keep revive/move head then bite
        const head: WorldOp[] = []
        if (rest[0] === 'move') head.push('move')
        if (rest.includes('revive')) head.push('revive')
        const tail = rest.filter((o) => !head.includes(o))
        suggested_ops.push(...head, 'bite', 'digest', ...tail)
      } else {
        suggested_ops.push('bite', 'digest', ...rest)
      }
    }
    if (condenseInfo.refuse_starving) {
      alerts.unshift(
        `STARVING pool=${bot.energy_pool}<${CONDENSE_STARVING_POOL} — condense REFUSED_CONDENSE_STARVING; bite(clump)/digest/revive/move only`,
      )
      // strip condense from suggestions
      const stripped = suggested_ops.filter((o) => o !== 'condense')
      suggested_ops.length = 0
      suggested_ops.push(...stripped)
    } else if (condenseInfo.prereq_ok && !condenseInfo.refuse_clutter) {
      // Never ahead of bite when foraging clumps / starving
      if (!suggested_ops.includes('condense')) {
        if (
          clumpsList.length &&
          bot.energy_pool < CLUMP_FORAGE_POOL_THRESHOLD &&
          suggested_ops.includes('bite')
        ) {
          suggested_ops.push('condense')
        } else {
          suggested_ops.unshift('condense')
        }
      }
    } else if (!condenseInfo.mix_ok || condenseInfo.refuse_cooldown) {
      // Two-stage nav: far → only move; near → only pull (never pin both)
      const opp = condenseInfo.nearest_opposite
      const oppFar = !opp || opp.dist > INTERACT_RADIUS
      const pinned: WorldOp[] = oppFar ? ['move'] : ['pull']
      {
        const wp = buildWindowProgress(bot, state, condenseInfo)
        alerts.push(wp.text)
        if (opp) {
          const pOpp = findParticle(state, opp.id)
          const needDir = pOpp ? compassDir(bot.pos, pOpp.pos) : '?'
          if (oppFar) {
            alerts.push(
              `PREP_NAV far d=${opp.dist}>${INTERACT_RADIUS} — suggested=move dir=${needDir} target_id=${opp.id}（走近再 pull）；拒 pull/nudge`,
            )
            alerts.push(`允许动作：${PREP_ALLOWED_FAR}；dir=${needDir} target_id=${opp.id}`)
          } else {
            alerts.push(
              `PREP_NAV near d=${opp.dist}≤${INTERACT_RADIUS} — suggested=pull target_id=${opp.id}；拒 move/catalyze/nudge`,
            )
            alerts.push(`允许动作：${PREP_ALLOWED_NEAR}；target_id=${opp.id}`)
          }
        } else {
          alerts.push(`允许动作：move（寻对面）· revive · digest · bite(clump)`)
        }
      }
      if (condenseInfo.cooldown_ticks_left > 0) {
        alerts.push(
          `CONDENSE_COOLDOWN ${condenseInfo.cooldown_ticks_left}t — arrange mix; empty smash blocked`,
        )
      }
      const reviveFirst = suggested_ops[0] === 'revive'
      const head: WorldOp[] = []
      if (reviveFirst) head.push('revive')
      // Hungry forage: bite stays ahead of mix-prep move/pull
      if (suggested_ops.includes('bite') && bot.energy_pool < CLUMP_FORAGE_POOL_THRESHOLD) {
        if (!head.includes('bite')) head.push('bite')
        if (suggested_ops.includes('digest') && !head.includes('digest')) head.push('digest')
      }
      const rest = suggested_ops.filter(
        (o) =>
          !head.includes(o) &&
          o !== 'condense' &&
          o !== 'pull' &&
          o !== 'nudge' &&
          o !== 'move' &&
          o !== 'wait',
      )
      suggested_ops.length = 0
      suggested_ops.push(...head, ...pinned, ...rest)
    } else {
      for (const op of ['pull', 'nudge', 'move'] as WorldOp[]) {
        if (!suggested_ops.includes(op)) suggested_ops.push(op)
      }
    }
  } else if (fruitNearlyGone) {
    // Tail fruit still present: finish fruit (bite/digest) before condensing
    urgency = Math.max(urgency, 30)
    if (!suggested_ops.includes('bite')) suggested_ops.unshift('bite')
    if (bot.stomach >= 1 && !suggested_ops.includes('digest')) suggested_ops.unshift('digest')
    // Soft hint condense only if prereq already ok — do not drown bite
    if (condenseInfo.prereq_ok && !suggested_ops.includes('condense')) {
      suggested_ops.push('condense')
    }
  } else if (clumpsList.length && bot.energy_pool < CLUMP_FORAGE_POOL_THRESHOLD) {
    // Mid-game: clumps available, pool low — elevate bite; starving pins bite top
    if (bot.energy_pool + 1e-9 < CONDENSE_STARVING_POOL) {
      urgency = Math.max(urgency, 50)
      alerts.unshift(
        `STARVING pool=${bot.energy_pool}<${CONDENSE_STARVING_POOL} clumps=${clumpsList.length} — bite(clump) FIRST (condense refused)`,
      )
      const rest = suggested_ops.filter((o) => o !== 'bite' && o !== 'condense')
      suggested_ops.length = 0
      suggested_ops.push('bite', ...rest)
    } else if (!suggested_ops.includes('bite')) {
      suggested_ops.unshift('bite')
    }
    urgency = Math.max(urgency, 25)
  }

  // Research threshold sink (no corpse duty):
  // - fruit era: tail-append only (never ahead of bite/digest)
  // - fruit_gone + (!mix_ok OR clump forage OR clutter): tail-append only — prep/bite keep head
  // - fruit_gone + mix_ok + !refuse_clutter + no forage pressure: research may head-pin
  // SATIETY_THRESHOLD remains fruit-bite only. REFUSED_CATALYZE_MAXED stays global.
  if (
    !duty &&
    (bot.energy_pool + 1e-9 >= RESEARCH_POOL_THRESHOLD ||
      bot.stomach + 1e-9 >= RESEARCH_STOMACH_THRESHOLD)
  ) {
    urgency = Math.max(urgency, 26)
    const research = researchMicroOps(state, bot)
    const researchLabel = research.join('/')
    const needClumpBite =
      clumpsList.length > 0 && bot.energy_pool < CLUMP_FORAGE_POOL_THRESHOLD
    const allowResearchHead =
      fruit_gone &&
      condenseInfo.mix_ok &&
      !condenseInfo.refuse_clutter &&
      !needClumpBite
    if (allowResearchHead) {
      alerts.unshift(
        `RESEARCH_READY fruit_gone mix_ok — head-pin ${researchLabel} (pool≥${RESEARCH_POOL_THRESHOLD}/stomach≥${RESEARCH_STOMACH_THRESHOLD}; satiety ${SATIETY_THRESHOLD}=fruit-bite only; catalyze iff bond<1 in view)`,
      )
      const head: WorldOp[] = []
      // Starving forage still wins over research
      if (
        bot.energy_pool + 1e-9 < CONDENSE_STARVING_POOL &&
        suggested_ops.includes('bite')
      ) {
        head.push('bite')
        if (suggested_ops.includes('digest')) head.push('digest')
      }
      const rest = suggested_ops.filter(
        (o) => !head.includes(o) && !research.includes(o) && o !== 'condense' && o !== 'wait',
      )
      suggested_ops.length = 0
      suggested_ops.push(...head, ...research)
      if (bot.stomach >= 1 && !suggested_ops.includes('digest')) suggested_ops.push('digest')
      for (const o of rest) {
        if (!suggested_ops.includes(o)) suggested_ops.push(o)
      }
    } else if (fruit_gone) {
      // 齐窗未成 / clutter / clump forage — research below mix-prep; do not overwrite prep head
      const why = !condenseInfo.mix_ok
        ? 'mix_incomplete'
        : needClumpBite
          ? 'clump_forage'
          : 'clutter'
      alerts.unshift(
        `RESEARCH_READY fruit_gone ${why} — tail-append ${researchLabel} (prep/bite keep head; research below mix-prep)`,
      )
      for (const op of research) {
        if (!suggested_ops.includes(op)) suggested_ops.push(op)
      }
    } else {
      // Fruit era: tail-append only — do not rebuild suggested with research at head
      alerts.unshift(
        `RESEARCH_READY fruit-era — tail-append ${researchLabel} (no head-pin until FRUIT_GONE; bite/digest keep priority; satiety ${SATIETY_THRESHOLD}=fruit-bite only)`,
      )
      for (const op of research) {
        if (!suggested_ops.includes(op)) suggested_ops.push(op)
      }
    }
  }

  // Clutter: never suggest condense when biteable clumps in view
  if (condenseInfo.refuse_clutter) {
    alerts.unshift(
      `CONDENSE_CLUTTER — bite clump(s) in view before making more (REFUSED_CONDENSE_CLUTTER)`,
    )
    const stripped = suggested_ops.filter((o) => o !== 'condense')
    suggested_ops.length = 0
    suggested_ops.push(...stripped)
  }

  // Fruit-era forage pin: hungry + fruit present + not adjacent → only move toward fruit.
  // Revive duty / digest / in-range fruit bite still win when applicable.
  if (!fruit_gone && bot.energy_pool + 1e-9 < SATIETY_THRESHOLD) {
    const fruitOrg = nearestFruit(state, bot.pos)
    if (fruitOrg && !adjacentToFruit(bot, fruitOrg)) {
      const dFruit = Math.round(dist(bot.pos, fruitOrg.pos) * 10) / 10
      const adjR = Math.round((fruitOrg.radius + INTERACT_RADIUS) * 10) / 10
      const needDir = compassDir(bot.pos, fruitOrg.pos)
      alerts.unshift(
        `FRUIT_FORAGE pool=${bot.energy_pool}<${SATIETY_THRESHOLD} d=${dFruit}>${adjR} — suggested=move dir=${needDir} fruit_id=${fruitOrg.id}；拒 wait/catalyze (REFUSED_FRUIT_FORAGE)；pool<move 时 hungry_move 从废热付`,
      )
      if (duty) {
        // Revive duty keeps existing pin (move/revive); only alert forage
        urgency = Math.max(urgency, 62)
      } else {
        const head: WorldOp[] = []
        // Digest still wins when stomach has buffer
        if (bot.stomach >= 1 && suggested_ops.includes('digest')) head.push('digest')
        // In-range fruit bite cannot apply here (not adjacent)
        suggested_ops.length = 0
        suggested_ops.push(...head, 'move')
        urgency = Math.max(urgency, 62)
      }
    }
  }

  urgency = clamp(urgency, 0, 100)

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
      bite_streak: bot.biteStreak ?? 0,
      ...(bot.biteStreakTargetId ? { bite_streak_target_id: bot.biteStreakTargetId } : {}),
      satiety_threshold: SATIETY_THRESHOLD,
    },
    view: { radius, particles },
    organics,
    corpses,
    dying,
    alerts,
    suggested_ops,
    urgency,
    action_costs: { ...ACTION_COST },
    revive_cost: reviveCost,
    satiety_threshold: SATIETY_THRESHOLD,
    waste_heat: state.waste_heat,
    fruit: { energy_locked: Math.round(fruitLocked * 1000) / 1000, gone: fruit_gone },
    fruit_gone,
    clumps: clumpsList,
    ...(() => {
      const wp = buildWindowProgress(bot, state, condenseInfo)
      const opp = condenseInfo.nearest_opposite
        ? (() => {
            const p = findParticle(state, condenseInfo.nearest_opposite!.id)
            return {
              ...condenseInfo.nearest_opposite,
              ...(p ? { dir: compassDir(bot.pos, p.pos) } : {}),
            }
          })()
        : null
      return {
        '齐窗进度': wp,
        condense: {
      ok: condenseInfo.prereq_ok,
      need_yin: CONDENSE_MIN_YIN,
      need_yang: CONDENSE_MIN_YANG,
      local_yin: condenseInfo.local_yin,
      local_yang: condenseInfo.local_yang,
      have_yin: condenseInfo.local_yin,
      have_yang: condenseInfo.local_yang,
      missing: condenseInfo.missing,
      nearest_opposite: opp,
      mix_ok: condenseInfo.mix_ok,
      window_progress: wp,
      est_gain: condenseInfo.mix_ok
        ? Math.round(
            Math.min(condenseInfo.draw, Math.max(0, state.waste_heat)) *
              condenseInfo.efficiency *
              1000,
          ) / 1000
        : 0,
      cost: condenseInfo.cost,
      efficiency: condenseInfo.efficiency,
      min_waste: condenseInfo.min_waste,
      draw: condenseInfo.draw,
      window_radius: condenseInfo.window_radius,
      local_particles: condenseInfo.local_particles,
      can_afford: condenseInfo.can_afford,
      prereq_ok: condenseInfo.prereq_ok,
      fail_streak: condenseInfo.fail_streak,
      cooldown_ticks_left: condenseInfo.cooldown_ticks_left,
      ...(condenseInfo.prereq_reason ? { prereq_reason: condenseInfo.prereq_reason } : {}),
        },
      }
    })(),
    events_recent,
    last_errors: [...bot.last_errors],
  }
}


function reject(
  state: WorldState,
  receipt: ActReceipt,
  bot: BotBody,
  idx: number,
  code: ActRejectCode,
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  receipt.rejected.push({ idx, code, msg })
  recordError(bot, code, msg)
  // Design telemetry: satiety (and selected codes) must land in events / world.json
  if (TELEMETRY_REJECT_CODES.has(code)) {
    // REFUSED_* → lowercase event name (refused_satiated / refused_revive_wait / …)
    const type = code.toLowerCase()
    pushEvent(state, type, {
      actor: bot.actorId,
      code,
      msg,
      energy_pool: bot.energy_pool,
      ...(code === 'REFUSED_SATIATED' ? { threshold: SATIETY_THRESHOLD } : {}),
      ...extra,
    })
  }
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
    reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'bot is dead (corpse); needs revive')
    return
  }
  ensureBiteFields(bot)
  ensureCondenseFields(bot)
  const op = action.op
  if (!op || !(op in ACTION_COST)) {
    reject(state, receipt, bot, idx, 'ILLEGAL_OP', `unknown op: ${String(op)}`)
    return
  }
  // Precompute bite cost from streak (before budget/energy gates)
  let cost = ACTION_COST[op]
  if (op === 'condense') {
    // Escalating cost from fail streak (teach: stop empty smash)
    const preCost = evaluateCondensePrereqs(state, bot)
    cost = preCost.cost
  }
  if (op === 'bite' && action.target_id) {
    const prior =
      bot.biteStreakTargetId === action.target_id ? bot.biteStreak : 0
    cost = biteCostForStreak(prior)
  }
  if (budgetLeft.n + 1e-9 < cost) {
    reject(state, receipt, bot, idx, 'BUDGET_EXCEEDED', `need ${cost}, budget left ${budgetLeft.n}`)
    return
  }
  // Hunger knife: refuse condense before generic NO_ENERGY so code is STARVING not NO_ENERGY.
  if (op === 'condense' && bot.energy_pool + 1e-9 < CONDENSE_STARVING_POOL) {
    const preStarv = evaluateCondensePrereqs(state, bot)
    pushEvent(state, 'condense_fail', {
      actor: bot.actorId,
      reason: preStarv.prereq_reason,
      refuse_starving: true,
      pool: bot.energy_pool,
      starving_floor: CONDENSE_STARVING_POOL,
      waste_heat: state.waste_heat,
    })
    reject(
      state,
      receipt,
      bot,
      idx,
      'REFUSED_CONDENSE_STARVING',
      preStarv.prereq_reason || `pool < ${CONDENSE_STARVING_POOL}`,
      {
        pool: bot.energy_pool,
        starving_floor: CONDENSE_STARVING_POOL,
        allowed: 'bite(clump) / digest / revive / move',
      },
    )
    return
  }
  // Hungry bite(clump) / hungry revive: cost may be paid from organic locked energy.
  const hungryClumpBite =
    op === 'bite' &&
    Boolean(action.target_id) &&
    state.organics.some(
      (o) => o.id === action.target_id && o.kind === 'clump' && o.energy_locked > 0.01,
    )
  const hungryReviveOk =
    op === 'revive' &&
    Boolean(action.target_id) &&
    state.organics.some((o) => {
      if (o.id !== action.target_id || o.kind !== 'corpse') return false
      const shortfall = Math.max(0, Math.round((cost - bot.energy_pool) * 1000) / 1000)
      return o.energy_locked + 1e-9 >= shortfall
    })
  // Hungry move: pay shortfall from waste_heat (top-up then spend; no mint)
  const hungryMoveOk =
    op === 'move' &&
    bot.energy_pool + 1e-9 < cost &&
    state.waste_heat + bot.energy_pool + 1e-9 >= cost
  if (
    bot.energy_pool + 1e-9 < cost &&
    op !== 'digest' &&
    !hungryClumpBite &&
    !hungryReviveOk &&
    !hungryMoveOk
  ) {
    reject(state, receipt, bot, idx, 'NO_ENERGY', `pool ${bot.energy_pool} < cost ${cost}`)
    return
  }


  // --- Fruit-era forage: refuse wait/catalyze when hungry and not adjacent to fruit ---
  // Revive duty still wins (no refuse when corpse duty active).
  {
    if (fruitPresent(state) && bot.energy_pool + 1e-9 < SATIETY_THRESHOLD) {
      const fruitOrg = nearestFruit(state, bot.pos)
      if (fruitOrg && !adjacentToFruit(bot, fruitOrg) && !reviveDutyCorpse(state, bot)) {
        if (op === 'wait' || op === 'catalyze') {
          const needDir = compassDir(bot.pos, fruitOrg.pos)
          const dFruit = Math.round(dist(bot.pos, fruitOrg.pos) * 10) / 10
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_FRUIT_FORAGE',
            `fruit ${fruitOrg.id} still present; pool ${bot.energy_pool}<${SATIETY_THRESHOLD} d=${dFruit} — move dir=${needDir} fruit_id=${fruitOrg.id} (not ${op})`,
            {
              fruit_id: fruitOrg.id,
              dir: needDir,
              pool: bot.energy_pool,
              dist: dFruit,
              refused_op: op,
              allowed: 'move / digest / bite(fruit in range) / revive',
            },
          )
          return
        }
      }
    }
  }

  // --- Mix-prep hard gate (post-fruit, window unbalanced) ---
  // Revive duty always wins; digest + bite(clump) when foraging still allowed.
  {
    const fruitGone = !fruitPresent(state)
    const preGate = fruitGone ? evaluateCondensePrereqs(state, bot) : null
    const mixPrep = Boolean(fruitGone && preGate && !preGate.mix_ok)
    const clumpView = clumpInView(state, bot)
    const hungryClump =
      Boolean(clumpView) && bot.energy_pool < CLUMP_FORAGE_POOL_THRESHOLD

    if (op === 'wait' && hungryClump && !reviveDutyCorpse(state, bot)) {
      reject(
        state,
        receipt,
        bot,
        idx,
        'REFUSED_CLUMP_WAIT',
        `clump ${clumpView!.id} in view (locked=${clumpView!.energy_locked}) and pool ${bot.energy_pool}<${CLUMP_FORAGE_POOL_THRESHOLD} — bite(clump) not wait`,
        {
          clump: clumpView!.id,
          energy_locked: clumpView!.energy_locked,
          pool: bot.energy_pool,
        },
      )
      return
    }

    if (mixPrep) {
      const opp = preGate!.nearest_opposite
      const missing = preGate!.missing
      const oppDist = opp?.dist ?? Infinity
      const oppFar = !opp || oppDist > INTERACT_RADIUS
      const prepStage = oppFar ? 'far' : 'near'
      const allowedList = oppFar ? PREP_ALLOWED_FAR : PREP_ALLOWED_NEAR
      const pOpp = opp ? findParticle(state, opp.id) : undefined
      const suggestedDir = pOpp ? compassDir(bot.pos, pOpp.pos) : undefined
      const allowedAlways = op === 'revive' || op === 'digest'
      const biteClumpOk =
        op === 'bite' &&
        action.target_id &&
        state.organics.some(
          (o) => o.id === action.target_id && o.kind === 'clump' && o.energy_locked > 0.01,
        )
      const prepExtra = {
        missing,
        nearest_opposite: opp,
        local_yin: preGate!.local_yin,
        local_yang: preGate!.local_yang,
        opp_dist: opp ? oppDist : null,
        prep_stage: prepStage,
        ...(suggestedDir ? { suggested_dir: suggestedDir } : {}),
        ...(opp ? { target_id: opp.id } : {}),
        allowed: allowedList,
      }
      if (allowedAlways || biteClumpOk) {
        // pass through
      } else if (oppFar) {
        // FAR: only move toward opp; refuse pull/nudge (too far for interact)
        if (op === 'pull' || op === 'nudge') {
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_CONDENSE_PREP',
            formatCondensePrepRefuse(
              bot,
              state,
              preGate!,
              op,
              `对面太远 d=${oppDist}>${INTERACT_RADIUS} — 先 move${suggestedDir ? ` dir=${suggestedDir}` : ''}${opp ? ` target_id=${opp.id}` : ''} 走近再 pull`,
            ),
            { ...prepExtra, refused_op: op },
          )
          return
        } else if (op === 'move') {
          const dir = parseDir(action.dir)
          if (!opp) {
            // no opposite particle in world — allow move to search
          } else if (!dir || (dir.x === 0 && dir.y === 0)) {
            reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'dir required for move')
            return
          } else if (
            pOpp &&
            !moveReducesDist(bot.pos, dir, pOpp.pos, state.width, state.height)
          ) {
            const needDir = suggestedDir || compassDir(bot.pos, pOpp.pos)
            reject(
              state,
              receipt,
              bot,
              idx,
              'REFUSED_CONDENSE_PREP',
              formatCondensePrepRefuse(
                bot,
                state,
                preGate!,
                'move',
                `请朝 ${needDir} 走近 ${opp.kind} ${opp.id}（不要往反方向）`,
              ),
              {
                ...prepExtra,
                dir: action.dir,
                suggested_dir: needDir,
                refused_op: 'move',
              },
            )
            return
          }
        } else if (op === 'condense') {
          // fall through to condense case (REFUSED_CONDENSE_MIX / cooldown)
        } else {
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_CONDENSE_PREP',
            formatCondensePrepRefuse(
              bot,
              state,
              preGate!,
              op,
              `远距阶段只允许 move${suggestedDir ? ` dir=${suggestedDir}` : ''}${opp ? ` →${opp.id}` : ''}`,
            ),
            { ...prepExtra, refused_op: op },
          )
          return
        }
      } else {
        // NEAR: only pull pinned opp; refuse move/catalyze/nudge
        if (op === 'pull') {
          const target = action.target_id ? findParticle(state, action.target_id) : undefined
          const kindOk =
            target &&
            !target.boundTo &&
            (missing === 'both'
              ? true
              : missing === 'yin' || missing === 'yang'
                ? target.kind === missing
                : false)
          const idOk = opp ? target && target.id === opp.id : kindOk
          if (!target || (!kindOk && !idOk)) {
            reject(
              state,
              receipt,
              bot,
              idx,
              'REFUSED_CONDENSE_PREP',
              formatCondensePrepRefuse(
                bot,
                state,
                preGate!,
                'pull',
                `请 pull 对面 ${opp ? `${opp.kind} ${opp.id}` : '粒子'}（target_id 钉死），不要拉同极`,
              ),
              { ...prepExtra, refused_op: 'pull' },
            )
            return
          }
        } else if (op === 'move' || op === 'nudge' || op === 'catalyze') {
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_CONDENSE_PREP',
            formatCondensePrepRefuse(
              bot,
              state,
              preGate!,
              op,
              `已进距 d=${oppDist}≤${INTERACT_RADIUS} — 只 pull target_id=${opp!.id}（拒 ${op}）`,
            ),
            { ...prepExtra, refused_op: op },
          )
          return
        } else if (op === 'condense') {
          // fall through
        } else {
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_CONDENSE_PREP',
            formatCondensePrepRefuse(
              bot,
              state,
              preGate!,
              op,
              `近距阶段只允许 pull target_id=${opp!.id}`,
            ),
            { ...prepExtra, refused_op: op },
          )
          return
        }
      }
    }
  }

  switch (op) {
    case 'wait': {
      const duty = reviveDutyCorpse(state, bot)
      if (duty) {
        reject(
          state,
          receipt,
          bot,
          idx,
          'REFUSED_REVIVE_WAIT',
          `corpse ${duty.id} (${duty.corpseOf}) in view; can_cover revive (pool ${bot.energy_pool} or locked ${duty.energy_locked} ≥${ACTION_COST.revive}+${REVIVE_SAFETY_MARGIN}) — must move/revive not wait`,
          {
            corpse: duty.id,
            corpse_of: duty.corpseOf,
            revive_cost: ACTION_COST.revive,
            safety_margin: REVIVE_SAFETY_MARGIN,
            dist: Math.round(dist(bot.pos, duty.pos) * 10) / 10,
          },
        )
        return
      }
      if (!spend(bot, cost)) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'cannot wait')
        return
      }
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      // wait_neglect ONLY when a corpse is in view — dying-alone must not spam
      const nearCorpse = corpseNear(state, bot, VIEW_RADIUS)
      pushEvent(state, 'wait', {
        actor: bot.actorId,
        neglect: nearCorpse || undefined,
      })
      // wait never pays micro_reward (wait_steady cancelled — no lying-flat income)
      if (nearCorpse) {
        pushEvent(state, 'wait_neglect', {
          actor: bot.actorId,
          msg: 'wait near corpse — no micro_reward; prefer revive',
        })
      }
      return
    }
    case 'nudge':
    case 'pull': {
      const target = action.target_id ? findParticle(state, action.target_id) : undefined
      if (!target || target.boundTo) {
        reject(state, receipt, bot, idx, 'TARGET_GONE', 'particle missing or bound')
        return
      }
      if (dist(bot.pos, target.pos) > INTERACT_RADIUS + 0.1) {
        reject(state, receipt, bot, idx, 'NOT_ADJACENT', 'target not adjacent')
        return
      }
      const dir = parseDir(action.dir) || (op === 'pull'
        ? {
            x: Math.sign(bot.pos.x - target.pos.x) || 0,
            y: Math.sign(bot.pos.y - target.pos.y) || 0,
          }
        : null)
      if (!dir || (dir.x === 0 && dir.y === 0)) {
        reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'dir required (n/s/e/w/…)')
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
        reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'destination occupied')
        return
      }
      if (!spend(bot, cost)) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'pool empty')
        return
      }
      const from = { x: target.pos.x, y: target.pos.y }
      const moved = from.x !== next.x || from.y !== next.y
      target.pos = next
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      pushEvent(state, op, { actor: bot.actorId, particle: target.id, to: next, from })
      // Config progress only; oscillating A↔B on same particle unpaid
      if (moved) {
        const oscillating = isPullOscillation(bot, target.id, from, next)
        if (oscillating) {
          pushEvent(state, 'pull_oscillation', {
            actor: bot.actorId,
            particle: target.id,
            from,
            to: next,
            msg: 'back-forth pull — no micro_reward',
          })
        } else {
          const scored = scorePullConfig(state, target, from, next)
          if (scored) {
            grantMicroReward(state, bot, scored.amount, scored.reason, {
              particle: target.id,
              op,
            })
          } else {
            const closer = dist(bot.pos, next) + 1e-9 < dist(bot.pos, from)
            if (closer && op === 'pull') {
              grantMicroReward(state, bot, MICRO_REWARD_PULL_CLOSER, 'pull_closer', {
                particle: target.id,
                op,
              })
            }
          }
        }
        rememberPull(bot, target.id, from, next)
      }
      return
    }
    case 'adsorb': {
      const target = action.target_id ? findParticle(state, action.target_id) : undefined
      if (!target || target.boundTo) {
        reject(state, receipt, bot, idx, 'TARGET_GONE', 'particle missing or already bound')
        return
      }
      if (dist(bot.pos, target.pos) > INTERACT_RADIUS + 0.1) {
        reject(state, receipt, bot, idx, 'NOT_ADJACENT', 'target not adjacent')
        return
      }
      if (bot.bound_particle_ids.length >= 6) {
        reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'bound capacity full')
        return
      }
      if (!spend(bot, cost)) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'pool empty')
        return
      }
      // Balance: adsorbing opposite kind vs already-bound free-ish core kinds
      let yin = 0
      let yang = 0
      for (const pid of bot.bound_particle_ids) {
        const bp = findParticle(state, pid)
        if (!bp) continue
        if (bp.kind === 'yin') yin++
        else yang++
      }
      const balances =
        (target.kind === 'yin' && yang > yin) || (target.kind === 'yang' && yin > yang)
      target.boundTo = bot.actorId
      target.pos = { ...bot.pos }
      target.bond = clamp((target.bond ?? 0.2) + 0.15, 0, 1)
      bot.bound_particle_ids.push(target.id)
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      pushEvent(state, 'adsorb', {
        actor: bot.actorId,
        particle: target.id,
        bond: target.bond,
        balances,
      })
      const amt = balances ? MICRO_REWARD_ADSORB_BALANCE : MICRO_REWARD_ADSORB
      const reason = balances ? 'adsorb_balance' : 'adsorb_bound'
      grantMicroReward(state, bot, amt, reason, { particle: target.id, bond: target.bond })
      return
    }
    case 'catalyze': {
      const target = action.target_id ? findParticle(state, action.target_id) : undefined
      if (!target) {
        reject(state, receipt, bot, idx, 'TARGET_GONE', 'particle missing')
        return
      }
      if (dist(bot.pos, target.pos) > INTERACT_RADIUS + 1) {
        reject(state, receipt, bot, idx, 'NOT_ADJACENT', 'too far')
        return
      }
      const bondNow = target.bond ?? 0
      if (bondNow >= 1 - 1e-9) {
        reject(
          state,
          receipt,
          bot,
          idx,
          'REFUSED_CATALYZE_MAXED',
          `particle ${target.id} bond=${bondNow}≥1 — catalyze maxed; pull/adsorb instead`,
          { particle: target.id, bond: bondNow },
        )
        return
      }
      if (!spend(bot, cost)) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'pool empty')
        return
      }
      const bondBefore = target.bond ?? 0.2
      target.bond = clamp(bondBefore + 0.25, 0, 1)
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      pushEvent(state, 'catalyze', { actor: bot.actorId, particle: target.id, bond: target.bond })
      if (target.bond > bondBefore + 1e-9) {
        grantMicroReward(state, bot, MICRO_REWARD_CATALYZE, 'catalyze_bond', {
          particle: target.id,
          bond: target.bond,
        })
      }
      return
    }
    case 'bite': {
      const org = action.target_id ? findOrganic(state, action.target_id) : undefined
      if (!org || org.energy_locked <= 0) {
        reject(state, receipt, bot, idx, 'TARGET_GONE', 'organic missing or empty')
        return
      }
      if (dist(bot.pos, org.pos) > org.radius + INTERACT_RADIUS) {
        reject(state, receipt, bot, idx, 'NOT_ADJACENT', 'not close enough to bite')
        return
      }
      // Revive duty first (corpse in view + can afford): blocks non-starve bite before satiety
      if (org.kind !== 'corpse') {
        const duty = reviveDutyCorpse(state, bot)
        if (duty) {
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_REVIVE_BITE',
            `corpse ${duty.id} (${duty.corpseOf}) in view; can_cover revive (pool ${bot.energy_pool} or locked ${duty.energy_locked} ≥${ACTION_COST.revive}+${REVIVE_SAFETY_MARGIN}) — revive before biting ${org.kind} ${org.id}`,
            {
              corpse: duty.id,
              corpse_of: duty.corpseOf,
              revive_cost: ACTION_COST.revive,
              safety_margin: REVIVE_SAFETY_MARGIN,
              organic: org.id,
              kind: org.kind,
            },
          )
          return
        }
      }
      // Satiety: refuse fruit hoarding unless fruit is in tail (thirst bite allowed)
      if (
        org.kind === 'fruit' &&
        bot.energy_pool >= SATIETY_THRESHOLD &&
        org.energy_locked > FRUIT_TAIL_THRESHOLD
      ) {
        reject(
          state,
          receipt,
          bot,
          idx,
          'REFUSED_SATIATED',
          `energy_pool ${bot.energy_pool} >= satiety ${SATIETY_THRESHOLD}; probe/nudge/revive instead of hoarding fruit`,
          { organic: org.id, kind: org.kind },
        )
        return
      }
      const priorStreak = bot.biteStreakTargetId === org.id ? bot.biteStreak : 0
      const biteCost = cost
      let yieldCap = biteYieldForStreak(priorStreak)
      let wasteFrac = 0
      let coreDmg = 0
      // Post-fruit emergency: corpse/clump bites are low-yield / high-waste
      if (org.kind === 'corpse') {
        yieldCap = Math.round(yieldCap * CORPSE_BITE_YIELD_MUL * 1000) / 1000
        wasteFrac = CORPSE_BITE_WASTE_FRAC
        coreDmg = CORPSE_BITE_CORE_DAMAGE
      } else if (org.kind === 'clump') {
        yieldCap = Math.round(yieldCap * CLUMP_BITE_YIELD_MUL * 1000) / 1000
        wasteFrac = CLUMP_BITE_WASTE_FRAC
      }
      const hungryFromClump =
        org.kind === 'clump' && bot.energy_pool + 1e-9 < biteCost
      let chunk = 0
      let toStomach = 0
      let toWasteChunk = 0
      let paidFromClump = 0
      if (hungryFromClump) {
        // Hunger knife: pay bite cost from clump; stomach = chunk − cost (no pool spend).
        chunk = Math.min(yieldCap, org.energy_locked)
        if (chunk + 1e-9 < biteCost) {
          reject(
            state,
            receipt,
            bot,
            idx,
            'NO_ENERGY',
            `hungry clump bite needs locked≥cost ${biteCost}, have ${chunk}`,
            { organic: org.id, locked: org.energy_locked, cost: biteCost },
          )
          return
        }
        paidFromClump = biteCost
        toStomach = Math.round((chunk - biteCost) * 1000) / 1000
        toWasteChunk = 0
        org.energy_locked = Math.round((org.energy_locked - chunk) * 1000) / 1000
        bot.stomach = Math.round((bot.stomach + toStomach) * 1000) / 1000
        // Action cost → waste_heat (paid from clump, not pool)
        state.waste_heat = Math.round((state.waste_heat + biteCost) * 1000) / 1000
      } else {
        if (!spend(bot, biteCost)) {
          reject(state, receipt, bot, idx, 'NO_ENERGY', 'pool empty')
          return
        }
        chunk = Math.min(yieldCap, org.energy_locked)
        toStomach = Math.round(chunk * (1 - wasteFrac) * 1000) / 1000
        toWasteChunk = Math.round((chunk - toStomach) * 1000) / 1000
        org.energy_locked = Math.round((org.energy_locked - chunk) * 1000) / 1000
        bot.stomach = Math.round((bot.stomach + toStomach) * 1000) / 1000
        state.waste_heat = Math.round((state.waste_heat + biteCost + toWasteChunk) * 1000) / 1000
      }
      if (coreDmg > 0) {
        bot.core_integrity = Math.max(CORE_DEATH, Math.round((bot.core_integrity - coreDmg) * 1000) / 1000)
      }
      budgetLeft.n -= biteCost
      receipt.energy_spent += biteCost
      receipt.accepted.push(idx)
      bumpBiteStreak(bot, org.id)
      pushEvent(state, 'bite', {
        actor: bot.actorId,
        organic: org.id,
        kind: org.kind,
        chunk,
        to_stomach: toStomach,
        to_waste: toWasteChunk,
        remaining: org.energy_locked,
        streak: bot.biteStreak,
        cost: biteCost,
        ...(hungryFromClump ? { paid_from_clump: paidFromClump, hungry_clump_bite: true } : {}),
        ...(coreDmg ? { core_damage: coreDmg, core_integrity: bot.core_integrity } : {}),
      })
      if (org.energy_locked <= 0.01 && org.kind !== 'corpse') {
        state.organics = state.organics.filter((o) => o.id !== org.id)
        pushEvent(state, 'organic_gone', {
          id: org.id,
          kind: org.kind,
          ...(org.kind === 'fruit' ? { fruit_gone: true } : {}),
        })
      }
      return
    }
    case 'digest': {
      if (bot.stomach <= 0) {
        reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'stomach empty')
        return
      }
      // Cost may be paid from stomach conversion if pool is empty
      const take = Math.min(bot.stomach, BITE_CHUNK)
      const toPool = Math.round(take * 0.85 * 1000) / 1000
      const toHeat = Math.round((take - toPool) * 1000) / 1000
      if (toPool + 1e-9 < cost && bot.energy_pool + 1e-9 < cost) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'cannot cover digest cost')
        return
      }
      bot.stomach = Math.round((bot.stomach - take) * 1000) / 1000
      bot.energy_pool = Math.round((bot.energy_pool + toPool) * 1000) / 1000
      if (!spend(bot, cost)) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'digest cost failed')
        return
      }
      state.waste_heat = Math.round((state.waste_heat + toHeat + cost) * 1000) / 1000
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      pushEvent(state, 'digest', { actor: bot.actorId, toPool, toHeat })
      return
    }
    case 'revive': {
      const org = action.target_id ? findOrganic(state, action.target_id) : undefined
      if (!org || org.kind !== 'corpse' || !org.corpseOf) {
        reject(state, receipt, bot, idx, 'TARGET_GONE', 'need a corpse organic')
        return
      }
      if (dist(bot.pos, org.pos) > REVIVE_RANGE + 1e-9) {
        reject(state, receipt, bot, idx, 'NOT_ADJACENT', 'corpse too far — move closer then revive')
        return
      }
      const dead = findBot(state, org.corpseOf)
      if (!dead || dead.alive) {
        reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'corpse bot missing or already alive')
        return
      }
      // Hungry revive: if pool < cost, pay shortfall from corpse locked (symmetric to hungry clump bite).
      const lockedBeforePay = org.energy_locked
      let paidFromCorpse = 0
      let paidFromPool = 0
      const hungryRevive = bot.energy_pool + 1e-9 < cost
      if (hungryRevive) {
        paidFromPool = Math.round(bot.energy_pool * 1000) / 1000
        paidFromCorpse = Math.round((cost - paidFromPool) * 1000) / 1000
        if (org.energy_locked + 1e-9 < paidFromCorpse) {
          reject(
            state,
            receipt,
            bot,
            idx,
            'NO_ENERGY',
            `hungry revive needs locked≥shortfall ${paidFromCorpse}, have ${org.energy_locked}`,
            {
              corpse: org.id,
              pool: bot.energy_pool,
              locked: org.energy_locked,
              cost,
              shortfall: paidFromCorpse,
            },
          )
          return
        }
        bot.energy_pool = 0
        org.energy_locked = Math.round((org.energy_locked - paidFromCorpse) * 1000) / 1000
      } else if (!spend(bot, cost)) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'need energy to revive')
        return
      } else {
        paidFromPool = cost
      }
      // Split remaining locked energy: savior + revived share; remainder → waste (conservation)
      const lockedWas = org.energy_locked
      let toSavior = Math.round(lockedWas * REVIVE_SHARE_SAVIOR * 1000) / 1000
      let toRevived = Math.round(lockedWas * REVIVE_SHARE_REVIVED * 1000) / 1000
      let toWasteLock = Math.round((lockedWas - toSavior - toRevived) * 1000) / 1000
      if (toWasteLock < 0) {
        toRevived = Math.round((toRevived + toWasteLock) * 1000) / 1000
        toWasteLock = 0
      }
      org.energy_locked = 0
      dead.alive = true
      dead.core_integrity = Math.max(dead.core_integrity, 0.55)
      dead.energy_pool = Math.round((dead.energy_pool + toRevived) * 1000) / 1000
      bot.energy_pool = Math.round((bot.energy_pool + toSavior) * 1000) / 1000
      dead.starveTicks = 0
      dead.pos = { ...org.pos }
      state.organics = state.organics.filter((o) => o.id !== org.id)
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      // Action cost → waste (from pool and/or corpse shortfall)
      state.waste_heat = Math.round((state.waste_heat + cost + toWasteLock) * 1000) / 1000
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      pushEvent(state, 'revived', {
        actor: bot.actorId,
        revived: dead.actorId,
        corpse: org.id,
        cost,
        locked_was: lockedBeforePay,
        locked_after_cost: lockedWas,
        to_savior: toSavior,
        to_revived: toRevived,
        waste_from_lock: toWasteLock,
        ...(hungryRevive
          ? {
              hungry_revive: true,
              paid_from_pool: paidFromPool,
              paid_from_corpse: paidFromCorpse,
            }
          : {}),
      })
      // Compat alias for older readers
      pushEvent(state, 'revive', {
        actor: bot.actorId,
        revived: dead.actorId,
        corpse: org.id,
        to_savior: toSavior,
        to_revived: toRevived,
        ...(hungryRevive ? { hungry_revive: true, paid_from_corpse: paidFromCorpse } : {}),
      })
      return
    }
    case 'move': {
      const dir = parseDir(action.dir)
      if (!dir || (dir.x === 0 && dir.y === 0)) {
        reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'dir required (n/s/e/w/…)')
        return
      }
      const next = {
        x: clamp(bot.pos.x + dir.x, 0, state.width - 1),
        y: clamp(bot.pos.y + dir.y, 0, state.height - 1),
      }
      const occ = occupiedKeys(state)
      occ.delete(keyOf(bot.pos))
      if (occ.has(keyOf(next))) {
        reject(state, receipt, bot, idx, 'ILLEGAL_OP', 'destination occupied')
        return
      }
      // Hungry move: top up shortfall from waste_heat, then normal spend (pool→waste).
      // Net conservation holds; no mint into pool beyond the cost bridge.
      let toppedFromWaste = 0
      let hungryMove = false
      if (bot.energy_pool + 1e-9 < cost) {
        const shortfall = Math.round((cost - bot.energy_pool) * 1000) / 1000
        const take = Math.min(shortfall, Math.max(0, state.waste_heat))
        if (bot.energy_pool + take + 1e-9 < cost) {
          reject(
            state,
            receipt,
            bot,
            idx,
            'NO_ENERGY',
            `hungry_move needs waste≥shortfall ${shortfall}, have waste ${state.waste_heat} pool ${bot.energy_pool}`,
            { pool: bot.energy_pool, waste_heat: state.waste_heat, cost, shortfall },
          )
          return
        }
        state.waste_heat = Math.round((state.waste_heat - take) * 1000) / 1000
        bot.energy_pool = Math.round((bot.energy_pool + take) * 1000) / 1000
        toppedFromWaste = take
        hungryMove = true
      }
      if (!spend(bot, cost)) {
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'cannot move')
        return
      }
      bot.pos = next
      for (const pid of bot.bound_particle_ids) {
        const p = findParticle(state, pid)
        if (p) p.pos = { ...bot.pos }
      }
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      pushEvent(state, 'move', {
        actor: bot.actorId,
        to: next,
        ...(hungryMove ? { hungry_move: true, topped_from_waste: toppedFromWaste } : {}),
      })
      return
    }
    case 'condense': {
      const pre = evaluateCondensePrereqs(state, bot)
      if (pre.refuse_starving) {
        pushEvent(state, 'condense_fail', {
          actor: bot.actorId,
          reason: pre.prereq_reason,
          refuse_starving: true,
          pool: bot.energy_pool,
          starving_floor: CONDENSE_STARVING_POOL,
          waste_heat: state.waste_heat,
        })
        reject(
          state,
          receipt,
          bot,
          idx,
          'REFUSED_CONDENSE_STARVING',
          pre.prereq_reason || `pool < ${CONDENSE_STARVING_POOL}`,
          {
            pool: bot.energy_pool,
            starving_floor: CONDENSE_STARVING_POOL,
            allowed: 'bite(clump) / digest / revive / move',
          },
        )
        return
      }
      if (pre.refuse_clutter) {
        const clutter = clumpInView(state, bot)
        pushEvent(state, 'condense_fail', {
          actor: bot.actorId,
          reason: pre.prereq_reason,
          refuse_clutter: true,
          clump: clutter?.id,
          locked: clutter?.energy_locked,
          waste_heat: state.waste_heat,
        })
        reject(
          state,
          receipt,
          bot,
          idx,
          'REFUSED_CONDENSE_CLUTTER',
          pre.prereq_reason || 'bite clump inventory before condense',
          {
            clump: clutter?.id,
            energy_locked: clutter?.energy_locked,
            allowed: 'bite(clump) / digest / pull / adsorb / catalyze',
          },
        )
        return
      }
      if (!pre.prereq_ok) {
        noteCondenseFail(state, bot)
        pushEvent(state, 'condense_fail', {
          actor: bot.actorId,
          reason: pre.prereq_reason,
          refuse_mix: pre.refuse_mix,
          refuse_cooldown: pre.refuse_cooldown,
          refuse_starving: pre.refuse_starving,
          refuse_clutter: pre.refuse_clutter,
          missing: pre.missing,
          waste_heat: state.waste_heat,
          local_yin: pre.local_yin,
          local_yang: pre.local_yang,
          local_particles: pre.local_particles,
          nearest_opposite: pre.nearest_opposite,
          fail_streak: bot.condenseFailStreak,
          cooldown_until: bot.condenseCooldownUntil,
        })
        if (pre.refuse_cooldown) {
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_CONDENSE_COOLDOWN',
            pre.prereq_reason || 'condense cooldown',
            {
              cooldown_ticks_left: pre.cooldown_ticks_left,
              fail_streak: bot.condenseFailStreak,
              missing: pre.missing,
              nearest_opposite: pre.nearest_opposite,
            },
          )
        } else if (pre.refuse_mix) {
          reject(
            state,
            receipt,
            bot,
            idx,
            'REFUSED_CONDENSE_MIX',
            pre.prereq_reason || 'condense mix incomplete',
            {
              missing: pre.missing,
              local_yin: pre.local_yin,
              local_yang: pre.local_yang,
              nearest_opposite: pre.nearest_opposite,
              fail_streak: bot.condenseFailStreak,
            },
          )
        } else {
          reject(state, receipt, bot, idx, 'ILLEGAL_OP', pre.prereq_reason || 'condense prereq failed')
        }
        return
      }
      // Use escalated cost from prereq (streak)
      cost = pre.cost
      if (!spend(bot, cost)) {
        noteCondenseFail(state, bot)
        pushEvent(state, 'condense_fail', { actor: bot.actorId, reason: 'NO_ENERGY' })
        reject(state, receipt, bot, idx, 'NO_ENERGY', 'cannot condense')
        return
      }
      // Draw waste_heat; lock only CONDENSE_EFFICIENCY fraction into a small clump
      const draw = Math.min(CONDENSE_DRAW, state.waste_heat)
      const locked = Math.round(draw * CONDENSE_EFFICIENCY * 1000) / 1000
      const stayWaste = Math.round((draw - locked) * 1000) / 1000
      // Net: waste loses `locked` only (draw - stayWaste = locked)
      state.waste_heat = Math.round((state.waste_heat - locked) * 1000) / 1000
      // Action cost → waste_heat (conservation)
      state.waste_heat = Math.round((state.waste_heat + cost) * 1000) / 1000
      const clump: Organic = {
        id: newId('clump'),
        kind: 'clump',
        pos: { ...bot.pos },
        energy_locked: locked,
        radius: 1,
      }
      state.organics.push(clump)
      budgetLeft.n -= cost
      receipt.energy_spent += cost
      receipt.accepted.push(idx)
      resetBiteStreak(bot)
      noteCondenseSuccess(bot)
      pushEvent(state, 'condense', {
        actor: bot.actorId,
        clump: clump.id,
        draw,
        locked,
        efficiency: CONDENSE_EFFICIENCY,
        stay_waste: stayWaste,
        waste_heat_left: state.waste_heat,
        local_yin: pre.local_yin,
        local_yang: pre.local_yang,
        cost,
      })
      return
    }
    default:
      reject(state, receipt, bot, idx, 'ILLEGAL_OP', `op not implemented: ${op}`)
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
    // Probe-reward hook: no single actor owns megamorph; callers may
    // maybeGrantProbeReward(state, bot, 'megamorph') after attributing credit.
  }

  // Corpse lock leak: unreived locked energy → waste_heat (pressure to revive)
  for (const org of state.organics) {
    if (org.kind !== 'corpse' || org.energy_locked <= 0) continue
    const leak = Math.min(CORPSE_LOCK_LEAK, org.energy_locked)
    org.energy_locked = Math.round((org.energy_locked - leak) * 1000) / 1000
    state.waste_heat = Math.round((state.waste_heat + leak) * 1000) / 1000
    if (state.tick % 5 === 0) {
      pushEvent(state, 'corpse_leak', {
        corpse: org.id,
        of: org.corpseOf,
        leak,
        locked_left: org.energy_locked,
      })
    }
  }

  // Metabolism / starve (softer while fruit exists)
  const upkeep = fruitPresent(state) ? METABOLISM_FRUIT : METABOLISM_POST_FRUIT
  for (const bot of state.bots) {
    if (!bot.alive) continue
    // Passive upkeep (pool → waste_heat)
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
  let locked = Math.round((bot.energy_pool + bot.stomach) * 1000) / 1000
  bot.energy_pool = 0
  bot.stomach = 0
  let toppedFromWaste = 0
  // Starve death floor: pull waste_heat so corpse.locked reaches CORPSE_LOCK_FLOOR (conservation).
  if (reason === 'starve' && locked + 1e-9 < CORPSE_LOCK_FLOOR) {
    const need = Math.round((CORPSE_LOCK_FLOOR - locked) * 1000) / 1000
    const take = Math.min(need, Math.max(0, state.waste_heat))
    if (take > 0) {
      state.waste_heat = Math.round((state.waste_heat - take) * 1000) / 1000
      locked = Math.round((locked + take) * 1000) / 1000
      toppedFromWaste = take
    }
  }
  const corpse: Organic = {
    id: newId('corpse'),
    kind: 'corpse',
    pos: { ...bot.pos },
    energy_locked: locked,
    corpseOf: bot.actorId,
    diedAtTick: state.tick,
    radius: 1,
  }
  state.organics.push(corpse)
  pushEvent(state, 'death', {
    actor: bot.actorId,
    reason,
    corpse: corpse.id,
    locked,
    ...(toppedFromWaste > 0
      ? { topped_from_waste: toppedFromWaste, lock_floor: CORPSE_LOCK_FLOOR }
      : {}),
  })
}

export function act(
  state: WorldState,
  req: ActRequest,
  opts?: { settle?: boolean },
): ActReceipt {
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
  // Turn-based: defer settle so all agents act, then one shared stepPhysics
  if (opts?.settle !== false) {
    stepPhysics(state)
    receipt.tick_advanced = state.tick
  }
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
      return `[世界 t=${ev.t}] ${p.actor} 啃了 ${p.kind}（+${p.chunk} 入胃，剩余 ${p.remaining}${p.streak != null ? `，连啃×${p.streak}` : ''}）`
    case 'digest':
      return `[世界 t=${ev.t}] ${p.actor} 消化：能池+${p.toPool}，废热+${p.toHeat}`
    case 'death':
      return `[世界 t=${ev.t}] ${p.actor} 死亡（${p.reason}），留下尸体 ${p.corpse}${p.locked != null ? ` 锁能=${p.locked}` : ''}${p.topped_from_waste ? `（废热补${p.topped_from_waste}）` : ''}`
    case 'revived':
      return `[世界 t=${ev.t}] ${p.actor} 复活了 ${p.revived}（锁能${p.locked_was}→救者+${p.to_savior}/死者+${p.to_revived}${p.hungry_revive ? `；饿救短差${p.paid_from_corpse}` : ''}）`
    case 'revive':
      return `[世界 t=${ev.t}] ${p.actor} 复活了 ${p.revived}`
    case 'megamorph':
      return `[世界 t=${ev.t}] 局部巨变 → 团块 ${p.clump} @(${(p.at as Vec2).x},${(p.at as Vec2).y})`
    case 'collide_transfer':
      return `[世界 t=${ev.t}] 阴阳碰撞转能 ${p.a}↔${p.b}`
    case 'move':
      return `[世界 t=${ev.t}] ${p.actor} 移动到 (${(p.to as Vec2).x},${(p.to as Vec2).y})${p.hungry_move ? `（饿走·废热补${p.topped_from_waste}）` : ''}`
    case 'world_seeded':
      return `[世界 t=${ev.t}] 阴阳场开机 · 守恒基线=${p.baseline} · 硕果能量=${p.fruit_energy}`
    case 'refused_satiated':
      return `[世界 t=${ev.t}] ${p.actor} 餍足拒咬（pool=${p.energy_pool}≥${p.threshold}）— 改试探/复活`
    case 'micro_reward':
      return `[世界 t=${ev.t}] ${p.actor} 微操回收 +${p.amount}（${p.reason}，废热余 ${p.waste_heat_left}）`
    case 'wait_neglect':
      return `[世界 t=${ev.t}] ${p.actor} 在尸体旁干等（无微操奖励）— 应 revive`
    case 'pull_oscillation':
      return `[世界 t=${ev.t}] ${p.actor} 来回拉同一粒子（无 micro_reward）`
    case 'corpse_leak':
      return `[世界 t=${ev.t}] 尸体 ${p.of || p.corpse} 锁能渗漏 −${p.leak}（余 ${p.locked_left}）→废热`
    case 'condense':
      return `[世界 t=${ev.t}] ${p.actor} 冷凝废热→团块 ${p.clump}（抽${p.draw} 锁${p.locked} @${Math.round(Number(p.efficiency) * 100)}%）`
    case 'condense_fail':
      return `[世界 t=${ev.t}] ${p.actor} 冷凝失败：${p.reason}`
    case 'organic_gone':
      return `[世界 t=${ev.t}] 有机物消失 ${p.kind} ${p.id}${p.fruit_gone ? '（硕果耗尽 FRUIT_GONE）' : ''}`
    default:
      return `[世界 t=${ev.t}] ${ev.type} ${JSON.stringify(p).slice(0, 120)}`
  }
}

export function conservationOk(state: WorldState, eps = 0.15): boolean {
  return Math.abs(totalEnergy(state) - state.conservation_baseline) <= eps
}
