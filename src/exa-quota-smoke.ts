/**
 * Exa quota unit smoke (no live Exa / no API keys required):
 * - Beijing day key + 1 slot per modelId
 * - day rollover clears usage
 * - allowlist includes api.exa.ai
 * - web_search without EXA_API_KEY returns clear Error (boot alice/bob)
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  exaQuotaExhaustedMessage,
  isExaQuotaExhausted,
  readExaQuota,
  tryConsumeExaQuota,
  writeExaQuota,
} from '../plugins/society-tools/src/exa-quota.ts'
import { isHostAllowed, assertUrlAllowed } from '../plugins/society-sandbox/src/index.ts'
import { beijingDayStamp } from './beijing-time.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'

async function main() {
  console.log('=== society-chat exa-quota-smoke ===')

  assert.ok(isHostAllowed('api.exa.ai'))
  assertUrlAllowed('https://api.exa.ai/search')
  console.log('✓ api.exa.ai allowlisted')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exa-quota-'))
  const file = path.join(tmp, 'exa-quota.json')
  const modelA = 'agnes-3.0-flash'
  const modelB = 'XingChenAGI/Xing4.0-29B'
  const now = new Date('2026-10-10T08:00:00+08:00')
  const day = beijingDayStamp(now)
  assert.equal(day, '2026-10-10')

  assert.equal(isExaQuotaExhausted(modelA, now, file), false)
  assert.equal(tryConsumeExaQuota(modelA, now, file), true)
  assert.equal(isExaQuotaExhausted(modelA, now, file), true)
  assert.equal(tryConsumeExaQuota(modelA, now, file), false)
  assert.equal(tryConsumeExaQuota(modelB, now, file), true)
  assert.equal(tryConsumeExaQuota(modelB, now, file), false)

  const q = readExaQuota(now, file)
  assert.equal(q.day, day)
  assert.ok(q.used[modelA])
  assert.ok(q.used[modelB])
  console.log('✓ consume once per model same Beijing day')

  const nextDay = new Date('2026-10-11T00:30:00+08:00')
  assert.equal(beijingDayStamp(nextDay), '2026-10-11')
  assert.equal(isExaQuotaExhausted(modelA, nextDay, file), false)
  assert.equal(tryConsumeExaQuota(modelA, nextDay, file), true)
  const q2 = readExaQuota(nextDay, file)
  assert.equal(q2.day, '2026-10-11')
  assert.ok(q2.used[modelA])
  assert.equal(q2.used[modelB], undefined)
  console.log('✓ Beijing day rollover resets quota')

  assert.match(exaQuotaExhaustedMessage(modelA), /Exa daily quota exhausted/)
  writeExaQuota({ day: '2099-01-01', used: { x: 't' } }, file)
  assert.equal(readExaQuota(now, file).day, day) // stale day → fresh empty for today
  console.log('✓ stale file day ignored')

  // loadDotEnv restores empty/missing keys from .env — use a whitespace sentinel so
  // it will not refill, while web_search trim() still treats it as missing.
  const prevKey = process.env.EXA_API_KEY
  process.env.EXA_API_KEY = ' '
  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)
  const out = await ctx.societyTools.execute('bob', 'web_search', JSON.stringify({ query: 'test' }))
  assert.match(out, /EXA_API_KEY is missing/)
  console.log('✓ web_search without key → clear Error')
  if (prevKey != null) process.env.EXA_API_KEY = prevKey
  else delete process.env.EXA_API_KEY

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('=== EXA-QUOTA-SMOKE PASS ===')
  await app.dispose()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
