/**
 * society-identity — Agent registry + private workspace bootstrap + birth.
 * Cordis service name: `societyIdentity`
 */
import fs from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, AgentLlmPreference, AgentProfile, SoulState } from '../../../src/types.ts'
import { HUMAN_SPEAKER_ID, speakerLabel } from '../../../src/types.ts'
import {
  configuredFreeProviders,
  defaultFreeModelFor,
  loadDotEnv,
  societyEnvInt,
  type LlmProviderId,
} from '../../../src/env.ts'
import { AGENTS_DATA_ROOT, AGENTS_SEED_ROOT, agentDataDir, agentWorkspaceDir } from '../../../src/paths.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyIdentity: SocietyIdentityService
  }
  interface Events {
    'society/identity-registered'(profile: AgentProfile): void
    'society/agent-born'(profile: AgentProfile): void
  }
}

export interface RegisterAgentInput {
  id: AgentId
  displayName: string
  persona: string
  soul?: Partial<SoulState>
  llm?: AgentLlmPreference
}

const DEFAULT_SOUL: SoulState = {
  openness: 0.5,
  trust: 0.5,
  energy: 0.5,
  interests: [],
  mood: '平静',
}

const RESERVED_IDS = new Set(['system', 'room', 'self', 'admin', 'observe', 'human'])

/** Seed / fallback defaults: Bob → GLM; Alice/Carol/others → Agnes. */
export function defaultLlmFor(agentId: string): AgentLlmPreference {
  if (agentId === 'bob') return { provider: 'glm', model: 'glm-4-flash' }
  return { provider: 'agnes', model: 'agnes-3.0-flash' }
}

/**
 * Pick free provider with fewest existing agents (balance Agnes RPM vs GLM).
 * Only considers providers that have API keys configured.
 * Seeds (Alice/Bob/Carol) keep defaultLlmFor / explicit llm; this is for spawn().
 */
export function pickBalancedLlm(existing: AgentLlmPreference[]): AgentLlmPreference {
  const available = configuredFreeProviders()
  const pool: LlmProviderId[] = available.length ? available : ['agnes']
  if (pool.length === 1) {
    const p = pool[0]!
    return { provider: p, model: defaultFreeModelFor(p) }
  }
  const counts: Record<LlmProviderId, number> = { agnes: 0, glm: 0 }
  for (const pref of existing) {
    if (pref.provider === 'glm') counts.glm += 1
    else counts.agnes += 1
  }
  // Prefer fewer agents on that provider
  let best = pool[0]!
  for (const p of pool) {
    if (counts[p] < counts[best]) best = p
  }
  // Tie-break: opposite of the most recently listed agent (spreads consecutive spawns)
  const tied = pool.filter((p) => counts[p] === counts[best])
  if (tied.length > 1 && existing.length > 0) {
    const last = existing[existing.length - 1]!
    const opposite: LlmProviderId = last.provider === 'glm' ? 'agnes' : 'glm'
    if (tied.includes(opposite)) best = opposite
  }
  return { provider: best, model: defaultFreeModelFor(best) }
}

