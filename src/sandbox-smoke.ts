/**
 * Sandbox smoke (no LLM required):
 * 1. bwrap writes inside agent workspace → file appears on host
 * 2. bwrap attempt to write ../escape.txt does NOT appear on host parent
 * 3. JS path traversal still rejected (resolveInsideWorkspace + write_file)
 * 4. run_command tool goes through bwrap
 *
 * Never prints API keys.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'
import { agentWorkspaceDir, agentDataDir } from './paths.ts'
import { resolveInsideWorkspace } from '../plugins/society-tools/src/index.ts'
import { assertUrlAllowed, isHostAllowed } from '../plugins/society-sandbox/src/index.ts'

async function main() {
  console.log('=== society-chat sandbox-smoke ===')

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  assert.ok(ctx.societySandbox.bwrapAvailable(), 'bwrap must be available at /usr/bin/bwrap')
  console.log('✓ bwrap available')

  // --- Allowlist unit checks ---
  assert.ok(isHostAllowed('apihub.agnes-ai.com'))
  assert.ok(isHostAllowed('api.duckduckgo.com'))
  assert.ok(isHostAllowed('html.duckduckgo.com'))
  assert.ok(isHostAllowed('en.wikipedia.org'))
  assert.ok(isHostAllowed('upload.wikimedia.org'))
  assert.ok(!isHostAllowed('evil.example.com'))
  assert.ok(!isHostAllowed('agnes-ai.com')) // apex not in exact list
  let rejectedHost = false
  try {
    assertUrlAllowed('https://evil.example.com/x')
  } catch {
    rejectedHost = true
  }
  assert.ok(rejectedHost, 'evil host must be rejected')
  console.log('✓ network allowlist helpers')

  const ws = agentWorkspaceDir('bob')
  const parent = agentDataDir('bob')
  fs.mkdirSync(ws, { recursive: true })

  const insideName = 'bwrap-ok.txt'
  const insideHost = path.join(ws, insideName)
  const escapeHost = path.join(parent, 'escape.txt')
  if (fs.existsSync(insideHost)) fs.unlinkSync(insideHost)
  if (fs.existsSync(escapeHost)) fs.unlinkSync(escapeHost)

  // --- Write inside via bwrap ---
  const writeInside = await ctx.societySandbox.runConfined(
    'bob',
    ['/bin/sh', '-c', `echo sandbox-ok > ${insideName}`],
    { network: false, timeoutMs: 10_000 },
  )
  assert.equal(writeInside.code, 0, `write inside failed: ${writeInside.stderr}`)
  assert.ok(fs.existsSync(insideHost), `expected host file ${insideHost}`)
  const insideText = fs.readFileSync(insideHost, 'utf8').trim()
  assert.ok(insideText.includes('sandbox-ok'), `unexpected content: ${insideText}`)
  console.log(`✓ bwrap wrote inside workspace: ${insideHost} (${insideText})`)

  // --- Escape attempt: ../escape.txt must NOT land on host parent ---
  const escapeAttempt = await ctx.societySandbox.runConfined(
    'bob',
    ['/bin/sh', '-c', 'touch ../escape.txt; echo touched=$?; ls -la ../escape.txt 2>&1 || true'],
    { network: false, timeoutMs: 10_000 },
  )
  // Inside sandbox, touch may "succeed" on tmpfs /home — that is OK.
  // Host parent must remain clean.
  assert.ok(
    !fs.existsSync(escapeHost),
    `ESCAPE WRITE REACHED HOST: ${escapeHost} — isolation broken`,
  )
  console.log(
    `✓ escape write failed on host (no ${escapeHost}); sandbox exit=${escapeAttempt.code} stdout=${JSON.stringify(escapeAttempt.stdout.trim().slice(0, 120))}`,
  )

  // Also try absolute /escape-root.txt
  const absEscapeHost = '/tmp/society-bwrap-escape-root.txt'
  if (fs.existsSync(absEscapeHost)) fs.unlinkSync(absEscapeHost)
  await ctx.societySandbox.runConfined(
    'bob',
    ['/bin/sh', '-c', 'touch /escape-root.txt /tmp/x.txt; echo done'],
    { network: false },
  )
  assert.ok(!fs.existsSync(absEscapeHost), 'absolute escape must not appear on host /tmp probe path')
  assert.ok(!fs.existsSync('/escape-root.txt'), 'absolute /escape-root.txt must not appear on host')
  console.log('✓ absolute escape paths did not reach host root')

  // --- JS path guards still work ---
  const badPaths = ['../../etc/passwd', '../alice/workspace/x', '/etc/passwd', 'notes/../../../etc/passwd']
  for (const bad of badPaths) {
    let rejected = false
    try {
      resolveInsideWorkspace(ws, bad)
    } catch {
      rejected = true
    }
    assert.ok(rejected, `expected JS rejection for ${bad}`)
  }
  const toolReject = await ctx.societyTools.execute(
    'bob',
    'write_file',
    JSON.stringify({ path: '../escape-js.txt', content: 'nope' }),
  )
  assert.ok(/Error:|rejected|escape|traversal|not allowed/i.test(toolReject), toolReject)
  assert.ok(!fs.existsSync(path.join(parent, 'escape-js.txt')), 'JS write_file must not escape')
  console.log(`✓ path traversal still rejected (${badPaths.length} + write_file)`)

  // --- run_command tool path ---
  const viaTool = await ctx.societyTools.execute(
    'bob',
    'run_command',
    JSON.stringify({
      argv: ['/bin/sh', '-c', 'echo tool-bwrap > via-tool.txt'],
      network: false,
    }),
  )
  assert.ok(/exit=0/.test(viaTool), `run_command failed: ${viaTool}`)
  const viaToolHost = path.join(ws, 'via-tool.txt')
  assert.ok(fs.existsSync(viaToolHost), 'run_command should write via-tool.txt')
  console.log(`✓ run_command tool via bwrap → ${viaToolHost}`)

  // Reject raw-looking argv[0]
  const badBin = await ctx.societyTools.execute(
    'bob',
    'run_command',
    JSON.stringify({ argv: ['sh', '-c', 'echo no'] }),
  )
  assert.ok(/Error:/.test(badBin), badBin)
  console.log('✓ run_command rejects non-absolute argv[0]')

  await app.dispose()
  console.log('=== SANDBOX-SMOKE PASS (escape write failed on host) ===')
}

main().catch((e) => {
  console.error('=== SANDBOX-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
