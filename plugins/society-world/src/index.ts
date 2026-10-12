/**
 * society-world — YinYang Field M0 in-process engine.
 * Cordis service: societyWorld
 *
 * Survival metrics: energy_pool / core_integrity only (no soul.energy).
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId } from '../../../src/types.ts'
import {
  act as engineAct,
  conservationOk,
  createSeedWorld,
  formatEventLine,
  formatSnapshotLine,
  loadOrSeedWorld,
  loadWorld,
  observe as engineObserve,
  recentEventLines,
  runHumanWorldCommand,
  saveWorld,
  stepPhysics,
  totalEnergy,
  type ActReceipt,
  type ActRequest,
  type ObserveSnapshot,
  type WorldEvent,
  type WorldState,
} from '../../../src/world/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyWorld: SocietyWorldService
  }
  interface Events {
    'society/world-events'(payload: { events: WorldEvent[]; tick: number }): void
  }
}

export class SocietyWorldService extends Service {
  static inject = ['societyIdentity', 'societyRooms']

  private state: WorldState | null = null
  private plazaRoomId: string | null = null
  private lastPostedEventIdx = 0
  /** When true, act() applies ops but does not stepPhysics (synced turn). */
  private deferSettle = false

  constructor(ctx: Context) {
    super(ctx, 'societyWorld')
  }

  /** Bind default plaza for system event lines. */
  setPlazaRoom(roomId: string | null): void {
    this.plazaRoomId = roomId
  }

  getState(): WorldState | null {
    return this.state
  }

  /** Ensure world exists for current agents + human. */
  ensureSeeded(extraActorIds: string[] = []): WorldState {
    const agents = this.ctx.societyIdentity.list().map((a) => a.id)
    const actors = [...new Set([...agents, 'human', ...extraActorIds])]
    this.state = loadOrSeedWorld(actors)
    return this.state
  }

  reload(): WorldState | null {
    this.state = loadWorld()
    return this.state
  }

  persist(): void {
    if (this.state) saveWorld(this.state)
  }

  observe(actorId: string): ObserveSnapshot {
    const state = this.requireState()
    return engineObserve(state, actorId)
  }

  beginSyncedTurn(): void {
    this.deferSettle = true
  }

  /** Apply one physics/metabolism tick and clear defer. */
  endSyncedTurn(): WorldEvent[] {
    this.deferSettle = false
    return this.step()
  }

  isDeferSettle(): boolean {
    return this.deferSettle
  }

  act(req: ActRequest): ActReceipt {
    const state = this.requireState()
    const before = state.events.length
    const receipt = engineAct(state, req, { settle: !this.deferSettle })
    this.persist()
    this.emitNewEvents(before)
    return receipt
  }

  step(): WorldEvent[] {
    const state = this.requireState()
    const before = state.events.length
    const ev = stepPhysics(state)
    this.persist()
    this.emitNewEvents(before)
    return ev
  }

  totalEnergy(): number {
    return totalEnergy(this.requireState())
  }

  conservationOk(): boolean {
    return conservationOk(this.requireState())
  }

  /** World-side wake priority (NOT soul). Higher = more urgent. */
  wakeScore(actorId: AgentId): number {
    const state = this.state
    if (!state) return 50
    const bot = state.bots.find((b) => b.actorId === actorId)
    if (!bot) return 10
    if (!bot.alive) return 0
    let score = 40
    // Low pool → urgent to act (seek food)
    if (bot.energy_pool < 5) score += 80
    else if (bot.energy_pool < 10) score += 40
    else score += Math.max(0, 20 - bot.energy_pool)
    if (bot.core_integrity < 0.4) score += 60
    if (bot.starveTicks > 0) score += bot.starveTicks * 25
    if (bot.stomach > 0) score += 15 // want to digest
    if (bot.last_errors.length) score += 10
    return score
  }

  isAlive(actorId: string): boolean {
    const bot = this.state?.bots.find((b) => b.actorId === actorId)
    return !!bot?.alive
  }

  /** Handle human chat text; if world command, post system lines to plaza. */
  handleHumanText(text: string): { handled: boolean; systemLines: string[] } {
    const state = this.requireState()
    const before = state.events.length
    const result = runHumanWorldCommand(state, text)
    if (result.handled) {
      this.persist()
      this.emitNewEvents(before)
      this.postSystemLines(result.systemLines)
    }
    return { handled: result.handled, systemLines: result.systemLines }
  }

  formatSnapshotFor(actorId: string): string {
    return formatSnapshotLine(this.observe(actorId))
  }

  promptWorldSection(actorId: string): string {
    try {
      const snap = this.observe(actorId)
      const lines = [
        '【阴阳场身体】',
        formatSnapshotLine(snap),
        '生存只看 energy_pool / core_integrity（不是心情）。能池空会饿死；死亡由引擎裁定。',
        '工具：world_observe 读邻域；world_act 提交微操（nudge/pull/adsorb/catalyze/bite/digest/wait/revive/move/condense）。',
        `行动成本：revive=${snap.revive_cost}（最贵）、adsorb=${snap.action_costs.adsorb}、bite=${snap.action_costs.bite}、pull=${snap.action_costs.pull}、wait=${snap.action_costs.wait}。`,
        `紧迫度 urgency=${snap.urgency}；建议操作 suggested_ops=[${(snap.suggested_ops || []).join(',')}]。有尸体时优先 revive，禁止在尸体旁干等。`,
        '引擎立法：能池≥餍足阈值时咬果 → REFUSED_SATIATED；同目标连啃成本升、收益降。刚好够优于囤满。',
        'micro_reward 只奖构型进展（pull_cluster/pull_pair/pull_morph_prep、adsorb_balance、catalyze_bond）；随机 pull_moved / 来回拉 / wait 不给奖。守恒：废热→能池。代谢每 tick 扣能。',
        '能池够用时：挪粒子成团/催化键/复活同伴；咬果仅濒饿。硕果尚在先 bite/digest。果尽看「齐窗进度」(阴x/需 阳y/需)；未齐时 PREP 会写明允许列表与对面方向/id，move 算筹备。齐窗后造团→咬团维生。pool<4 禁冷凝（REFUSED_CONDENSE_STARVING），饿时可从团能付咬团费（stomach=chunk−cost）。尸体旁硬提示 revive；饿死尸体锁能地板12（废热补）；pool<8 可饿救（短差从尸体锁能付）。研究窗：无尸体义务且 pool≥6 或 stomach≥4 时开放微操；仅 FRUIT_GONE 后才头钉微操（视野有 bond<1 才建议 catalyze，否则 divert 到 pull/adsorb）；果期仅尾部追加、不抢 bite/digest；bond≥1 催化→REFUSED_CATALYZE_MAXED。餍足10仍只管咬果；视野有团则禁冷凝 CLUTTER。冷凝效/果参/饥饿闸/饿救不变。聊天是外壳。',
      ]
      if (snap.corpses?.length) {
        lines.push('【尸体警报 — 立刻评估 revive】')
        for (const c of snap.corpses) {
          const now = c.saviors?.filter((s) => s.can_revive_now).map((s) => s.actor_id) || []
          const hard = c.neglect_hardened ? ' ⚠REVIVE_NEGLECT' : ''
          lines.push(
            `- ${c.corpse_of} ${c.organic_id} @(${c.pos.x},${c.pos.y}) 锁能=${c.energy_locked} 成本=${c.revive_cost} 未救=${c.ticks_unrevived}t${hard} dist=${c.dist} in_range=${c.in_range} 我能付=${c.self_can_afford} 我现在能救=${c.self_can_revive_now} 可立即救=[${now.join(',') || '无'}]`,
          )
          lines.push(`  干等代价：${c.inaction_cost}`)
          if (c.neglect_hardened) {
            lines.push(
              `  → 已拖延≥数 tick：点名可救者立即 revive（成本 ${c.revive_cost}），否则锁能变废热、同伴永死。`,
            )
          }
        }
        lines.push('有尸体且能池≥revive+余量：wait→REFUSED_REVIVE_WAIT、非饥饿咬果→REFUSED_REVIVE_BITE（引擎硬拒）。无尸体时 wait 不发 wait_neglect。锁能每 tick 渗漏；复活成功双方分锁能。')
      }
      if (snap.dying?.length) {
        lines.push('【濒死同伴】')
        for (const d of snap.dying) {
          lines.push(
            `- ${d.actor_id} @(${d.pos.x},${d.pos.y}) pool=${d.energy_pool} core=${d.core_integrity} starve=${d.starve_ticks}`,
          )
        }
      }
      if (snap.alerts?.length) {
        lines.push('警报：' + snap.alerts.join(' | '))
      }
      if (snap.events_recent.length) {
        lines.push('近期世界事件：')
        for (const e of snap.events_recent.slice(-5)) lines.push(`- ${formatEventLine(e)}`)
      }
      return lines.join('\n')
    } catch {
      return '【阴阳场】尚未绑定身体；等待世界种子。'
    }
  }

  private requireState(): WorldState {
    if (!this.state) this.ensureSeeded()
    if (!this.state) throw new Error('world state missing')
    return this.state
  }

  private emitNewEvents(beforeLen: number): void {
    const state = this.requireState()
    const fresh = state.events.slice(beforeLen)
    if (!fresh.length) return
    this.ctx.emit('society/world-events', { events: fresh, tick: state.tick })
    this.postSystemLines(fresh.map(formatEventLine))
  }

  private postSystemLines(lines: string[]): void {
    if (!this.plazaRoomId || !lines.length) return
    const room = this.ctx.societyRooms.get(this.plazaRoomId)
    if (!room) return
    for (const body of lines.slice(0, 8)) {
      try {
        this.ctx.societyRooms.post({
          roomId: this.plazaRoomId,
          from: 'system',
          body,
        })
      } catch (err) {
        this.ctx.logger('society-world').warn(String(err))
      }
    }
  }

  /** Reset world file (used by seed --reset path via createSeedWorld). */
  reseed(actorIds: string[]): WorldState {
    this.state = createSeedWorld(actorIds)
    saveWorld(this.state)
    this.lastPostedEventIdx = 0
    return this.state
  }
}

export const name = 'society-world'
export const inject = ['societyIdentity', 'societyRooms']

export function apply(ctx: Context) {
  ctx.plugin(SocietyWorldService)
}

export { recentEventLines, formatEventLine, formatSnapshotLine }