function writeLlmPreference(agentId: string, pref: AgentLlmPreference): void {
  const dataDir = agentDataDir(agentId)
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'llm.json')
  const payload: AgentLlmPreference = {
    provider: pref.provider === 'glm' ? 'glm' : 'agnes',
    ...(pref.model ? { model: String(pref.model).trim() } : {}),
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

/** Lowercase slug: [a-z][a-z0-9_-]{1,31} */
export function sanitizeAgentId(raw: string): string {
  const id = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (!id || id.length < 2 || id.length > 32) {
    throw new Error('agent id must be 2–32 chars [a-z0-9_-]')
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
    throw new Error('agent id must start with a letter')
  }
  if (RESERVED_IDS.has(id)) {
    throw new Error(`agent id "${id}" is reserved`)
  }
  return id
}

export class SocietyIdentityService extends Service {
  private readonly agents = new Map<AgentId, AgentProfile>()

  constructor(ctx: Context) {
    super(ctx, 'societyIdentity')
  }

  maxAgents(): number {
    loadDotEnv()
    return societyEnvInt('SOCIETY_MAX_AGENTS', 8)
  }

  /** Ensure data dirs exist and return the profile (create if missing). */
  register(input: RegisterAgentInput): AgentProfile {
    const id = sanitizeAgentId(input.id)
    if (this.agents.has(id)) {
      return this.agents.get(id)!
    }
    const dataDir = agentDataDir(id)
    const workspacePath = agentWorkspaceDir(id)
    fs.mkdirSync(workspacePath, { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'inbox'), { recursive: true })

    const profile: AgentProfile = {
      id,
      displayName: String(input.displayName || id).trim() || id,
      persona: String(input.persona || '').trim() || '一个好奇的社会成员。',
      soul: {
        ...DEFAULT_SOUL,
        ...input.soul,
        interests: [...(input.soul?.interests ?? DEFAULT_SOUL.interests)],
        mood: input.soul?.mood || DEFAULT_SOUL.mood,
      },
      workspacePath,
      createdAt: new Date().toISOString(),
    }
    if (input.llm) {
      profile.llm = {
        provider: input.llm.provider === 'glm' ? 'glm' : 'agnes',
        ...(input.llm.model ? { model: String(input.llm.model).trim() } : {}),
      }
    }
    this.agents.set(profile.id, profile)
    fs.writeFileSync(path.join(dataDir, 'profile.json'), JSON.stringify(profile, null, 2), 'utf8')
    const llmPath = path.join(dataDir, 'llm.json')
    if (!fs.existsSync(llmPath)) {
      writeLlmPreference(id, profile.llm || defaultLlmFor(id))
    }
    this.ctx.emit('society/identity-registered', profile)
    return profile
  }

  /**
   * Birth a new agent (fails if id taken or SOCIETY_MAX_AGENTS reached).
   * Seeds workspace + profile.json; callers should also seed soul/memory.
   */
  spawn(input: RegisterAgentInput): AgentProfile {
    const id = sanitizeAgentId(input.id)
    if (this.agents.has(id)) {
      throw new Error(`agent already exists: ${id}`)
    }
    const onDisk = path.join(agentDataDir(id), 'profile.json')
    if (fs.existsSync(onDisk)) {
      throw new Error(`agent already exists on disk: ${id}`)
    }
    const max = this.maxAgents()
    if (this.agents.size >= max) {
      throw new Error(`max agents (${max}) reached; set SOCIETY_MAX_AGENTS to raise`)
    }
    // Auto-route free providers unless caller set llm explicitly
    const llm =
      input.llm ||
      pickBalancedLlm(this.list().map((a) => this.getLlmPreference(a.id)))
    const profile = this.register({ ...input, id, llm })
    // Always materialize llm.json for born agents
    writeLlmPreference(id, llm)
    profile.llm = llm
    fs.writeFileSync(
      path.join(agentDataDir(id), 'profile.json'),
      JSON.stringify(profile, null, 2),
      'utf8',
    )
    this.ctx.emit('society/agent-born', profile)
    return profile
  }

  get(id: AgentId): AgentProfile | undefined {
    return this.agents.get(id)
  }

  list(): AgentProfile[] {
    return [...this.agents.values()]
  }

  require(id: AgentId): AgentProfile {
    const a = this.agents.get(id)
    if (!a) throw new Error(`Unknown agent: ${id}`)
    return a
  }

  /**
   * Synthetic human operator — NOT in list()/pickAgent.
   * Used by live UI /api/say; no workspace, no LLM.
   */

  /** Read durable llm.json, then profile.llm, then defaults (bob→glm). */
  getLlmPreference(agentId: AgentId): AgentLlmPreference {
    const llmPath = path.join(agentDataDir(agentId), 'llm.json')
    if (fs.existsSync(llmPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(llmPath, 'utf8')) as AgentLlmPreference
        const provider = raw.provider === 'glm' ? 'glm' : 'agnes'
        return {
          provider,
          ...(raw.model ? { model: String(raw.model).trim() } : {}),
        }
      } catch {
        /* fall through */
      }
    }
    const profile = this.agents.get(agentId)
    if (profile?.llm?.provider) {
      return {
        provider: profile.llm.provider === 'glm' ? 'glm' : 'agnes',
        ...(profile.llm.model ? { model: String(profile.llm.model).trim() } : {}),
      }
    }
    return defaultLlmFor(agentId)
  }

  setLlmPreference(agentId: AgentId, pref: AgentLlmPreference): AgentLlmPreference {
    this.require(agentId)
    const normalized: AgentLlmPreference = {
      provider: pref.provider === 'glm' ? 'glm' : 'agnes',
      ...(pref.model ? { model: String(pref.model).trim() } : {}),
    }
    writeLlmPreference(agentId, normalized)
    const profile = this.agents.get(agentId)!
    profile.llm = normalized
    fs.writeFileSync(
      path.join(agentDataDir(agentId), 'profile.json'),
      JSON.stringify(profile, null, 2),
      'utf8',
    )
    return normalized
  }

  registerHuman(): { id: typeof HUMAN_SPEAKER_ID; displayName: string } {
    return { id: HUMAN_SPEAKER_ID, displayName: '你' }
  }

  /** Resolve a friendly label for agents or special speakers. */
  displayNameOf(id: string): string {
    if (id === HUMAN_SPEAKER_ID || id === 'system' || id === 'room') {
      return speakerLabel(id)
    }
    const a = this.agents.get(id)
    return a?.displayName || speakerLabel(id)
  }


  /** Load seed JSON files from /agents/*.json into the registry. */
  loadSeeds(): AgentProfile[] {
    if (!fs.existsSync(AGENTS_SEED_ROOT)) return []
    const out: AgentProfile[] = []
    for (const file of fs.readdirSync(AGENTS_SEED_ROOT)) {
      if (!file.endsWith('.json')) continue
      const raw = JSON.parse(fs.readFileSync(path.join(AGENTS_SEED_ROOT, file), 'utf8')) as RegisterAgentInput
      out.push(this.register(raw))
    }
    return out
  }

  /**
   * Load any profile.json under data/agents (born agents survive reboot).
   * Call after loadSeeds.
   */
  loadPersisted(): AgentProfile[] {
    if (!fs.existsSync(AGENTS_DATA_ROOT)) return []
    const out: AgentProfile[] = []
    for (const id of fs.readdirSync(AGENTS_DATA_ROOT)) {
      if (this.agents.has(id)) continue
      const profilePath = path.join(AGENTS_DATA_ROOT, id, 'profile.json')
      if (!fs.existsSync(profilePath)) continue
      try {
        const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as AgentProfile
        const workspacePath = agentWorkspaceDir(id)
        fs.mkdirSync(workspacePath, { recursive: true })
        const profile: AgentProfile = {
          id: sanitizeAgentId(raw.id || id),
          displayName: raw.displayName || id,
          persona: raw.persona || '一个好奇的社会成员。',
          soul: {
            ...DEFAULT_SOUL,
            ...(raw.soul || {}),
            interests: [...(raw.soul?.interests ?? [])],
          },
          workspacePath,
          createdAt: raw.createdAt || new Date().toISOString(),
          ...(raw.llm?.provider
            ? {
                llm: {
                  provider: raw.llm.provider === 'glm' ? 'glm' : 'agnes',
                  ...(raw.llm.model ? { model: String(raw.llm.model).trim() } : {}),
                },
              }
            : {}),
        }
        // Cap: skip loading more than max (seeds already counted)
        if (this.agents.size >= this.maxAgents()) {
          this.ctx.logger('society-identity').warn(
            `skip loading ${id}: max agents (${this.maxAgents()}) reached`,
          )
          break
        }
        this.agents.set(profile.id, profile)
        this.ctx.emit('society/identity-registered', profile)
        out.push(profile)
      } catch (err) {
        this.ctx.logger('society-identity').warn(
          `skip bad profile ${id}: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
    return out
  }
}

export const name = 'society-identity'

export function apply(ctx: Context) {
  ctx.plugin(SocietyIdentityService)
}
