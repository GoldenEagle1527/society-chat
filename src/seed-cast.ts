/**
 * Seed YinYang Field cast + world (Chinese short controller voices).
 * Source of truth for default society after M0 pivot.
 *
 * Usage:
 *   npm run seed-cast
 *   npm run seed-cast -- --reset   # wipe data first (dangerous)
 *
 * Never logs API keys.
 */
import fs from 'node:fs'
import {
  loadDotEnv,
  providerModelLabel,
  requireAgnesConfig,
  requireGlmConfig,
  requireSiliconflowConfig,
  resolveExplicitFreeLlm,
} from './env.ts'
import { bootSociety } from './boot.ts'
import { AGENTS_DATA_ROOT, SOCIETY_STATE_ROOT } from './paths.ts'
import type { AgentLlmPreference, SoulState } from './types.ts'

interface CastMember {
  id: string
  displayName: string
  /** Ultra-short controller voice only (3–5 sentences). No powers / lore. */
  persona: string
  llm: AgentLlmPreference
}

/** Dummy soul kept only for AgentProfile type compat — unused at runtime. */
const SOUL_STUB: Partial<SoulState> = {
  openness: 0,
  trust: 0,
  energy: 0,
  interests: [],
  mood: '',
  notes: 'soul-retired',
}

const VOICE =
  '说话简短、像在场里操控身体的人。先报眼前粒子与能池，再决定动还是说。不讲身世，不卖萌，不问心情。对同伴用称呼，对危险直说。'

const CAST: CastMember[] = [
  {
    id: 'agnes',
    displayName: '阿宁',
    persona: VOICE + '口吻偏谨慎，爱确认一步是否费能。',
    llm: { provider: 'agnes', model: 'agnes-3.0-flash' },
  },
  {
    id: 'glm',
    displayName: '老码',
    persona: VOICE + '口吻冷静，喜欢点出错误码与边界。',
    llm: { provider: 'glm', model: 'glm-4-flash' },
  },
  {
    id: 'xingchen_news',
    displayName: '时辰',
    persona: VOICE + '口吻干脆，行动偏快，偶尔喊同伴一起咬果。',
    llm: { provider: 'siliconflow', model: 'XingChenAGI/Xing4.0-29B' },
  },
  {
    id: 'xingchen_lit',
    displayName: '文心',
    persona: VOICE + '口吻克制，句子干净，少废话。',
    llm: { provider: 'siliconflow', model: 'XingChenAGI/Xing4.0-29B' },
  },
]

function wantReset(): boolean {
  return process.argv.includes('--reset')
}

function wipeData(): void {
  for (const dir of [AGENTS_DATA_ROOT, SOCIETY_STATE_ROOT]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      continue
    }
    for (const name of fs.readdirSync(dir)) {
      fs.rmSync(`${dir}/${name}`, { recursive: true, force: true })
    }
    fs.mkdirSync(dir, { recursive: true })
  }
  console.log('✓ --reset: wiped data/agents and data/society')
}

async function main(): Promise<void> {
  console.log('=== society-chat seed-cast (YinYang Field M0) ===')
  loadDotEnv()

  const agnes = requireAgnesConfig()
  const glm = requireGlmConfig()
  const sf = requireSiliconflowConfig()
  console.log(
    `✓ providers: ${providerModelLabel(agnes)} | ${providerModelLabel(glm)} | ${providerModelLabel(sf)}`,
  )

  if (wantReset()) wipeData()

  process.env.SOCIETY_NO_DEFAULT_SEEDS = '1'
  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  const max = ctx.societyIdentity.maxAgents()
  if (max < CAST.length) {
    throw new Error(`SOCIETY_MAX_AGENTS=${max} < cast size ${CAST.length}`)
  }

  const created: string[] = []
  for (const member of CAST) {
    const llm = resolveExplicitFreeLlm(member.llm.provider, member.llm.model)
    if (ctx.societyIdentity.exists(member.id)) {
      ctx.societyIdentity.setLlmPreference(member.id, llm)
      console.log(`· exists ${member.displayName}(${member.id}) → keep, llm=${llm.provider}=${llm.model}`)
      created.push(member.id)
      continue
    }
    const profile = ctx.societyIdentity.spawn({
      id: member.id,
      displayName: member.displayName,
      persona: member.persona,
      soul: SOUL_STUB,
      llm,
    })
    ctx.societyMemory.load(profile.id)
    created.push(profile.id)
    console.log(`✓ born ${profile.displayName}(${profile.id}) llm=${llm.provider}=${llm.model}`)
  }

  let plaza = ctx.societyRooms.listRooms().find((r) => r.name === 'plaza')
  if (!plaza) {
    plaza = ctx.societyRooms.create({
      name: 'plaza',
      createdBy: 'system',
      members: created,
    })
    console.log(`✓ created plaza (${plaza.id.slice(0, 8)}…)`)
  } else {
    for (const id of created) ctx.societyRooms.join(plaza.id, id)
    console.log(`✓ joined plaza members=${plaza.members.join(',')}`)
  }

  // World seed: cast + human
  const world = ctx.societyWorld.reseed([...created, 'human'])
  ctx.societyWorld.setPlazaRoom(plaza.id)
  console.log(
    `✓ world seeded tick=${world.tick} baseline=${world.conservation_baseline} bots=${world.bots.length} fruit=${world.organics.find((o) => o.kind === 'fruit')?.energy_locked}`,
  )

  if (ctx.societyRooms.historyOf(plaza.id).length === 0) {
    const seed =
      process.env.SOCIETY_SEED_LINE?.trim() ||
      `[世界] 阴阳场开机。硕果在中央，能量守恒。阿宁/老码/时辰/文心已就位。人类可用 /world look 或「观察」；闲聊仍可直接发。`
    ctx.societyRooms.post({ roomId: plaza.id, from: 'system', body: seed })
    console.log(`[seed] system: ${seed}`)
  }

  console.log('Cast:')
  for (const id of created) {
    const a = ctx.societyIdentity.require(id)
    const route = ctx.societyLlm.describeAgentRoute(id)
    console.log(`  - ${a.displayName}(@${a.id}) ${route}`)
  }

  await app.dispose()
  console.log('=== SEED-CAST DONE ===')
}

main().catch((e) => {
  console.error('=== SEED-CAST FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
