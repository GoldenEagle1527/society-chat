/**
 * Parse @mentions from chat body against known agents.
 * Recognizes @displayName, @id, and broadcast tokens @everyone / @全体 / @广场.
 */
import type { AgentId, AgentProfile } from './types.ts'

export interface MentionParseResult {
  /** Concrete agent ids mentioned (excludes broadcast-only). */
  mentions: AgentId[]
  /** True when @everyone / @全体 / @广场 (or equivalent) was used. */
  everyone: boolean
}

const BROADCAST_TOKENS = new Set(['everyone', 'all', '全体', '广场', '大家', '所有人'])

/** Token after @ — letters, digits, underscore, hyphen, CJK, up to 32 chars. */
const MENTION_RE = /@([A-Za-z0-9_\-\u4e00-\u9fff]{1,32})/g

/**
 * Parse @tokens from body. Longer displayName matches win over shorter prefixes
 * when multiple agents share a prefix (exact match on id or displayName, case-insensitive for ascii).
 */
export function parseMentions(
  body: string,
  agents: ReadonlyArray<Pick<AgentProfile, 'id' | 'displayName'>>,
): MentionParseResult {
  const text = String(body || '')
  const found = new Set<AgentId>()
  let everyone = false

  const byId = new Map<string, AgentId>()
  const byName = new Map<string, AgentId>()
  for (const a of agents) {
    const id = String(a.id || '').trim()
    const name = String(a.displayName || '').trim()
    if (!id) continue
    byId.set(id.toLowerCase(), id)
    byId.set(id, id)
    if (name) {
      byName.set(name.toLowerCase(), id)
      byName.set(name, id)
    }
  }

  // Prefer longer names first so @老Charlie beats @Bob when both exist as substrings
  const nameKeys = [...byName.keys()].sort((a, b) => b.length - a.length)

  for (const m of text.matchAll(MENTION_RE)) {
    const raw = m[1] || ''
    if (!raw) continue
    if (BROADCAST_TOKENS.has(raw) || BROADCAST_TOKENS.has(raw.toLowerCase())) {
      everyone = true
      continue
    }
    const idHit = byId.get(raw) || byId.get(raw.toLowerCase())
    if (idHit) {
      found.add(idHit)
      continue
    }
    let matched: AgentId | undefined
    for (const key of nameKeys) {
      if (key === raw || key.toLowerCase() === raw.toLowerCase()) {
        matched = byName.get(key)
        break
      }
    }
    if (matched) found.add(matched)
  }

  return { mentions: [...found], everyone }
}

/** Merge explicit mentions with body-parsed ones; expand @everyone to all agent ids when provided. */
export function mergeMentions(
  body: string,
  agents: ReadonlyArray<Pick<AgentProfile, 'id' | 'displayName'>>,
  explicit?: AgentId[] | null,
  opts?: { expandEveryone?: boolean },
): { mentions: AgentId[]; everyone: boolean } {
  const parsed = parseMentions(body, agents)
  const set = new Set<AgentId>(parsed.mentions)
  for (const id of explicit ?? []) {
    const t = String(id || '').trim()
    if (t) set.add(t)
  }
  const everyone = parsed.everyone
  if (everyone && opts?.expandEveryone !== false) {
    for (const a of agents) {
      const id = String(a.id || '').trim()
      if (id) set.add(id)
    }
  }
  return { mentions: [...set], everyone }
}

/** True if this agent was targeted by mentions (direct or everyone). */
export function isAgentMentioned(
  agentId: AgentId,
  mentions: AgentId[] | undefined,
  everyone: boolean,
): boolean {
  if (everyone) return true
  if (!mentions?.length) return false
  return mentions.includes(agentId)
}
