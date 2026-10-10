/**
 * Autonomous society heartbeat daemon.
 *
 * Boot → plaza + alice/bob → Alice seeds one line if empty →
 * loop runTick until maxTicks / maxExchanges / SIGINT.
 *
 * Env (defaults):
 *   SOCIETY_MAX_TICKS=8
 *   SOCIETY_MAX_EXCHANGES=6
 *   SOCIETY_TICK_MS=1000
 *   SOCIETY_COOLDOWN_MS=800
 *   SOCIETY_AGENT_COOLDOWN_MS=400
 *   SOCIETY_IDLE_STALE_MS=2500
 *   (no daily LLM hard cap; SOCIETY_DAILY_LLM_BUDGET ignored)
 *   SOCIETY_MAX_PARALLEL_REPLIES=2
 *   AGNES_MODEL=agnes-3.0-flash (free only)
 *
 * Never logs API keys. Ctrl+C / SIGTERM stops cleanly.
 */
import { loadDotEnv, requireAgnesConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import type { SoulState } from './types.ts'

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw && /^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10))
  return fallback
}

function soulSnap(s: SoulState): { openness: number; trust: number; energy: number; mood?: string } {
  return {
    openness: s.openness,
    trust: s.trust,
    energy: s.energy,
    mood: s.mood,
  }
}

