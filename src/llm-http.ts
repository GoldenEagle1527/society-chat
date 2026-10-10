/**
 * Shared LLM HTTP helpers: typed errors + retry + timeouts (no API key logging).
 * Per-attempt AbortSignal timeout: SOCIETY_LLM_TIMEOUT_MS (default 75s) → LlmHttpError 408.
 * 429 → wait 15s; other errors → wait 30s; max SOCIETY_LLM_MAX_ATTEMPTS (default 10).
 * agentTickBudgetMs(): hard cap so one hung agent cannot freeze runTick forever.
 */
import { societyEnvInt } from './env.ts'

export class LlmHttpError extends Error {
  readonly status: number
  readonly provider: string

  constructor(provider: string, status: number, message: string) {
    super(message)
    this.name = 'LlmHttpError'
    this.provider = provider
    this.status = status
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function llmMaxAttempts(): number {
  return Math.max(1, societyEnvInt('SOCIETY_LLM_MAX_ATTEMPTS', 10) || 10)
}

/** Per chat/completions HTTP attempt timeout (default 75s). */
export function llmTimeoutMs(): number {
  return Math.max(5_000, societyEnvInt('SOCIETY_LLM_TIMEOUT_MS', 75_000) || 75_000)
}

/**
 * Hard cap for one agent slice of a tick so a hung LLM cannot freeze society forever.
 * Default: timeoutMs * min(attempts, 3) + 60s (override with SOCIETY_AGENT_TICK_BUDGET_MS).
 */
export function agentTickBudgetMs(): number {
  const override = societyEnvInt('SOCIETY_AGENT_TICK_BUDGET_MS', 0)
  if (override > 0) return Math.max(10_000, override)
  const t = llmTimeoutMs()
  const attempts = Math.min(llmMaxAttempts(), 3)
  return t * attempts + 60_000
}

export function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true
  return /aborted|abort|timeout/i.test(err.message)
}

/** Delay before next attempt given last failure (429 → 15s, else 30s). */
export function llmRetryDelayMs(err: unknown): number {
  const status =
    err instanceof LlmHttpError
      ? err.status
      : typeof err === 'object' && err && 'status' in err
        ? Number((err as { status: unknown }).status) || 0
        : 0
  return status === 429 ? 15_000 : 30_000
}

export type LlmRetryLogger = (msg: string) => void

/**
 * Run an LLM attempt fn with retries. Never logs secrets.
 * Soft-fails after max attempts by rethrowing the last error.
 */
export async function withLlmRetries<T>(
  label: string,
  attempt: () => Promise<T>,
  log?: LlmRetryLogger,
): Promise<T> {
  const max = llmMaxAttempts()
  let last: unknown
  for (let i = 1; i <= max; i++) {
    try {
      return await attempt()
    } catch (err) {
      last = err
      const msg = err instanceof Error ? err.message : String(err)
      // Never echo Authorization / apiKey fragments if somehow present
      const safe = msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9]+/g, '[redacted]')
      if (i >= max) {
        log?.(`${label} failed after ${max} attempts: ${safe}`)
        throw err instanceof Error ? err : new Error(safe)
      }
      const wait = llmRetryDelayMs(err)
      const status = err instanceof LlmHttpError ? err.status : 0
      log?.(
        `${label} attempt ${i}/${max} failed (status=${status || 'n/a'}): ${safe}; retry in ${wait / 1000}s`,
      )
      await sleep(wait)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}
