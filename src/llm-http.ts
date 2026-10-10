/**
 * Shared LLM HTTP helpers: typed errors + retry (no API key logging).
 * 429 → wait 15s; other errors → wait 30s; max 10 attempts.
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
