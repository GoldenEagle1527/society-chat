/** YinYang Field M0 — shared world types (API contract aligned). */

export type ParticleKind = 'yin' | 'yang'
export type OrganicKind = 'fruit' | 'corpse' | 'clump'
export type WorldOp = 'nudge' | 'pull' | 'adsorb' | 'catalyze' | 'bite' | 'digest' | 'wait' | 'revive'

export type ActRejectCode =
  | 'OUT_OF_RANGE'
  | 'NOT_ADJACENT'
  | 'NO_ENERGY'
  | 'TARGET_GONE'
  | 'ILLEGAL_OP'
  | 'BUDGET_EXCEEDED'
  | 'REFUSED_SATIATED'

export interface Vec2 {
  x: number
  y: number
}

export interface Particle {
  id: string
  kind: ParticleKind
  pos: Vec2
  energy: number
  /** Soft bond strength with neighbors (0–1). */
  bond?: number
  /** Bound to this bot (not free on grid). */
  boundTo?: string
}

export interface Organic {
  id: string
  kind: OrganicKind
  pos: Vec2
  energy_locked: number
  /** Corpse of this bot id when kind=corpse. */
  corpseOf?: string
  /** Approx radius for adjacency (fruit is large). */
  radius: number
}

export interface BotBody {
  id: string
  /** Agent id or "human". */
  actorId: string
  pos: Vec2
  energy_pool: number
  core_integrity: number
  bound_particle_ids: string[]
  /** Energy bitten but not yet digested. */
  stomach: number
  alive: boolean
  /** Starve counter: ticks with empty pool. */
  starveTicks: number
  /** Consecutive successful bites on the same organic (diminishing returns). */
  biteStreak: number
  /** Organic id of the current bite streak; cleared on other ops / other targets. */
  biteStreakTargetId?: string
  last_errors: Array<{ code: ActRejectCode; msg: string; at: string }>
}

export interface WorldEvent {
  t: number
  type: string
  payload: Record<string, unknown>
}

export interface WorldState {
  width: number
  height: number
  tick: number
  particles: Particle[]
  organics: Organic[]
  bots: BotBody[]
  waste_heat: number
  events: WorldEvent[]
  /** Immutable total at seed — for conservation checks. */
  conservation_baseline: number
  updatedAt: string
}

export interface ObserveSelf {
  id: string
  pos: Vec2
  energy_pool: number
  core_integrity: number
  bound_particle_ids: string[]
  stomach?: number
  alive?: boolean
  /** Consecutive bites on same organic; 0 if last success was not a bite. */
  bite_streak?: number
  bite_streak_target_id?: string
  /** Hard reject fruit bite when energy_pool >= this. */
  satiety_threshold?: number
}

export interface ObserveParticle {
  id: string
  kind: ParticleKind
  pos: Vec2
  energy: number
  bond?: number
}

export interface ObserveOrganic {
  id: string
  kind: OrganicKind
  pos: Vec2
  energy_locked: number
}

/** Who could revive a corpse (pool / range). */
export interface ObserveSavior {
  actor_id: string
  energy_pool: number
  dist: number
  in_range: boolean
  can_afford: boolean
  /** in_range && can_afford */
  can_revive_now: boolean
}

/** Corpse / dying alert for observe (map-wide, not view-gated). */
export interface ObserveCorpseAlert {
  organic_id: string
  corpse_of: string
  pos: Vec2
  energy_locked: number
  revive_cost: number
  /** Distance from observer; omit if observer has no body. */
  dist?: number
  in_range: boolean
  /** Observer pool >= revive_cost */
  self_can_afford: boolean
  /** Observer can revive this tick (in range + afford). */
  self_can_revive_now: boolean
  /** Alive bots who might save (sorted: can_revive_now first). */
  saviors: ObserveSavior[]
  /** What waiting costs (locked stuck + leak). */
  inaction_cost: string
}

export interface ObserveDyingAlert {
  actor_id: string
  pos: Vec2
  energy_pool: number
  core_integrity: number
  starve_ticks: number
  dist?: number
}

export interface ObserveSnapshot {
  tick: number
  self: ObserveSelf
  view: {
    radius: number
    particles: ObserveParticle[]
  }
  organics: ObserveOrganic[]
  /** Map-wide corpses — prominent so agents can path to revive. */
  corpses: ObserveCorpseAlert[]
  /** Alive bots near death (starve / low core). */
  dying: ObserveDyingAlert[]
  /** Short human-readable alerts (corpse / dying / satiety). */
  alerts: string[]
  /** Ops the engine thinks are urgent (revive > wait near corpse). */
  suggested_ops: WorldOp[]
  /** 0–100 urgency; corpses/dying raise it. */
  urgency: number
  /** Full op cost table (includes revive). */
  action_costs: Record<WorldOp, number>
  revive_cost: number
  satiety_threshold: number
  events_recent: WorldEvent[]
  last_errors: BotBody['last_errors']
}

export interface ActAction {
  op: WorldOp
  target_id?: string
  dir?: string
  mag?: number
}

export interface ActRequest {
  actor_id: string
  budget_energy: number
  actions: ActAction[]
}

export interface ActRejected {
  idx: number
  code: ActRejectCode
  msg: string
}

export interface ActReceipt {
  accepted: number[]
  rejected: ActRejected[]
  energy_spent: number
  tick_advanced: number
}
