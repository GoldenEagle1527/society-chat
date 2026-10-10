/**
 * DANGEROUS: wipe runtime society state under data/.
 * Removes data/agents/* and data/society/* contents; recreates empty dirs.
 * Does NOT touch .env, source, or agents/*.json seeds.
 *
 * Usage: npm run reset-society
 */
import fs from 'node:fs'
import path from 'node:path'
import { AGENTS_DATA_ROOT, DATA_ROOT, SOCIETY_STATE_ROOT } from './paths.ts'

function wipeDirContents(dir: string): number {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    return 0
  }
  let n = 0
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    fs.rmSync(full, { recursive: true, force: true })
    n += 1
  }
  return n
}

function main(): void {
  console.log('=== society-chat reset-society (DANGEROUS) ===')
  console.log('This deletes all agents, rooms, DMs, and message history under data/.')
  console.log('Does NOT delete .env or source code.')
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  const agentsRemoved = wipeDirContents(AGENTS_DATA_ROOT)
  const societyRemoved = wipeDirContents(SOCIETY_STATE_ROOT)
  fs.mkdirSync(AGENTS_DATA_ROOT, { recursive: true })
  fs.mkdirSync(SOCIETY_STATE_ROOT, { recursive: true })
  // Keep .gitkeep-style emptiness visible
  fs.writeFileSync(path.join(AGENTS_DATA_ROOT, '.gitkeep'), '', 'utf8')
  fs.writeFileSync(path.join(SOCIETY_STATE_ROOT, '.gitkeep'), '', 'utf8')
  console.log(`✓ wiped data/agents (${agentsRemoved} entries)`)
  console.log(`✓ wiped data/society (${societyRemoved} entries)`)
  console.log('Next: npm run seed-cast   (or birth agents in the UI)')
  console.log('=== RESET DONE ===')
}

main()