async function main() {
  console.log('=== society-chat society-run (autonomous heartbeat) ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes: base=${cfg.baseUrl} model=${cfg.model} key=set`)

  const maxTicks = envInt('SOCIETY_MAX_TICKS', 8)
  const maxExchanges = envInt('SOCIETY_MAX_EXCHANGES', 6)
  const tickMs = envInt('SOCIETY_TICK_MS', 1_000)
  const cooldownMs = envInt('SOCIETY_COOLDOWN_MS', 800)
  const agentCooldownMs = envInt('SOCIETY_AGENT_COOLDOWN_MS', 400)
  const idleStaleMs = envInt('SOCIETY_IDLE_STALE_MS', 2_500)
  const maxParallelReplies = Math.max(1, envInt('SOCIETY_MAX_PARALLEL_REPLIES', 2) || 1)

  console.log(
    `✓ caps: maxTicks=${maxTicks} maxExchanges=${maxExchanges} tickMs=${tickMs} cooldownMs=${cooldownMs} agentCooldownMs=${agentCooldownMs} idleStaleMs=${idleStaleMs} maxParallelReplies=${maxParallelReplies} (LLM budget unlimited)`,
  )
  console.log('  stop: Ctrl+C / SIGINT / SIGTERM, or wait for caps')

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  const alice = ctx.societyIdentity.require('alice')
  const bob = ctx.societyIdentity.require('bob')
  const allAgents = ctx.societyIdentity.list()
  const agentIds = allAgents.map((a) => a.id)
  console.log(`✓ agents: ${allAgents.map((a) => a.displayName).join(', ')}`)

  const soul0: Record<string, ReturnType<typeof soulSnap>> = {
    alice: soulSnap(ctx.societySoul.load('alice')),
    bob: soulSnap(ctx.societySoul.load('bob')),
  }
  for (const a of allAgents) {
    if (!(a.id in soul0)) soul0[a.id] = soulSnap(ctx.societySoul.load(a.id))
  }

  // Event-driven OFF — ticks own the drain (cleaner caps). Smokes still use enableAutoReply.
  ctx.societyScheduler.configure({
    maxExchanges,
    onlyAgents: agentIds,
    cooldownMs,
    agentCooldownMs,
    idleStaleMs,
    maxParallelReplies,
  })

  let room = ctx.societyRooms.listRooms().find((r) => r.name === 'plaza')
  if (!room) {
    room = ctx.societyRooms.create({
      name: 'plaza',
      createdBy: 'alice',
      members: agentIds,
    })
  } else {
    for (const id of agentIds) {
      ctx.societyRooms.join(room.id, id)
    }
  }
  ctx.societyScheduler.setDefaultRoom(room.id)
  console.log(`✓ room: ${room.name} (${room.id.slice(0, 8)}…) members=${room.members.join(',')}`)

  ctx.on('society/agent-born', (profile) => {
    try {
      ctx.societyRooms.join(room!.id, profile.id)
      ctx.societyScheduler.allowAgent(profile.id)
    } catch {
      /* ignore */
    }
  })

  const history = ctx.societyRooms.historyOf(room.id)
  if (history.length === 0) {
    const seed =
      process.env.SOCIETY_SEED_LINE?.trim() ||
      '嗨 Bob，社会广场开机了。我们先随便聊聊：今天你最想先确认的隔离底线是什么？'
    ctx.societyRooms.post({ roomId: room.id, from: 'alice', body: seed })
    console.log(`[seed] Alice: ${seed}`)
  } else {
    console.log(`✓ plaza already has ${history.length} message(s); skip seed`)
  }

  let stopping = false
  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    console.log(`\n[signal] ${sig} — finishing current tick then exit…`)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  ctx.on('society/agent-replied', (p) => {
    const name = p.agentId === 'alice' ? 'Alice' : p.agentId === 'bob' ? 'Bob' : p.agentId
    if (p.kind === 'room') {
      console.log(`[live] ${name}: ${p.body}`)
    } else if (p.kind === 'direct') {
      console.log(`[live] ${name} → ${p.to} (DM): ${p.body}`)
    } else if (p.kind === 'diary') {
      console.log(`[live] ${name} (diary): ${p.body}`)
    } else if (p.kind === 'idle-skip') {
      console.log(`[live] ${name} (idle skip)`)
    }
  })

  let stopReason = 'maxTicks'
  for (let i = 0; i < maxTicks; i++) {
    if (stopping) {
      stopReason = 'signal'
      break
    }
    if (ctx.societyScheduler.exchangeCountOf() >= maxExchanges) {
      stopReason = 'maxExchanges'
      break
    }

    const result = await ctx.societyScheduler.runTick()
    const parallelBits =
      result.parallel && result.parallel.length > 1
        ? ` parallel=[${result.parallel
            .map((p) => `${p.agentId || '?'}:${p.action}${p.provider ? `@${p.provider}` : ''}`)
            .join(', ')}]`
        : result.provider
          ? ` provider=${result.provider}`
          : ''
    console.log(
      `[tick ${result.tick}/${maxTicks}] action=${result.action}` +
        (result.agentId ? ` agent=${result.agentId}` : '') +
        parallelBits +
        ` exchanges=${result.exchanges}/${result.maxExchanges}`,
    )

    if (result.action === 'capped') {
      stopReason = 'maxExchanges'
      break
    }

    if (stopping) {
      stopReason = 'signal'
      break
    }

    // Delay between ticks (avoid hammering API)
    if (i + 1 < maxTicks && ctx.societyScheduler.exchangeCountOf() < maxExchanges) {
      await new Promise((r) => setTimeout(r, tickMs))
    }
  }

  if (ctx.societyScheduler.exchangeCountOf() >= maxExchanges && stopReason === 'maxTicks') {
    stopReason = 'maxExchanges'
  }
  if (ctx.societyScheduler.tickCountOf() >= maxTicks && stopReason === 'maxTicks') {
    stopReason = 'maxTicks'
  }

  const finalHistory = ctx.societyRooms.historyOf(room.id)
  console.log('--- transcript ---')
  for (const m of finalHistory) {
    const name = m.from === 'alice' ? 'Alice' : m.from === 'bob' ? 'Bob' : m.from
    console.log(`${name}: ${m.body}`)
  }
  console.log('------------------')

  const soul1 = {
    alice: soulSnap(ctx.societySoul.get('alice')),
    bob: soulSnap(ctx.societySoul.get('bob')),
  }
  const delta = (a: number, b: number) => (b - a).toFixed(4)

  console.log('--- summary ---')
  console.log(`stopReason=${stopReason}`)
  console.log(`ticks=${ctx.societyScheduler.tickCountOf()}/${maxTicks}`)
  console.log(`exchanges=${ctx.societyScheduler.exchangeCountOf()}/${maxExchanges}`)
  console.log(`roomMessages=${finalHistory.length}`)
  console.log(
    `alice soul Δopenness=${delta(soul0.alice.openness, soul1.alice.openness)} Δtrust=${delta(soul0.alice.trust, soul1.alice.trust)} Δenergy=${delta(soul0.alice.energy, soul1.alice.energy)} mood=${soul1.alice.mood}`,
  )
  console.log(
    `bob soul Δopenness=${delta(soul0.bob.openness, soul1.bob.openness)} Δtrust=${delta(soul0.bob.trust, soul1.bob.trust)} Δenergy=${delta(soul0.bob.energy, soul1.bob.energy)} mood=${soul1.bob.mood}`,
  )
  console.log(
    `llmCallsToday alice=${ctx.societyMemory.getLlmCallsToday('alice')} bob=${ctx.societyMemory.getLlmCallsToday('bob')}`,
  )

  await app.dispose()
  console.log('=== SOCIETY-RUN DONE ===')
}

main().catch((e) => {
  console.error('=== SOCIETY-RUN FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
