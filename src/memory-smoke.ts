/**
 * Force working-memory overflow → LLM consolidate → episodic grew.
 * Uses Alice's free Agnes route once. Never prints API keys.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, requireAgnesConfig, societyWorkingMax } from './env.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'
import { agentDataDir } from './paths.ts'

async function main() {
  console.log('=== society-chat memory-smoke ===')
  loadDotEnv()
  process.env.SOCIETY_WORKING_MAX = process.env.SOCIETY_WORKING_MAX || '8'
  process.env.SOCIETY_CONSOLIDATE_COOLDOWN_MS = process.env.SOCIETY_CONSOLIDATE_COOLDOWN_MS || '0'

  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes config: base=${cfg.baseUrl} model=${cfg.model} key=set`)

  // Pre-seed a clean memory.json so cache starts empty of episodic
  const agentId = 'alice'
  const memFile = path.join(agentDataDir(agentId), 'memory.json')
  fs.mkdirSync(agentDataDir(agentId), { recursive: true })
  fs.writeFileSync(
    memFile,
    JSON.stringify(
      {
        working: [],
        episodic: [],
        semantic: [],
        updatedAt: new Date().toISOString(),
        budget: { day: new Date().toISOString().slice(0, 10), llmCalls: 0 },
      },
      null,
      2,
    ),
    'utf8',
  )

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)
  assert.ok(ctx.societyIdentity.get('alice'), 'alice required')

  // Inject under high soft-cap to avoid async race
  process.env.SOCIETY_WORKING_MAX = '1000'
  const before = ctx.societyMemory.load(agentId)
  const epiBefore = before.episodic.length
  console.log(`✓ SOCIETY_WORKING_MAX inject=1000; before working=${before.working.length} episodic=${epiBefore}`)
  assert.equal(epiBefore, 0, 'expected clean episodic for smoke')

  const need = 14
  for (let i = 0; i < need; i++) {
    ctx.societyMemory.rememberInteraction(agentId, {
      kind: 'room',
      from: i % 2 === 0 ? 'bob' : 'alice',
      body: `记忆压缩测试第 ${i + 1} 条：讨论隔离、配额与审计哈希链。细节编号 ${i + 1}。`,
      roomId: 'smoke-room',
      roomName: 'smoke',
      role: i % 2 === 0 ? 'listener' : 'speaker',
      at: new Date(Date.now() - (need - i) * 1000).toISOString(),
    })
  }

  process.env.SOCIETY_WORKING_MAX = '8'
  const soft = ctx.societyMemory.workingMax()
  console.log(`✓ soft cap now ${soft} (societyWorkingMax=${societyWorkingMax()})`)
  const mid = ctx.societyMemory.load(agentId)
  console.log(`✓ after inject: working=${mid.working.length} episodic=${mid.episodic.length}`)
  assert.ok(mid.working.length > soft, `expected working > ${soft}, got ${mid.working.length}`)

  const result = await ctx.societyMemory.consolidateIfNeeded(agentId, {
    force: true,
    bypassCooldown: true,
  })
  console.log(
    `✓ consolidate result: did=${result.did} reason=${result.reason} episodicAdded=${result.episodicAdded ?? 0}`,
  )
  assert.ok(result.did, `expected LLM consolidate success, got ${result.reason}`)

  const after = ctx.societyMemory.load(agentId)
  assert.ok(
    after.episodic.length > epiBefore,
    `episodic should grow: before=${epiBefore} after=${after.episodic.length}`,
  )
  assert.ok(
    after.working.length <= soft,
    `working should be <= ${soft}, got ${after.working.length}`,
  )
  console.log(
    `✓ after: working=${after.working.length} episodic=${after.episodic.length} semantic=${after.semantic.length}`,
  )
  console.log(`  latest episodic: ${after.episodic[after.episodic.length - 1]?.summary.slice(0, 120)}`)

  const logPath = path.join(agentDataDir(agentId), 'memory-log.jsonl')
  assert.ok(fs.existsSync(logPath), 'memory-log.jsonl missing')
  const logTail = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop() || ''
  assert.ok(logTail.includes('llm-consolidate') || logTail.includes('dumb-fallback'), logTail)
  assert.ok(!/api[_-]?key|sk-/i.test(logTail), 'memory-log must not contain secrets')
  console.log('✓ memory-log.jsonl auditable, no secrets')

  await app.dispose()
  console.log('=== MEMORY-SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== MEMORY-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
