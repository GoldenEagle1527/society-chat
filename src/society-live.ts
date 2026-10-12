/**
 * Interactive society: observe HTTP + scheduler ticks in one process.
 * POST /api/say → room / DM / self-note as human → wakes → ticks reply.
 *
 * Usage: npm run society-live
 * Open http://127.0.0.1:8787/
 *
 * Never logs API keys. Free Agnes / GLM / SiliconFlow only.
 */
import { randomUUID } from 'node:crypto'
import {
  loadDotEnv,
  parseSpawnLlmInput,
  providerModelLabel,
  requireAgnesConfig,
  requireGlmConfig,
  requireSiliconflowConfig,
} from './env.ts'
import { bootSociety } from './boot.ts'
import {
  createObserveServer,
  listenObserveServer,
  type SayRequest,
  type SpawnAgentApiRequest,
} from './observe-server.ts'
import { readObserveSettings } from './observe-settings.ts'
import { ensureHumanDm } from './dm-threads.ts'
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
  try {
    const sf = requireSiliconflowConfig()
    console.log(`✓ SiliconFlow: ${providerModelLabel(sf)} key=set`)
  } catch {
    console.log(
      '⚠ SiliconFlow not configured — agents routed to siliconflow will fail until SILICONFLOW_API_KEY is set',
    )
  }

  const maxTicks = envInt('SOCIETY_MAX_TICKS', 10_000)
  const maxExchanges = envInt('SOCIETY_MAX_EXCHANGES', 0) // 0 = unlimited
  const tickMs = envInt('SOCIETY_TICK_MS', 1_500)
  const cooldownMs = envInt('SOCIETY_COOLDOWN_MS', 600)
  const agentCooldownMs = envInt('SOCIETY_AGENT_COOLDOWN_MS', 400)
  const idleStaleMs = envInt('SOCIETY_IDLE_STALE_MS', 2_500)
  const maxParallelReplies = Math.max(1, Math.min(8, envInt('SOCIETY_MAX_PARALLEL_REPLIES', 5) || 5))

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  const human = ctx.societyIdentity.registerHuman()
  const allAgents = ctx.societyIdentity.list()
  if (allAgents.length === 0) {
    console.warn(
      '⚠ no agents on disk — run: npm run seed-cast  (or birth in UI). Live will idle until someone exists.',
    )
  }
  console.log(
    `✓ speakers: ${human.displayName}(${human.id}), ` +
      (allAgents.map((a) => a.displayName).join(', ') || '(none)'),
  )
  console.log(
    '✓ LLM routes: ' +
      allAgents.map((a) => `${a.id} ${ctx.societyLlm.describeAgentRoute(a.id)}`).join(' | '),
  )

  const agentIds = allAgents.map((a) => a.id)
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
      createdBy: 'system',
      members: agentIds,
    })
  } else {
    for (const id of agentIds) {
      ctx.societyRooms.join(room.id, id)
    }
  }
  ctx.societyScheduler.setDefaultRoom(room.id)
  ctx.societyTools.setDefaultRoom(room.id)
  ctx.societyWorld.setPlazaRoom(room.id)
  const world = ctx.societyWorld.ensureSeeded(['human'])
  console.log(
    `✓ world: tick=${world.tick} baseline=${world.conservation_baseline} bots=${world.bots.length} ok=${ctx.societyWorld.conservationOk()}`,
  )
  console.log(`✓ room: ${room.name} (${room.id.slice(0, 8)}…) members=${room.members.join(',') || '(empty)'}`)

  // New births during live: join plaza + allowlist so they show up and can act
  ctx.on('society/agent-born', (profile) => {
    try {
      ctx.societyRooms.join(room!.id, profile.id)
      ctx.societyScheduler.allowAgent(profile.id)
      console.log(
        `✓ born ${profile.displayName}(${profile.id}) llm=${ctx.societyLlm.describeAgentRoute(profile.id)} → plaza + allowlist`,
      )
    } catch (err) {
      console.warn(`agent-born hook: ${err instanceof Error ? err.message : err}`)
    }
  })

  if (agentIds.length && ctx.societyRooms.historyOf(room.id).length === 0) {
    const seed =
      process.env.SOCIETY_SEED_LINE?.trim() ||
      '[世界] 阴阳场直播中。生存看 energy_pool/core_integrity。人类：/world look 或直接闲聊。'
    ctx.societyRooms.post({ roomId: room.id, from: 'system', body: seed })
    console.log(`[seed] system: ${seed}`)
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
        // World commands → system lines in plaza/world (not human bubble)
        if (target.name === 'plaza' || target.id === room!.id) {
          const handled = ctx.societyWorld.handleHumanText(req.text)
          if (handled.handled) {
            const synthetic = {
              id: randomUUID(),
              roomId: target.id,
              from: 'system' as const,
              body: handled.systemLines.join('\n') || '[世界] ok',
              createdAt: new Date().toISOString(),
            }
            console.log(`[world] ← you: ${req.text}`)
            return {
              ok: true as const,
              message: synthetic,
              roomId: target.id,
              roomName: target.name,
              chatId: req.chatId,
              kind: 'room' as const,
            }
          }
        }
        const msg = ctx.societyRooms.post({
          roomId: target.id,
          from: HUMAN_SPEAKER_ID,
          body: req.text,
          ...(req.replyTo ? { replyTo: req.replyTo } : {}),
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
        ensureHumanDm(agentPeer)
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
      ensureHumanDm(agentId)
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
    if (target.name === 'plaza' || target.id === room!.id) {
      const handled = ctx.societyWorld.handleHumanText(req.text)
      if (handled.handled) {
        const synthetic = {
          id: randomUUID(),
          roomId: target.id,
          from: 'system' as const,
          body: handled.systemLines.join('\n') || '[世界] ok',
          createdAt: new Date().toISOString(),
        }
        console.log(`[world] ← you: ${req.text}`)
        return {
          ok: true as const,
          message: synthetic,
          roomId: target.id,
          roomName: target.name,
          chatId: `room:${target.id}`,
          kind: 'room' as const,
        }
      }
    }
    const msg = ctx.societyRooms.post({
      roomId: target.id,
      from: HUMAN_SPEAKER_ID,
      body: req.text,
      ...(req.replyTo ? { replyTo: req.replyTo } : {}),
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

  const onCreateRoom = async (req: { name: string; memberIds: string[] }) => {
    const members = [...new Set(req.memberIds.map((x) => String(x).trim()).filter(Boolean))]
    for (const id of members) ctx.societyIdentity.require(id)
    const room = ctx.societyRooms.create({
      name: req.name.trim(),
      createdBy: 'system',
      members,
    })
    console.log(`[room+] ${room.name} (${room.id.slice(0, 8)}…) members=${room.members.join(',')}`)
    return {
      ok: true as const,
      roomId: room.id,
      roomName: room.name,
      chatId: `room:${room.id}`,
      members: [...room.members],
    }
  }

  const onCreateDm = async (req: { agentId: string }) => {
    const agentId = String(req.agentId || '').trim()
    ctx.societyIdentity.require(agentId)
    const ensured = ensureHumanDm(agentId)
    console.log(
      `[dm+] human↔${agentId} chatId=${ensured.chatId}` +
        (ensured.created ? ' (new)' : ' (existing)'),
    )
    return {
      ok: true as const,
      chatId: ensured.chatId,
      agentId,
      created: ensured.created,
      peers: [...ensured.peers],
    }
  }

  const onSpawnAgent = async (req: SpawnAgentApiRequest) => {
    const id = req.id?.trim()
      ? req.id.trim()
      : ctx.societyIdentity.allocateUniqueId(req.displayName)
    const soul: {
      openness?: number
      trust?: number
      energy?: number
      interests?: string[]
      mood?: string
    } = {}
    if (req.openness != null) soul.openness = req.openness
    if (req.trust != null) soul.trust = req.trust
    if (req.energy != null) soul.energy = req.energy
    const interestList = Array.isArray(req.interests)
      ? req.interests
      : typeof req.interests === 'string'
        ? req.interests.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
        : []
    if (interestList.length) soul.interests = interestList.slice(0, 8)
    if (req.mood) soul.mood = req.mood
    // Explicit llm (provider/model) or balanced free routing; agent-born hook joins plaza
    const llmOpt = parseSpawnLlmInput(req)
    const profile = ctx.societyIdentity.spawn({
      id,
      displayName: req.displayName,
      persona: req.persona,
      soul,
      ...(llmOpt ? { llm: llmOpt } : {}),
    })
    ctx.societySoul.load(profile.id)
    ctx.societyMemory.load(profile.id)
    const llm = ctx.societyIdentity.getLlmPreference(profile.id)
    const plaza = ctx.societyRooms.listRooms().find((r) => r.name === 'plaza')
    console.log(
      `[birth+] ${profile.displayName}(${profile.id}) llm=${ctx.societyLlm.describeAgentRoute(profile.id)}`,
    )
    return {
      ok: true as const,
      agent: {
        id: profile.id,
        displayName: profile.displayName,
        persona: profile.persona,
        soul: {
          openness: profile.soul.openness,
          trust: profile.soul.trust,
          energy: profile.soul.energy,
          interests: [...profile.soul.interests],
          mood: profile.soul.mood,
        },
        workspacePath: profile.workspacePath,
        createdAt: profile.createdAt,
      },
      llm: {
        provider: llm.provider,
        ...(llm.model ? { model: llm.model } : {}),
      },
      chatIds: {
        self: `self:${profile.id}`,
        ...(plaza ? { plaza: `room:${plaza.id}` } : {}),
      },
    }
  }

  const srv = createObserveServer({
    mode: 'live',
    onSay,
    onCreateRoom,
    onCreateDm,
    onSpawnAgent,
    getSettings: () => readObserveSettings(),
    liveNote: () => {
      const w = ctx.societyWorld.getState()
      return `阴阳场直播 · societyTick=${ticksDone} worldTick=${w?.tick ?? '?'} · energyΣ=${w ? ctx.societyWorld.totalEnergy() : '?'} · /world look · 不暴露密钥`
    },
  })
  await listenObserveServer(srv)
  console.log(`[live] http://${srv.host}:${srv.port}/`)
  console.log(`[live] POST /api/say|/api/rooms|/api/dm|/api/agents · caps maxExchanges=${maxExchanges} tickMs=${tickMs}`)
  console.log('  stop: Ctrl+C / SIGTERM')

  ctx.on('society/agent-replied', (p) => {
    const name = ctx.societyIdentity.displayNameOf(p.agentId)
    if (p.kind === 'room') console.log(`[live] ${name}: ${p.body}`)
    else if (p.kind === 'direct') console.log(`[live] ${name} → ${p.to} (DM): ${p.body}`)
    else if (p.kind === 'diary') console.log(`[live] ${name} (self/diary): ${p.body}`)
    else if (p.kind === 'idle-skip' || p.kind === 'silent')
      console.log(`[live] ${name} (${p.kind})`)
  })

  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    console.log(`\n[signal] ${sig} — shutting down…`)
  }
  process.on('SIGINT', () => onSignal('SIGINT'))
  process.on('SIGTERM', () => onSignal('SIGTERM'))

  while (!stopping && (maxTicks === 0 || ticksDone < maxTicks)) {
    if (maxExchanges > 0 && ctx.societyScheduler.exchangeCountOf() >= maxExchanges) {
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
        const parallelBits =
          result.parallel && result.parallel.length > 1
            ? ` parallel=[${result.parallel
                .map((p) => `${p.agentId || '?'}:${p.action}`)
                .join(', ')}]`
            : ''
        const line =
          `[tick ${result.tick}] action=${result.action}` +
          (result.agentId ? ` agent=${result.agentId}` : '') +
          parallelBits +
          ` exchanges=${result.exchanges}/${result.maxExchanges}`
        if (result.action !== 'none' && result.action !== 'skip') {
          console.log(line)
        } else if (result.tick % 15 === 0) {
          console.log(`${line} (heartbeat)`)
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
