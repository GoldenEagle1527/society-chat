/**
 * Offline smoke: LLM HTTP timeout helpers + abort detection.
 */
import assert from 'node:assert/strict'
import {
  agentTickBudgetMs,
  isAbortLikeError,
  llmMaxAttempts,
  llmTimeoutMs,
} from './llm-http.ts'

const prevTimeout = process.env.SOCIETY_LLM_TIMEOUT_MS
const prevAttempts = process.env.SOCIETY_LLM_MAX_ATTEMPTS
const prevBudget = process.env.SOCIETY_AGENT_TICK_BUDGET_MS

try {
  process.env.SOCIETY_LLM_TIMEOUT_MS = '60000'
  process.env.SOCIETY_LLM_MAX_ATTEMPTS = '10'
  delete process.env.SOCIETY_AGENT_TICK_BUDGET_MS

  assert.equal(llmTimeoutMs(), 60_000)
  assert.equal(llmMaxAttempts(), 10)
  // default budget = timeout * min(attempts, 3) + 60s
  assert.equal(agentTickBudgetMs(), 60_000 * 3 + 60_000)

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

  console.log('✓ llm-http timeout helpers + abort detection')
} finally {
  if (prevTimeout === undefined) delete process.env.SOCIETY_LLM_TIMEOUT_MS
  else process.env.SOCIETY_LLM_TIMEOUT_MS = prevTimeout
  if (prevAttempts === undefined) delete process.env.SOCIETY_LLM_MAX_ATTEMPTS
  else process.env.SOCIETY_LLM_MAX_ATTEMPTS = prevAttempts
  if (prevBudget === undefined) delete process.env.SOCIETY_AGENT_TICK_BUDGET_MS
  else process.env.SOCIETY_AGENT_TICK_BUDGET_MS = prevBudget
}
