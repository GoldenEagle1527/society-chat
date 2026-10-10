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

export type LlmProviderId = 'agnes' | 'glm'

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

export function requireProviderConfig(
  provider: LlmProviderId,
  modelOverride?: string,
): LlmEndpointConfig {
  if (provider === 'glm') return requireGlmConfig(modelOverride)
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
