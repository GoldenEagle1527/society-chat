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

export interface ObserveSnapshot {
  tick: number
  self: ObserveSelf
  view: {
    radius: number
    particles: ObserveParticle[]
  }
  organics: ObserveOrganic[]
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
