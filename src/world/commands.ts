/**
 * Human plaza commands → world acts + system-line summaries.
 * Free chat (no command prefix) is unchanged.
 */
import type { ActAction, ActReceipt, ObserveSnapshot, WorldState } from './types.ts'
import { act, moveBot, observe, formatEventLine } from './engine.ts'

const HUMAN_ACTOR = 'human'

export interface ParsedWorldCommand {
  kind: 'look' | 'move' | 'act' | 'status' | 'help'
  actions?: ActAction[]
  dir?: string
  budget?: number
}

/** Returns null if text is ordinary chat (not a world command). */
export function parseWorldCommand(text: string): ParsedWorldCommand | null {
  const raw = text.trim()
  if (!raw) return null

  // Explicit prefixes
  const prefixed = raw.match(/^[/!](?:world|w|场|世界)\s+([\s\S]+)$/i)
  const body = prefixed ? prefixed[1]!.trim() : raw

  // Without prefix: only accept clear imperative forms
  const looksCommand =
    !!prefixed ||
    /^(看|观察|look|observe|status|状态|help|帮助|移动|走|move|推|拉|咬|消化|吸附|催化|等待|复活|nudge|pull|bite|digest|adsorb|catalyze|wait|revive)\b/i.test(
      body,
    )
  if (!looksCommand) return null

  const lower = body.toLowerCase()
  if (/^(help|帮助|\?)$/i.test(body)) return { kind: 'help' }
  if (/^(看|观察|look|observe)$/i.test(body)) return { kind: 'look' }
  if (/^(status|状态)$/i.test(body)) return { kind: 'status' }

  const moveM = body.match(/^(?:移动|走|move)\s+(\S+)$/i)
  if (moveM) return { kind: 'move', dir: moveM[1] }

  const opMap: Record<string, ActAction['op']> = {
    nudge: 'nudge',
    推: 'nudge',
    pull: 'pull',
    拉: 'pull',
    adsorb: 'adsorb',
    吸附: 'adsorb',
    catalyze: 'catalyze',
    催化: 'catalyze',
    bite: 'bite',
    咬: 'bite',
    啃: 'bite',
    digest: 'digest',
    消化: 'digest',
    wait: 'wait',
    等待: 'wait',
    守卫: 'wait',
    guard: 'wait',
    revive: 'revive',
    复活: 'revive',
  }

  const parts = body.split(/\s+/).filter(Boolean)
  const opKey = parts[0] || ''
  const op = opMap[opKey] || opMap[opKey.toLowerCase()]
  if (!op) {
    if (prefixed) return { kind: 'help' }
    return null
  }

  const action: ActAction = { op }
  if (parts[1] && !/^(n|s|e|w|north|south|east|west|上|下|左|右|北|南|东|西)$/i.test(parts[1])) {
    action.target_id = parts[1]
    if (parts[2]) action.dir = parts[2]
    if (parts[3] && Number.isFinite(Number(parts[3]))) action.mag = Number(parts[3])
  } else if (parts[1]) {
    action.dir = parts[1]
  }
  return { kind: 'act', actions: [action], budget: 20 }
}

export function runHumanWorldCommand(
  state: WorldState,
  text: string,
): { handled: boolean; systemLines: string[]; receipt?: ActReceipt; snapshot?: ObserveSnapshot } {
  const parsed = parseWorldCommand(text)
  if (!parsed) return { handled: false, systemLines: [] }

  if (parsed.kind === 'help') {
    return {
      handled: true,
      systemLines: [
        '[世界] 指令：/world look | status | move <方向> | bite <有机id> | digest | nudge <粒子id> <方向> | pull/adsorb/catalyze/wait/revive … 也可用中文：观察、咬、消化、推、移动 东',
      ],
    }
  }

  if (parsed.kind === 'look' || parsed.kind === 'status') {
    try {
      const snap = observe(state, HUMAN_ACTOR)
      return {
        handled: true,
        snapshot: snap,
        systemLines: [formatSnapshotLine(snap)],
      }
    } catch (err) {
      return {
        handled: true,
        systemLines: [`[世界] 观察失败：${err instanceof Error ? err.message : String(err)}`],
      }
    }
  }

  if (parsed.kind === 'move' && parsed.dir) {
    const receipt = moveBot(state, HUMAN_ACTOR, parsed.dir)
    return {
      handled: true,
      receipt,
      systemLines: [formatReceiptLine('human', receipt), ...recentEventLines(state, 3)],
    }
  }

  if (parsed.kind === 'act' && parsed.actions?.length) {
    const receipt = act(state, {
      actor_id: HUMAN_ACTOR,
      budget_energy: parsed.budget ?? 20,
      actions: parsed.actions,
    })
    return {
      handled: true,
      receipt,
      systemLines: [formatReceiptLine('human', receipt), ...recentEventLines(state, 4)],
    }
  }

  return { handled: true, systemLines: ['[世界] 无法解析指令'] }
}

export function formatSnapshotLine(snap: ObserveSnapshot): string {
  const s = snap.self
  const fruit = snap.organics.find((o) => o.kind === 'fruit')
  const parts = [
    `[世界 t=${snap.tick}] ${s.id} @(${s.pos.x},${s.pos.y})`,
    `energy_pool=${s.energy_pool}`,
    `core_integrity=${s.core_integrity}`,
    s.alive === false ? 'DEAD' : 'alive',
    `stomach=${s.stomach ?? 0}`,
    `视野粒子=${snap.view.particles.length}`,
    `有机=${snap.organics.length}`,
    `revive_cost=${snap.revive_cost}`,
    `urgency=${snap.urgency ?? 0}`,
  ]
  if (snap.suggested_ops?.length) parts.push(`suggest=${snap.suggested_ops.join(',')}`)
  if (fruit) parts.push(`硕果剩余=${fruit.energy_locked}`)
  if (snap.corpses?.length) {
    parts.push(
      `尸体×${snap.corpses.length}=` +
        snap.corpses
          .map((c) => `${c.corpse_of}@(${c.pos.x},${c.pos.y})/锁${c.energy_locked}`)
          .join(','),
    )
  }
  if (snap.dying?.length) {
    parts.push(`濒死=${snap.dying.map((d) => d.actor_id).join(',')}`)
  }
  if (snap.fruit_gone) parts.push('FRUIT_GONE')
  if (typeof snap.waste_heat === 'number') parts.push(`waste=${snap.waste_heat}`)
  if (snap.alerts?.length) parts.push(`⚠${snap.alerts[0]}`)
  if (snap.last_errors[0]) parts.push(`last_err=${snap.last_errors[0].code}`)
  return parts.join(' · ')
}

export function formatReceiptLine(actor: string, receipt: ActReceipt): string {
  const ok = receipt.accepted.length
  const bad = receipt.rejected.map((r) => `${r.code}:${r.msg}`).join('; ')
  return `[世界] ${actor} act → accepted=${ok} spent=${receipt.energy_spent} tick=${receipt.tick_advanced}${bad ? ` rejected=${bad}` : ''}`
}

export function recentEventLines(state: WorldState, n = 5): string[] {
  return state.events.slice(-n).map(formatEventLine)
}

export { HUMAN_ACTOR }
