/**
 * GLM routing smoke: Bob replies via GLM once.
 * Never prints API keys. Prints provider=model.
 */
import assert from 'node:assert/strict'
import { loadDotEnv, requireAgnesConfig, requireGlmConfig, providerModelLabel } from './env.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'

async function main() {
  console.log('=== society-chat glm-smoke ===')
  loadDotEnv()
  const agnes = requireAgnesConfig()
  const glm = requireGlmConfig()
  console.log(`✓ Agnes ready: ${providerModelLabel(agnes)} key=set`)
  console.log(`✓ GLM ready: ${providerModelLabel(glm)} key=set`)

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  const bobPref = ctx.societyIdentity.getLlmPreference('bob')
  const alicePref = ctx.societyIdentity.getLlmPreference('alice')
  assert.equal(bobPref.provider, 'glm', 'bob should route to glm')
  assert.equal(alicePref.provider, 'agnes', 'alice should route to agnes')
  console.log(`✓ prefs: alice→${alicePref.provider} bob→${bobPref.provider}`)

  const bobRoute = ctx.societyLlm.describeAgentRoute('bob')
  const aliceRoute = ctx.societyLlm.describeAgentRoute('alice')
  console.log(`✓ routes: alice ${aliceRoute} | bob ${bobRoute}`)
  assert.match(bobRoute, /^glm=glm-4-flash/i)
  assert.match(aliceRoute, /^agnes=agnes-.*flash/i)

  // Refuse paid GLM model override
  let refused = false
  try {
    ctx.societyIdentity.setLlmPreference('bob', { provider: 'glm', model: 'glm-4-plus' })
    ctx.societyLlm.resolveConfig('bob')
  } catch (err) {
    refused = /glm-4-flash|Refusing GLM/i.test(err instanceof Error ? err.message : String(err))
  }
  // restore bob free model
  ctx.societyIdentity.setLlmPreference('bob', { provider: 'glm', model: 'glm-4-flash' })
  assert.ok(refused, 'paid GLM model must be refused')
  console.log('✓ paid GLM model refused')

  ctx.societyScheduler.configure({
    maxExchanges: 1,
    onlyAgents: ['bob'],
    cooldownMs: 50,
    agentCooldownMs: 0,
    idleStaleMs: 60_000,
    dailyLlmBudget: 40,
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

  const marker = `glm口令-${Date.now().toString(36)}`
  const humanText = `Bob，请用一两句中文打招呼，并原样提到「${marker}」。`
  // Use Alice as speaker so Bob is the only auto-replier (onlyAgents bob)
  ctx.societyRooms.post({
    roomId: room.id,
    from: 'alice',
    body: humanText,
  })
  console.log(`[Alice] ${humanText}`)
  console.log(`[route] bob will reply via ${bobRoute}`)

  let replyBody = ''
  ctx.on('society/agent-replied', (p) => {
    if (p.agentId === 'bob' && p.kind === 'room') {
      replyBody = p.body
      console.log(`[Bob] ${p.body}`)
    }
  })

  for (let i = 0; i < 6; i++) {
    const result = await ctx.societyScheduler.runTick()
    console.log(
      `[tick ${result.tick}] action=${result.action}` +
        (result.agentId ? ` agent=${result.agentId}` : '') +
        ` exchanges=${result.exchanges}`,
    )
    if (replyBody) break
    if (result.action === 'capped') break
    await new Promise((r) => setTimeout(r, 200))
  }

  assert.ok(replyBody, 'Bob must reply via GLM')
  // Soft check: marker often echoed; if not, still OK as long as Chinese reply
  assert.ok(replyBody.length >= 4, 'reply too short')
  console.log(`✓ bob reply via ${bobRoute}`)
  if (replyBody.includes(marker)) console.log('✓ marker echoed')

  await app.dispose()
  console.log('=== GLM-SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== GLM-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
