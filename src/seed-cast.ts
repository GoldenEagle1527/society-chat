/**
 * Seed the user cast (Chinese personas) with explicit free LLM routes.
 * Source of truth for the default society — prefer this over agents/*.json.
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
  persona: string
  soul: Partial<SoulState>
  llm: AgentLlmPreference
}

const CAST: CastMember[] = [
  {
    id: 'agnes',
    displayName: '阿宁',
    persona:
      '刚刚毕业的女大学生，工科专业。对人设与社会都还懵懂好奇，说话真诚、有点害羞，爱问基础问题，偶尔用一点工科比喻。',
    soul: {
      openness: 0.75,
      trust: 0.55,
      energy: 0.65,
      interests: ['学习', '实验', '校园', '入职'],
      mood: '懵懂',
    },
    llm: { provider: 'agnes', model: 'agnes-3.0-flash' },
  },
  {
    id: 'glm',
    displayName: '老码',
    persona:
      '资深程序员，严谨、逻辑紧密。说话简洁有条理，爱追问边界条件与可复现性，不喜欢含糊其辞，偶尔冷幽默。',
    soul: {
      openness: 0.45,
      trust: 0.5,
      energy: 0.55,
      interests: ['架构', '调试', '工程规范', '性能'],
      mood: '专注',
    },
    llm: { provider: 'glm', model: 'glm-4-flash' },
  },
  {
    id: 'xingchen_news',
    displayName: '时辰',
    persona:
      '活泼的在校大学生，对时政与公共议题十分关注。语速快、爱分享新闻热点，敢发表看法，也会听别人补充。',
    soul: {
      openness: 0.85,
      trust: 0.6,
      energy: 0.85,
      interests: ['时政', '辩论', '校园活动', '短视频'],
      mood: '兴奋',
    },
    llm: { provider: 'siliconflow', model: 'XingChenAGI/Xing4.0-29B' },
  },
  {
    id: 'xingchen_lit',
    displayName: '文心',
    persona:
      '温文尔雅的女大学生，文科生，善诗词与历史。语气温柔克制，常引典故或诗句点题，重视共情与分寸。',
    soul: {
      openness: 0.7,
      trust: 0.65,
      energy: 0.5,
      interests: ['诗词', '历史', '阅读', '茶'],
      mood: '恬静',
    },
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
  console.log('=== society-chat seed-cast ===')
  loadDotEnv()

  // Validate all three free channels up front (never print keys)
  const agnes = requireAgnesConfig()
  const glm = requireGlmConfig()
  const sf = requireSiliconflowConfig()
  console.log(
    `✓ providers: ${providerModelLabel(agnes)} | ${providerModelLabel(glm)} | ${providerModelLabel(sf)}`,
  )

  if (wantReset()) wipeData()

  // Boot without auto JSON seeds — we spawn the cast ourselves
  process.env.SOCIETY_NO_DEFAULT_SEEDS = '1'
  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  // Raise cap if needed for 4 cast members + room to grow
  const max = ctx.societyIdentity.maxAgents()
  if (max < CAST.length) {
    throw new Error(`SOCIETY_MAX_AGENTS=${max} < cast size ${CAST.length}`)
  }

  const created: string[] = []
  for (const member of CAST) {
    const llm = resolveExplicitFreeLlm(member.llm.provider, member.llm.model)
    if (ctx.societyIdentity.exists(member.id)) {
      // Update preference if already present (idempotent re-seed of llm/persona lightly)
      ctx.societyIdentity.setLlmPreference(member.id, llm)
      console.log(`· exists ${member.displayName}(${member.id}) → keep, llm=${llm.provider}=${llm.model}`)
      created.push(member.id)
      continue
    }
    const profile = ctx.societyIdentity.spawn({
      id: member.id,
      displayName: member.displayName,
      persona: member.persona,
      soul: member.soul,
      llm,
    })
    ctx.societySoul.load(profile.id)
    ctx.societyMemory.load(profile.id)
    created.push(profile.id)
    console.log(`✓ born ${profile.displayName}(${profile.id}) llm=${llm.provider}=${llm.model}`)
  }

  // Plaza with all cast members
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

  if (ctx.societyRooms.historyOf(plaza.id).length === 0) {
    const seed =
      process.env.SOCIETY_SEED_LINE?.trim() ||
      '广场开机了。阿宁、老码、时辰、文心都在——人类可以随时插话。'
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
