/**
 * Shared LLM HTTP helpers: typed errors + retry + timeouts (no API key logging).
 * Per-attempt AbortSignal timeout: SOCIETY_LLM_TIMEOUT_MS (default 75s) → LlmHttpError 408.
 *
 * Sync (main tick / idle / reply): SOCIETY_LLM_SYNC_ATTEMPTS (default 1) — fail fast, no long sleeps.
 * Async (background retry queue): SOCIETY_LLM_MAX_ATTEMPTS (default 10); 429 → 15s, else 30s.
 * agentTickBudgetMs(): hard cap based on sync attempts so hung fetch cannot freeze runTick.
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

/** Background / async-retry max attempts (default 10). */
export function llmMaxAttempts(): number {
  return Math.max(1, societyEnvInt('SOCIETY_LLM_MAX_ATTEMPTS', 10) || 10)
}

/**
 * Main-tick sync attempts (default 1).
 * Tick/idle/reply must not sleep through 30s×N retries on the heartbeat path.
 */
export function llmSyncAttempts(): number {
  return Math.max(1, societyEnvInt('SOCIETY_LLM_SYNC_ATTEMPTS', 1) || 1)
}

/** Per chat/completions HTTP attempt timeout (default 75s). */
export function llmTimeoutMs(): number {
  return Math.max(5_000, societyEnvInt('SOCIETY_LLM_TIMEOUT_MS', 75_000) || 75_000)
}

/** World synced-turn HTTP timeout (default 20s) — fail-fast to wait_fill. */
export function worldLlmTimeoutMs(): number {
  return Math.max(5_000, societyEnvInt('SOCIETY_WORLD_LLM_TIMEOUT_MS', 20_000) || 20_000)
}

/** Outer per-agent deadline for a synced world turn (default 25s). */
export function worldTurnTimeoutMs(): number {
  return Math.max(5_000, societyEnvInt('SOCIETY_TURN_TIMEOUT_MS', 25_000) || 25_000)
}

/**
 * Hard cap for one agent slice of a tick so a hung LLM cannot freeze society forever.
 * Default: timeoutMs * syncAttempts + 45s (override with SOCIETY_AGENT_TICK_BUDGET_MS).
 */
export function agentTickBudgetMs(): number {
  const override = societyEnvInt('SOCIETY_AGENT_TICK_BUDGET_MS', 0)
  if (override > 0) return Math.max(10_000, override)
  const t = llmTimeoutMs()
  const attempts = llmSyncAttempts()
  return t * attempts + 45_000
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

export type LlmRetryMode = 'sync' | 'async'

export interface WithLlmRetriesOpts {
  /** Override attempt count. Default: sync→llmSyncAttempts(), async→llmMaxAttempts(). */
  maxAttempts?: number
  /** sync = main heartbeat (default); async = background retry queue. */
  mode?: LlmRetryMode
}

function sanitizeLlmErr(msg: string): string {
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/sk-[A-Za-z0-9]+/g, '[redacted]')
}

/**
 * Run an LLM attempt fn with retries.
 * Sync mode (default): few/no sleeps — fail fast for the main tick.
 * Async mode: full backoff retries for the background queue.
 */
export async function withLlmRetries<T>(
  label: string,
  attempt: () => Promise<T>,
  log?: LlmRetryLogger,
  opts?: WithLlmRetriesOpts,
): Promise<T> {
  const mode: LlmRetryMode = opts?.mode ?? 'sync'
  const max =
    opts?.maxAttempts ?? (mode === 'async' ? llmMaxAttempts() : llmSyncAttempts())
  let last: unknown
  for (let i = 1; i <= max; i++) {
    try {
      return await attempt()
    } catch (err) {
      last = err
      const msg = err instanceof Error ? err.message : String(err)
      const safe = sanitizeLlmErr(msg)
      const status = err instanceof LlmHttpError ? err.status : 0
      if (i >= max) {
        log?.(
          `${label} ${mode}-fail after ${max} attempt(s) (status=${status || 'n/a'}): ${safe}`,
        )
        throw err instanceof Error ? err : new Error(safe)
      }
      const wait = llmRetryDelayMs(err)
      log?.(
        `${label} ${mode} attempt ${i}/${max} failed (status=${status || 'n/a'}): ${safe}; retry in ${wait / 1000}s`,
      )
      await sleep(wait)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}
