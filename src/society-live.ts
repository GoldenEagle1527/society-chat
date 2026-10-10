/**
 * Interactive society: observe HTTP + scheduler ticks in one process.
 * POST /api/say → room / DM / self-note as human → wakes → ticks reply.
 *
 * Usage: npm run society-live
 * Open http://127.0.0.1:8787/
 *
 * Never logs API keys. Free Agnes / GLM flash only.
 */
import { randomUUID } from 'node:crypto'
import { loadDotEnv, requireAgnesConfig, requireGlmConfig, providerModelLabel } from './env.ts'
import { bootSociety } from './boot.ts'
import {
  createObserveServer,
  listenObserveServer,
  type SayRequest,
} from './observe-server.ts'
import { HUMAN_SPEAKER_ID } from './types.ts'
import type { RoomMessage } from './types.ts'

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw && /^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10))
  return fallback
}

function parseChatId(chatId: string): {
  kind: 'room' | 'dm' | 'self'
  roomId?: string
  peers?: string[]
  agentId?: string
} | null {
  if (chatId.startsWith('room:')) {
    return { kind: 'room', roomId: chatId.slice('room:'.length) }
  }
  if (chatId.startsWith('self:')) {
    return { kind: 'self', agentId: chatId.slice('self:'.length) }
  }
  if (chatId.startsWith('dm:')) {
    const rest = chatId.slice('dm:'.length)
    const parts = rest.split(':')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null
    return { kind: 'dm', peers: parts }
  }
  return null
}

