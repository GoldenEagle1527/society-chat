/**
 * Image smoke (optional; free agnes-image-2.5-flash):
 * Ask Bob once to generate a tiny icon image. Skip gracefully on API failure.
 * Never prints AGNES_API_KEY.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, requireAgnesConfig } from './env.ts'
import { bootSociety } from './boot.ts'
import { agentWorkspaceDir } from './paths.ts'

async function main() {
  console.log('=== society-chat image-smoke ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes config: base=${cfg.baseUrl} model=${cfg.model} key=set`)
  console.log('✓ image model: agnes-image-2.5-flash (free)')

  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app

  const imagesDir = path.join(agentWorkspaceDir('bob'), 'images')
  fs.mkdirSync(imagesDir, { recursive: true })
  const before = new Set(fs.readdirSync(imagesDir))

  // Direct tool call first — clearer skip on API failure
  const direct = await ctx.societyTools.execute(
    'bob',
    'generate_image',
    JSON.stringify({
      prompt: 'A tiny flat vector icon of a sandbox box, simple, white background, minimal',
      filename: 'sandbox-icon.png',
    }),
  )
  console.log(`generate_image → ${direct.slice(0, 300)}`)

  if (/^Error:/i.test(direct)) {
    console.log(`⚠ IMAGE-SMOKE SKIPPED: ${direct}`)
    await app.dispose()
    console.log('=== IMAGE-SMOKE SKIP (API failed gracefully) ===')
    return
  }

  const after = fs.readdirSync(imagesDir)
  const added = after.filter((f) => !before.has(f))
  assert.ok(added.length >= 1 || fs.existsSync(path.join(imagesDir, 'sandbox-icon.png')) || fs.existsSync(path.join(imagesDir, 'sandbox-icon.png.url.txt')), 'expected image or url note under bob/images')
  console.log(`✓ bob images/: ${after.join(', ') || '(empty?)'}`)

  // Optional: one LLM turn that may call generate_image (already have a file; keep light)
  ctx.societyScheduler.enableAutoReply({ maxExchanges: 1, onlyAgents: ['bob'] })
  const room = ctx.societyRooms.create({
    name: 'plaza',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  })
  ctx.societyRooms.post({
    roomId: room.id,
    from: 'alice',
    body: 'Bob，如果你刚才已经生成过图标，请用一句话告诉我图片保存在哪个相对路径；不要再生成新图。',
  })
  try {
    await ctx.societyScheduler.drain(120_000)
    const hist = ctx.societyRooms.historyOf(room.id)
    const bob = hist.find((m) => m.from === 'bob')
    if (bob) console.log(`Bob: ${bob.body}`)
  } catch (err) {
    console.log(`⚠ LLM follow-up soft-fail: ${err instanceof Error ? err.message : err}`)
  }

  await app.dispose()
  console.log('=== IMAGE-SMOKE PASS ===')
}

main().catch((e) => {
  console.error('=== IMAGE-SMOKE FAIL ===')
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
