/**
 * Load .env into process.env without printing secret values.
 * Does not override variables already set in the environment.
 */
import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT } from './paths.ts'

export function loadDotEnv(filePath = path.join(PROJECT_ROOT, '.env')): void {
  if (!fs.existsSync(filePath)) return
  const text = fs.readFileSync(filePath, 'utf8')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env) || process.env[key] === '') {
      process.env[key] = value
    }
  }
}

export type LlmProviderId = 'agnes' | 'glm' | 'siliconflow'

export const ALL_LLM_PROVIDERS: LlmProviderId[] = ['agnes', 'glm', 'siliconflow']

export interface LlmEndpointConfig {
  provider: LlmProviderId
  apiKey: string
  baseUrl: string
  model: string
}

/** @deprecated alias — prefer LlmEndpointConfig */
export type AgnesConfig = LlmEndpointConfig

const AGNES_FREE_FLASH = /^(agnes-2\.5-flash|agnes-3\.0-flash)$/i
/** Free GLM flash only (glm-4-flash, glm-4-flash-250414, …). */
const GLM_FREE_FLASH = /glm-4-flash/i
/** Free SiliconFlow model only (exact id). */
const SILICONFLOW_FREE = /^XingChenAGI\/Xing4\.0-29B$/i
export const SILICONFLOW_DEFAULT_MODEL = 'XingChenAGI/Xing4.0-29B'

/** Normalize provider strings from llm.json / UI (never invent paid providers). */
export function normalizeProviderId(raw: unknown): LlmProviderId {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (s === 'glm' || s === 'zhipu' || s === 'zhipuai') return 'glm'
  if (s === 'siliconflow' || s === 'silicon' || s === 'sf' || s === 'silicon-flow') {
    return 'siliconflow'
  }
  return 'agnes'
}

export function assertAgnesFreeModel(model: string): void {
  if (!AGNES_FREE_FLASH.test(model)) {
    throw new Error(
      `Refusing Agnes model "${model}": must use free agnes-3.0-flash or agnes-2.5-flash.`,
    )
  }
}

export function assertGlmFreeModel(model: string): void {
  if (!GLM_FREE_FLASH.test(model)) {
    throw new Error(
      `Refusing GLM model "${model}": society-chat only allows free flash ids matching /glm-4-flash/i (e.g. glm-4-flash, glm-4-flash-250414).`,
    )
  }
}

export function assertSiliconflowFreeModel(model: string): void {
  if (!SILICONFLOW_FREE.test(model.trim())) {
    throw new Error(
      `Refusing SiliconFlow model "${model}": society-chat only allows free XingChenAGI/Xing4.0-29B.`,
    )
  }
}

/** Resolve Agnes settings; throws if API key missing. Never logs the key. */
export function requireAgnesConfig(modelOverride?: string): LlmEndpointConfig {
  loadDotEnv()
  const apiKey = process.env.AGNES_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'AGNES_API_KEY is missing. Put it in .env (gitignored) or export it.',
    )
  }
  const baseUrl = (process.env.AGNES_BASE_URL?.trim() || 'https://apihub.agnes-ai.com/v1').replace(
    /\/+$/,
    '',
  )
  const model = (modelOverride || process.env.AGNES_MODEL?.trim() || 'agnes-3.0-flash').trim()
  assertAgnesFreeModel(model)
  return { provider: 'agnes', apiKey, baseUrl, model }
}

/** Resolve GLM (Zhipu) OpenAI-compatible settings. Never logs the key. */
export function requireGlmConfig(modelOverride?: string): LlmEndpointConfig {
  loadDotEnv()
  const apiKey = process.env.GLM_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'GLM_API_KEY is missing. Put it in .env (gitignored) or export it.',
    )
  }
  const baseUrl = (
    process.env.GLM_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/paas/v4'
  ).replace(/\/+$/, '')
  const model = (modelOverride || process.env.GLM_MODEL?.trim() || 'glm-4-flash').trim()
  assertGlmFreeModel(model)
  return { provider: 'glm', apiKey, baseUrl, model }
}

/** Resolve SiliconFlow OpenAI-compatible settings. Never logs the key. */
export function requireSiliconflowConfig(modelOverride?: string): LlmEndpointConfig {
  loadDotEnv()
  const apiKey = process.env.SILICONFLOW_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'SILICONFLOW_API_KEY is missing. Put it in .env (gitignored) or export it.',
    )
  }
  const baseUrl = (
    process.env.SILICONFLOW_BASE_URL?.trim() || 'https://api.siliconflow.cn/v1'
  ).replace(/\/+$/, '')
  const model = (
    modelOverride ||
    process.env.SILICONFLOW_MODEL?.trim() ||
    SILICONFLOW_DEFAULT_MODEL
  ).trim()
  assertSiliconflowFreeModel(model)
  return { provider: 'siliconflow', apiKey, baseUrl, model }
}