async function main(): Promise<void> {
  console.log('=== society-chat society-live (observe + heartbeat) ===')
  loadDotEnv()
  const agnes = requireAgnesConfig()
  console.log(`✓ Agnes: ${providerModelLabel(agnes)} key=set`)
  try {
    const glm = requireGlmConfig()
    console.log(`✓ GLM: ${providerModelLabel(glm)} key=set`)
  } catch {
    console.log('⚠ GLM not configured — agents routed to glm will fail until GLM_API_KEY is set')
  }

  const maxTicks = envInt('SOCIETY_MAX_TICKS', 10_000)
  const maxExchanges = envInt('SOCIETY_MAX_EXCHANGES', 200)
  const tickMs = envInt('SOCIETY_TICK_MS', 1_500)
  const cooldownMs = envInt('SOCIETY_COOLDOWN_MS', 600)
  const agentCooldownMs = envInt('SOCIETY_AGENT_COOLDOWN_MS', 400)
  const idleStaleMs = envInt('SOCIETY_IDLE_STALE_MS', 8_000)
  const dailyLlmBudget = envInt('SOCIETY_DAILY_LLM_BUDGET', 80)

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  const human = ctx.societyIdentity.registerHuman()
  const alice = ctx.societyIdentity.require('alice')
  const bob = ctx.societyIdentity.require('bob')
  console.log(`✓ speakers: ${human.displayName}(${human.id}), ${alice.displayName}, ${bob.displayName}`)
  console.log(
    `✓ LLM routes: alice ${ctx.societyLlm.describeAgentRoute('alice')} | bob ${ctx.societyLlm.describeAgentRoute('bob')}`,
  )

  ctx.societyScheduler.configure({
    maxExchanges,
    onlyAgents: ['alice', 'bob'],
    cooldownMs,
    agentCooldownMs,
    idleStaleMs,
    dailyLlmBudget,
  })

  let room = ctx.societyRooms.listRooms().find((r) => r.name === 'plaza')
  if (!room) {
    room = ctx.societyRooms.create({
      name: 'plaza',
      createdBy: 'alice',
      members: ['alice', 'bob'],
    })
  } else {
    ctx.societyRooms.join(room.id, 'alice')
    ctx.societyRooms.join(room.id, 'bob')
  }
  ctx.societyScheduler.setDefaultRoom(room.id)
  console.log(`✓ room: ${room.name} (${room.id.slice(0, 8)}…)`)

  if (ctx.societyRooms.historyOf(room.id).length === 0) {
    const seed =
      process.env.SOCIETY_SEED_LINE?.trim() ||
      '广场开机了。人类随时可以插话；我们先打个招呼。'
    ctx.societyRooms.post({ roomId: room.id, from: 'alice', body: seed })
    console.log(`[seed] Alice: ${seed}`)
  }

  let tickRunning = false
  let stopping = false
  let ticksDone = 0

  const onSay = async (req: SayRequest) => {
    // Resolve target from chatId / roomId / toAgentId
    if (req.chatId) {
      const parsed = parseChatId(req.chatId)
      if (!parsed) throw new Error(`invalid chatId: ${req.chatId}`)

      if (parsed.kind === 'room') {
        const target = ctx.societyRooms.require(parsed.roomId!)
        const msg = ctx.societyRooms.post({
          roomId: target.id,
          from: HUMAN_SPEAKER_ID,
          body: req.text,
        })
        console.log(`[you] → ${target.name}: ${req.text}`)
        return {
          ok: true as const,
          message: msg,
          roomId: target.id,
          roomName: target.name,
          chatId: req.chatId,
          kind: 'room' as const,
        }
      }

      if (parsed.kind === 'dm') {
        const peers = parsed.peers!
        const agentPeer = peers.find((p) => p !== HUMAN_SPEAKER_ID && p !== 'human')
        if (!agentPeer) throw new Error('DM needs an agent peer')
        ctx.societyIdentity.require(agentPeer)
        ctx.societyMailbox.deliver({
          to: agentPeer,
          from: HUMAN_SPEAKER_ID,
          kind: 'direct',
          body: req.text,
        })
        // memory updated via society/mail-delivered
        const synthetic: RoomMessage = {
          id: randomUUID(),
          roomId: `dm:${[HUMAN_SPEAKER_ID, agentPeer].sort().join(':')}`,
          from: HUMAN_SPEAKER_ID,
          body: req.text,
          createdAt: new Date().toISOString(),
        }
        console.log(`[you] → DM ${agentPeer}: ${req.text}`)
        return {
          ok: true as const,
          message: synthetic,
          roomId: synthetic.roomId,
          roomName: `dm:${agentPeer}`,
          chatId: req.chatId,
          kind: 'dm' as const,
        }
      }

      if (parsed.kind === 'self') {
        const agentId = parsed.agentId!
        ctx.societyIdentity.require(agentId)
        ctx.societyMailbox.deliver({
          to: agentId,
          from: HUMAN_SPEAKER_ID,
          kind: 'direct',
          body: `[个人空间留言] ${req.text}`,
        })
        try {
          ctx.societyMemory.rememberInteraction(agentId, {
            kind: 'system',
            from: HUMAN_SPEAKER_ID,
            body: req.text,
            role: 'listener',
          })
        } catch {
          /* optional */
        }
        const synthetic: RoomMessage = {
          id: randomUUID(),
          roomId: `self:${agentId}`,
          from: HUMAN_SPEAKER_ID,
          body: req.text,
          createdAt: new Date().toISOString(),
        }
        console.log(`[you] → self:${agentId}: ${req.text}`)
        return {
          ok: true as const,
          message: synthetic,
          roomId: synthetic.roomId,
          roomName: `self:${agentId}`,
          chatId: req.chatId,
          kind: 'self' as const,
        }
      }
    }

    if (req.toAgentId) {
      const agentId = req.toAgentId
      ctx.societyIdentity.require(agentId)
      ctx.societyMailbox.deliver({
        to: agentId,
        from: HUMAN_SPEAKER_ID,
        kind: 'direct',
        body: req.text,
      })
      const synthetic: RoomMessage = {
        id: randomUUID(),
        roomId: `dm:${[HUMAN_SPEAKER_ID, agentId].sort().join(':')}`,
        from: HUMAN_SPEAKER_ID,
        body: req.text,
        createdAt: new Date().toISOString(),
      }
      console.log(`[you] → DM ${agentId}: ${req.text}`)
      return {
        ok: true as const,
        message: synthetic,
        roomId: synthetic.roomId,
        roomName: `dm:${agentId}`,
        chatId: `dm:${[HUMAN_SPEAKER_ID, agentId].sort().join(':')}`,
        kind: 'dm' as const,
      }
    }

    let target = room!
    if (req.roomId) {
      target = ctx.societyRooms.require(req.roomId)
    } else if (req.roomName) {
      const found = ctx.societyRooms.listRooms().find((r) => r.name === req.roomName)
      if (!found) throw new Error(`unknown roomName: ${req.roomName}`)
      target = found
    }
    const msg = ctx.societyRooms.post({
      roomId: target.id,
      from: HUMAN_SPEAKER_ID,
      body: req.text,
    })
    console.log(`[you] → ${target.name}: ${req.text}`)
    return {
      ok: true as const,
      message: msg,
      roomId: target.id,
      roomName: target.name,
      chatId: `room:${target.id}`,
      kind: 'room' as const,
    }
  }

  const srv = createObserveServer({
    mode: 'live',
    onSay,
    liveNote: () =>
      `直播中 · tick=${ticksDone} exchanges=${ctx.societyScheduler.exchangeCountOf()}/${maxExchanges} · 选中会话后发言 · 不暴露密钥`,
  })
  await listenObserveServer(srv)
  console.log(`[live] http://${srv.host}:${srv.port}/`)
  console.log(`[live] POST /api/say (room|dm|self) · caps maxExchanges=${maxExchanges} tickMs=${tickMs}`)
  console.log('  stop: Ctrl+C / SIGTERM')

  ctx.on('society/agent-replied', (p) => {
    const name =
      p.agentId === 'alice' ? 'Alice' : p.agentId === 'bob' ? 'Bob' : p.agentId
    if (p.kind === 'room') console.log(`[live] ${name}: ${p.body}`)
    else if (p.kind === 'direct') console.log(`[live] ${name} → ${p.to} (DM): ${p.body}`)
    else if (p.kind === 'diary') console.log(`[live] ${name} (diary): ${p.body}`)
  })

  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    console.log(`\n[signal] ${sig} — shutting down…`)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  while (!stopping && (maxTicks === 0 || ticksDone < maxTicks)) {
    if (ctx.societyScheduler.exchangeCountOf() >= maxExchanges) {
      console.log(
        '[live] maxExchanges reached — idle UI still up; raise SOCIETY_MAX_EXCHANGES to continue LLM',
      )
      await new Promise((r) => setTimeout(r, 2000))
      if (stopping) break
      continue
    }

    if (!tickRunning) {
      tickRunning = true
      try {
        const result = await ctx.societyScheduler.runTick()
        ticksDone = result.tick
        if (result.action !== 'none' && result.action !== 'skip') {
          console.log(
            `[tick ${result.tick}] action=${result.action}` +
              (result.agentId ? ` agent=${result.agentId}` : '') +
              ` exchanges=${result.exchanges}/${result.maxExchanges}`,
          )
        }
      } catch (err) {
        console.error('[tick error]', err instanceof Error ? err.message : err)
      } finally {
        tickRunning = false
      }
    }

    if (stopping) break
    await new Promise((r) => setTimeout(r, tickMs))
  }

  await srv.close()
  await app.dispose()
  console.log('=== SOCIETY-LIVE DONE ===')
}

main().catch((e) => {
  console.error('=== SOCIETY-LIVE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
