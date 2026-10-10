/**
 * Public caps / provider presence for Settings drawer.
 * Never includes API keys or secret values.
 */
import {
  ALL_LLM_PROVIDERS,
  configuredFreeProviders,
  defaultFreeModelFor,
  loadDotEnv,
  societyEnvInt,
  type LlmProviderId,
} from './env.ts'
import { getHumanDisplayName } from './human-settings.ts'

export interface ObserveProviderInfo {
  id: LlmProviderId
  configured: boolean
  /** Default free model id when configured (from env); never a key. */
  model: string | null
}

export interface ObserveSettings {
  maxParallelReplies: number
  maxExchanges: number
  /** Always null / unlimited — free models; counters stay on agents. */
  dailyLlmBudget: null
  llmBudgetUnlimited: true
  maxAgents: number
  tickMs: number
  providers: ObserveProviderInfo[]
  allowRemoteSay: boolean
  /** Human operator display name in timelines / UI (persisted). */
  humanDisplayName: string
  /** Hint only — no path traversal of secrets. */
  envNote: string
}

export function readObserveSettings(): ObserveSettings {
  loadDotEnv()
  const configured = new Set(configuredFreeProviders())
  const providers: ObserveProviderInfo[] = ALL_LLM_PROVIDERS.map((id) => {
    const ok = configured.has(id)
    let model: string | null = null
    if (ok) {
      try {
        model = defaultFreeModelFor(id)
      } catch {
        model = null
      }
    }
    return { id, configured: ok, model }
  })
  const flag = (process.env.SOCIETY_OBSERVE_ALLOW_REMOTE_SAY || '').trim()
  const allowRemoteSay = flag === '1' || /^true$/i.test(flag) || /^yes$/i.test(flag)
  return {
    maxParallelReplies: Math.max(1, Math.min(8, societyEnvInt('SOCIETY_MAX_PARALLEL_REPLIES', 5) || 5)),
    maxExchanges: societyEnvInt('SOCIETY_MAX_EXCHANGES', 0),
    dailyLlmBudget: null,
    llmBudgetUnlimited: true,
    maxAgents: societyEnvInt('SOCIETY_MAX_AGENTS', 8),
    tickMs: societyEnvInt('SOCIETY_TICK_MS', 1500),
    providers,
    allowRemoteSay,
    humanDisplayName: getHumanDisplayName(),
    envNote:
      '密钥与模型请写在项目根目录 .env（已 gitignore）。本页与 /api/* 永不返回 API Key；改完需重启 society-live / Docker。',
  }
}
