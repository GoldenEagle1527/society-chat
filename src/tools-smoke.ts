/**
 * Tools smoke (requires Agnes free flash via .env):
 * 1. Isolation unit-ish: write_file ../../etc/passwd style path must be rejected
 * 2. Alice asks Bob to write isolation-notes.md → assert file in bob workspace
 * 3. Optional: Alice asks Bob to web_search "bubblewrap sandbox linux"
 *
 * Never prints AGNES_API_KEY.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, requireAgnesConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import { agentWorkspaceDir } from './paths.ts'
import { resolveInsideWorkspace } from '../plugins/society-tools/src/index.ts'

async function main() {
  console.log('=== society-chat tools-smoke ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes config: base=${cfg.baseUrl} model=${cfg.model} key=set`)

  // --- Isolation checks (no LLM) ---
  const fakeRoot = path.join(agentWorkspaceDir('bob'), '_isolation_probe')
  fs.mkdirSync(fakeRoot, { recursive: true })
  const badPaths = [
    '../../etc/passwd',
    '../alice/workspace/secret.txt',
    '/etc/passwd',
    '..\\..\\etc\\passwd',
    'notes/../../../etc/passwd',
  ]
  for (const bad of badPaths) {
    let rejected = false
    try {
      resolveInsideWorkspace(fakeRoot, bad)
    } catch {
      rejected = true
    }
    assert.ok(rejected, `expected rejection for path: ${bad}`)
  }
  console.log(`✓ isolation: rejected ${badPaths.length} traversal/absolute paths`)

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  // Direct tool rejection via service (bound to bob)
  const directReject = await ctx.societyTools.execute(
    'bob',
    'write_file',
    JSON.stringify({ path: '../../etc/passwd', content: 'should-not-write' }),
  )
  assert.ok(
    /Error:|rejected|escape|not allowed|traversal/i.test(directReject),
    `expected tool error string, got: ${directReject}`,
  )
  console.log(`✓ write_file traversal via tool.execute: ${directReject.slice(0, 80)}`)

  // Clean prior note if any
  const noteRel = 'isolation-notes.md'
  const noteAbs = path.join(agentWorkspaceDir('bob'), noteRel)
  if (fs.existsSync(noteAbs)) fs.unlinkSync(noteAbs)

  ctx.societyScheduler.enableAutoReply({
    maxExchanges: 1,
    onlyAgents: ['bob'],
  })

  const room = ctx.societyRooms.create({
    name: 'plaza',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  })

  const askWrite =
    'Bob，请用 write_file 在你的 workspace 里写一个短文件 isolation-notes.md，内容写一条关于 Agent 工作区隔离的要点（一两句即可），然后在群里回复时只告诉我文件名。'
  ctx.societyRooms.post({ roomId: room.id, from: 'alice', body: askWrite })
  console.log(`Alice: ${askWrite}`)

  await ctx.societyScheduler.drain(180_000)

  const history1 = ctx.societyRooms.historyOf(room.id)
  assert.ok(history1.length >= 2, `expected Bob reply, got ${history1.length} messages`)
  const bob1 = history1.find((m) => m.from === 'bob')
  assert.ok(bob1, 'Bob did not reply after write request')
  console.log(`Bob: ${bob1!.body}`)

  assert.ok(fs.existsSync(noteAbs), `expected file at ${noteAbs}`)
  const noteText = fs.readFileSync(noteAbs, 'utf8').trim()
  assert.ok(noteText.length > 0, 'isolation-notes.md is empty')
  console.log(`✓ wrote ${noteAbs} (${noteText.length} chars)`)
  console.log(`--- file preview ---\n${noteText.slice(0, 400)}\n-------------------`)

  // --- Optional web_search beat ---
  let webSearchWorked = false
  ctx.societyScheduler.disableAutoReply()
  // Reset handled state by re-enabling with fresh counters
  ctx.societyScheduler.enableAutoReply({
    maxExchanges: 1,
    onlyAgents: ['bob'],
  })
  // enableAutoReply resets exchangeCount; but handledMessageIds persists.
  // Post a new message so a new inbox id is created.

  const askSearch =
    'Bob，请用 web_search 搜索 "bubblewrap sandbox linux"，用一句话中文告诉我要点，并说明你没有把敏感信息写进工作区。'
  ctx.societyRooms.post({ roomId: room.id, from: 'alice', body: askSearch })
  console.log(`Alice: ${askSearch}`)

  try {
    await ctx.societyScheduler.drain(180_000)
    const history2 = ctx.societyRooms.historyOf(room.id)
    const bobReplies = history2.filter((m) => m.from === 'bob')
    assert.ok(bobReplies.length >= 2, 'expected second Bob reply for web_search')
    const bob2 = bobReplies[bobReplies.length - 1]!
    console.log(`Bob: ${bob2.body}`)
    // Heuristic: reply mentions sandbox/bubblewrap/隔离 somehow, or is non-empty after tool use
    assert.ok(bob2.body.trim().length > 0)
    webSearchWorked = true
    console.log('✓ web_search beat completed (Bob replied)')
  } catch (err) {
    console.log(
      `⚠ web_search beat soft-fail: ${err instanceof Error ? err.message : err}`,
    )
  }

  // Also probe web_search tool directly once for diagnostics
  const directSearch = await ctx.societyTools.execute(
    'bob',
    'web_search',
    JSON.stringify({ query: 'bubblewrap sandbox linux' }),
  )
  const searchOk = !directSearch.startsWith('Error:') && directSearch.trim().length > 0
  console.log(`✓ direct web_search: ${searchOk ? 'ok' : 'failed'} → ${directSearch.slice(0, 200).replace(/\n/g, ' | ')}`)
  if (searchOk) webSearchWorked = true

  await app.dispose()
  console.log(`=== TOOLS-SMOKE PASS (note=${noteAbs} web_search=${webSearchWorked}) ===`)
}

main().catch((e) => {
  console.error('=== TOOLS-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