export function requireProviderConfig(
  provider: LlmProviderId,
  modelOverride?: string,
): LlmEndpointConfig {
  const p = normalizeProviderId(provider)
  if (p === 'glm') return requireGlmConfig(modelOverride)
  if (p === 'siliconflow') return requireSiliconflowConfig(modelOverride)
  return requireAgnesConfig(modelOverride)
}

/** Safe label for logs — never includes apiKey. */
export function providerModelLabel(cfg: LlmEndpointConfig): string {
  return `${cfg.provider}=${cfg.model}`
}

/** Max auto-replies per boot when enableAutoReply omits maxExchanges (scheduler). */
export function societyMaxExchanges(defaultValue = 3): number {
  const raw = process.env.SOCIETY_MAX_EXCHANGES?.trim()
  if (raw && /^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10))
  return defaultValue
}

/** Integer env with fallback (non-negative). */
export function societyEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim()
  if (raw && /^\d+$/.test(raw)) return Math.max(0, parseInt(raw, 10))
  return defaultValue
}

/** Providers that currently have an API key configured (order: agnes, glm, siliconflow). */
export function configuredFreeProviders(): LlmProviderId[] {
  loadDotEnv()
  const out: LlmProviderId[] = []
  if (process.env.AGNES_API_KEY?.trim()) out.push('agnes')
  if (process.env.GLM_API_KEY?.trim()) out.push('glm')
  if (process.env.SILICONFLOW_API_KEY?.trim()) out.push('siliconflow')
  return out
}

/** Default free model id for a provider (env override still free-guarded at require*). */
export function defaultFreeModelFor(provider: LlmProviderId): string {
  loadDotEnv()
  const p = normalizeProviderId(provider)
  if (p === 'glm') {
    const m = (process.env.GLM_MODEL?.trim() || 'glm-4-flash').trim()
    assertGlmFreeModel(m)
    return m
  }
  if (p === 'siliconflow') {
    const m = (process.env.SILICONFLOW_MODEL?.trim() || SILICONFLOW_DEFAULT_MODEL).trim()
    assertSiliconflowFreeModel(m)
    return m
  }
  const m = (process.env.AGNES_MODEL?.trim() || 'agnes-3.0-flash').trim()
  assertAgnesFreeModel(m)
  return m
}

/** Working-memory soft cap before LLM consolidate (default 20). */
export function societyWorkingMax(defaultValue = 20): number {
  return societyEnvInt('SOCIETY_WORKING_MAX', defaultValue) || defaultValue
}

/** Min ms between LLM consolidates per agent (default 5 minutes). */
export function societyConsolidateCooldownMs(defaultValue = 300_000): number {
  return societyEnvInt('SOCIETY_CONSOLIDATE_COOLDOWN_MS', defaultValue)
}

/** Known free providers (keys may or may not be present). */
export function isKnownFreeProvider(raw: unknown): boolean {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  return (
    s === 'agnes' ||
    s === 'glm' ||
    s === 'zhipu' ||
    s === 'zhipuai' ||
    s === 'siliconflow' ||
    s === 'silicon' ||
    s === 'sf' ||
    s === 'silicon-flow'
  )
}

/**
 * Validate an explicit spawn LLM route:
 * - provider must be a known free id AND currently configured (API key present)
 * - model must pass that provider's free allowlist (defaulted when omitted)
 * Never logs keys.
 */
export function resolveExplicitFreeLlm(
  providerRaw: unknown,
  modelRaw?: unknown,
): { provider: LlmProviderId; model: string } {
  loadDotEnv()
  if (!isKnownFreeProvider(providerRaw)) {
    throw new Error(
      `Unknown or paid provider "${String(providerRaw)}": use agnes | glm | siliconflow`,
    )
  }
  const provider = normalizeProviderId(providerRaw)
  const configured = configuredFreeProviders()
  if (!configured.includes(provider)) {
    throw new Error(
      `Provider "${provider}" is not configured (missing API key in .env). Configured: ${configured.join(',') || '(none)'}`,
    )
  }
  const model =
    modelRaw != null && String(modelRaw).trim()
      ? String(modelRaw).trim()
      : defaultFreeModelFor(provider)
  if (provider === 'glm') assertGlmFreeModel(model)
  else if (provider === 'siliconflow') assertSiliconflowFreeModel(model)
  else assertAgnesFreeModel(model)
  return { provider, model }
}

/** Parse spawn/API llm field: { provider, model? } or flat provider + model. */
export function parseSpawnLlmInput(input: {
  llm?: { provider?: unknown; model?: unknown } | null
  provider?: unknown
  model?: unknown
}): { provider: LlmProviderId; model: string } | undefined {
  const fromObj = input.llm && typeof input.llm === 'object' ? input.llm : null
  const provider = fromObj?.provider ?? input.provider
  if (provider == null || String(provider).trim() === '') return undefined
  const model = fromObj?.model ?? input.model
  return resolveExplicitFreeLlm(provider, model)
}
