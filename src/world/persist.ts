/** Persist YinYang world under data/society/world.json */
import fs from 'node:fs'
import path from 'node:path'
import { SOCIETY_STATE_ROOT } from '../paths.ts'
import type { WorldState } from './types.ts'
import { createSeedWorld } from './engine.ts'

export const WORLD_STATE_FILE = path.join(SOCIETY_STATE_ROOT, 'world.json')

export function ensureSocietyStateDir(): void {
  fs.mkdirSync(SOCIETY_STATE_ROOT, { recursive: true })
}

export function loadWorld(): WorldState | null {
  if (!fs.existsSync(WORLD_STATE_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(WORLD_STATE_FILE, 'utf8')) as WorldState
  } catch {
    return null
  }
}

export function saveWorld(state: WorldState): void {
  ensureSocietyStateDir()
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(WORLD_STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

/** Load existing or seed fresh for these actors (includes human if listed). */
export function loadOrSeedWorld(actorIds: string[]): WorldState {
  const existing = loadWorld()
  if (existing && existing.bots?.length) {
    // Ensure any missing actors get bodies
    const have = new Set(existing.bots.map((b) => b.actorId))
    const missing = actorIds.filter((id) => !have.has(id))
    if (missing.length === 0) return existing
    const fresh = createSeedWorld(missing)
    for (const b of fresh.bots) existing.bots.push(b)
    for (const p of fresh.particles) {
      if (p.boundTo && missing.includes(p.boundTo)) existing.particles.push(p)
    }
    saveWorld(existing)
    return existing
  }
  const state = createSeedWorld(actorIds)
  saveWorld(state)
  return state
}
