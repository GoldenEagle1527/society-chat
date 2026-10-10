import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Project root. Prefer SOCIETY_PROJECT_ROOT when plugins are bundled/loaded
 * from another tree (dsh overlay, Docker image path remaps).
 */
export const PROJECT_ROOT = path.resolve(
  process.env.SOCIETY_PROJECT_ROOT?.trim() || path.resolve(here, '..'),
)
export const DATA_ROOT = path.join(PROJECT_ROOT, 'data')
export const AGENTS_DATA_ROOT = path.join(DATA_ROOT, 'agents')
export const AGENTS_SEED_ROOT = path.join(PROJECT_ROOT, 'agents')

export function agentDataDir(agentId: string): string {
  return path.join(AGENTS_DATA_ROOT, agentId)
}

export function agentWorkspaceDir(agentId: string): string {
  return path.join(agentDataDir(agentId), 'workspace')
}

/** Durable society state (rooms / messages) for observe + restarts. */
export const SOCIETY_STATE_ROOT = path.join(DATA_ROOT, 'society')
export const ROOMS_STATE_FILE = path.join(SOCIETY_STATE_ROOT, 'rooms.json')
export const MESSAGES_STATE_FILE = path.join(SOCIETY_STATE_ROOT, 'messages.jsonl')

/** Ensured human↔agent DM threads (appear in sidebar before first message). */
export const DM_THREADS_STATE_FILE = path.join(SOCIETY_STATE_ROOT, 'dm-threads.json')
