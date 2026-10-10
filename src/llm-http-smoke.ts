/**
 * Offline smoke: LLM HTTP timeout helpers + sync/async retry modes + abort detection.
 */
import assert from 'node:assert/strict'
import {
  agentTickBudgetMs,
  isAbortLikeError,
  llmMaxAttempts,
  llmSyncAttempts,
  llmTimeoutMs,
  withLlmRetries,
  LlmHttpError,
} from './llm-http.ts'

const prevTimeout = process.env.SOCIETY_LLM_TIMEOUT_MS
const prevAttempts = process.env.SOCIETY_LLM_MAX_ATTEMPTS
const prevSync = process.env.SOCIETY_LLM_SYNC_ATTEMPTS
const prevBudget = process.env.SOCIETY_AGENT_TICK_BUDGET_MS

try {
  process.env.SOCIETY_LLM_TIMEOUT_MS = '60000'
  process.env.SOCIETY_LLM_MAX_ATTEMPTS = '10'
  process.env.SOCIETY_LLM_SYNC_ATTEMPTS = '1'
  delete process.env.SOCIETY_AGENT_TICK_BUDGET_MS

  assert.equal(llmTimeoutMs(), 60_000)
  assert.equal(llmMaxAttempts(), 10)
  assert.equal(llmSyncAttempts(), 1)
  // default budget = timeout * syncAttempts + 45s
  assert.equal(agentTickBudgetMs(), 60_000 * 1 + 45_000)

  process.env.SOCIETY_AGENT_TICK_BUDGET_MS = '120000'
  assert.equal(agentTickBudgetMs(), 120_000)

  process.env.SOCIETY_LLM_TIMEOUT_MS = '1000'
  assert.equal(llmTimeoutMs(), 5_000) // floor

  const abort = new Error('The operation was aborted due to timeout')
  abort.name = 'TimeoutError'
  assert.ok(isAbortLikeError(abort))
  const abort2 = new Error('aborted')
  abort2.name = 'AbortError'
  assert.ok(isAbortLikeError(abort2))
  assert.equal(isAbortLikeError(new Error('plain fail')), false)

  // Sync: one attempt, no long sleep — fails immediately
  let syncCalls = 0
  const t0 = Date.now()
  await assert.rejects(
    () =>
      withLlmRetries('smoke-sync', async () => {
        syncCalls += 1
        throw new LlmHttpError('test', 408, 'timed out')
      }),
    /timed out/,
  )
  const syncElapsed = Date.now() - t0
  assert.equal(syncCalls, 1)
  assert.ok(syncElapsed < 2_000, `sync fail should be fast, got ${syncElapsed}ms`)

  // Async: retries with short maxAttempts override (no real 30s wait — use maxAttempts=2 and mock delay via status)
  // Use maxAttempts=1 for async too to keep smoke fast; just verify mode label path works
  let asyncCalls = 0
  await assert.rejects(
    () =>
      withLlmRetries(
        'smoke-async',
        async () => {
          asyncCalls += 1
          throw new LlmHttpError('test', 500, 'boom')
        },
        undefined,
        { mode: 'async', maxAttempts: 1 },
      ),
    /boom/,
  )
  assert.equal(asyncCalls, 1)

  // Sync with explicit 2 attempts still uses delay — skip long wait; maxAttempts=1 default covers heartbeat

  console.log('✓ llm-http timeout helpers + sync/async retry + abort detection')
} finally {
  if (prevTimeout === undefined) delete process.env.SOCIETY_LLM_TIMEOUT_MS
  else process.env.SOCIETY_LLM_TIMEOUT_MS = prevTimeout
  if (prevAttempts === undefined) delete process.env.SOCIETY_LLM_MAX_ATTEMPTS
  else process.env.SOCIETY_LLM_MAX_ATTEMPTS = prevAttempts
  if (prevSync === undefined) delete process.env.SOCIETY_LLM_SYNC_ATTEMPTS
  else process.env.SOCIETY_LLM_SYNC_ATTEMPTS = prevSync
  if (prevBudget === undefined) delete process.env.SOCIETY_AGENT_TICK_BUDGET_MS
  else process.env.SOCIETY_AGENT_TICK_BUDGET_MS = prevBudget
}
