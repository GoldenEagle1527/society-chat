/**
 * Spawn two agents → when both Agnes+GLM keys present, providers must differ
 * (balanced routing). Never prints API keys.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { configuredFreeProviders, loadDotEnv, requireAgnesConfig, requireGlmConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'
import { agentDataDir } from './paths.ts'

async function wipe(id: string) {
  const dir = agentDataDir(id)
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

async function main() {
  console.log('=== society-chat spawn-route-smoke ===')
  loadDotEnv()
  requireAgnesConfig()
  requireGlmConfig()
  const providers = configuredFreeProviders()
  console.log(`✓ configured free providers: ${providers.join(',') || '(none)'}`)
  assert.ok(providers.includes('agnes') && providers.includes('glm'), 'need both keys for this smoke')

  await wipe('dana')
  await wipe('erin')

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  // Fixture pair routes
  assert.equal(ctx.societyIdentity.getLlmPreference('alice').provider, 'agnes')
  assert.equal(ctx.societyIdentity.getLlmPreference('bob').provider, 'glm')
  console.log('✓ fixtures: alice=agnes bob=glm')

  const a = await ctx.societyTools.execute(
    'alice',
    'spawn_agent',
    JSON.stringify({
      id: 'dana',
      displayName: 'Dana',
      persona: '路由测试甲：冷静的运维。',
    }),
  )
  assert.ok(!a.startsWith('Error:'), a)
  const dana = JSON.parse(a) as { id: string; llm?: { provider: string; model?: string } }
  assert.equal(dana.id, 'dana')
  assert.ok(dana.llm?.provider, 'dana.llm missing')
  console.log(`✓ dana llm=${dana.llm!.provider}=${dana.llm!.model || ''}`)

  const b = await ctx.societyTools.execute(
    'alice',
    'spawn_agent',
    JSON.stringify({
      id: 'erin',
      displayName: 'Erin',
      persona: '路由测试乙：活泼的产品。',
    }),
  )
  assert.ok(!b.startsWith('Error:'), b)
  const erin = JSON.parse(b) as { id: string; llm?: { provider: string; model?: string } }
  assert.equal(erin.id, 'erin')
  assert.ok(erin.llm?.provider, 'erin.llm missing')
  console.log(`✓ erin llm=${erin.llm!.provider}=${erin.llm!.model || ''}`)

  assert.notEqual(
    dana.llm!.provider,
    erin.llm!.provider,
    `expected alternating providers, got dana=${dana.llm!.provider} erin=${erin.llm!.provider}`,
  )
  console.log('✓ dana and erin use different free providers')

  // Disk llm.json matches
  const danaDisk = JSON.parse(fs.readFileSync(`${agentDataDir('dana')}/llm.json`, 'utf8')) as {
    provider: string
  }
  const erinDisk = JSON.parse(fs.readFileSync(`${agentDataDir('erin')}/llm.json`, 'utf8')) as {
    provider: string
  }
  assert.equal(danaDisk.provider, dana.llm!.provider)
  assert.equal(erinDisk.provider, erin.llm!.provider)
  console.log('✓ llm.json on disk matches spawn result')

  if (providers.includes('siliconflow')) {
    await wipe('fran')
    const explicit = await ctx.societyTools.execute(
      'alice',
      'spawn_agent',
      JSON.stringify({
        id: 'fran',
        displayName: 'Fran',
        persona: '显式指定硅基流动。',
        provider: 'siliconflow',
        model: 'XingChenAGI/Xing4.0-29B',
      }),
    )
    assert.ok(!explicit.startsWith('Error:'), explicit)
    const fran = JSON.parse(explicit) as { id: string; llm?: { provider: string; model?: string } }
    assert.equal(fran.llm?.provider, 'siliconflow')
    assert.equal(fran.llm?.model, 'XingChenAGI/Xing4.0-29B')
    console.log('✓ explicit spawn provider=siliconflow')
    await wipe('fran')
  } else {
    console.log('⚠ skip explicit siliconflow spawn (no SILICONFLOW_API_KEY)')
  }

  // Carol (if present) stays agnes unless wiped — birth-smoke sets default via spawn balance;
  // existing carol llm.json may already be agnes. Just note.
  const carol = ctx.societyIdentity.get('carol')
  if (carol) {
    console.log(`✓ carol present route=${ctx.societyLlm.describeAgentRoute('carol')}`)
  }

  await wipe('dana')
  await wipe('erin')
  await app.dispose()
  console.log('=== SPAWN-ROUTE-SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== SPAWN-ROUTE-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
