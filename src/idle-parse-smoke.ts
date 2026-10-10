/**
 * Retired: ACTION text protocol removed. Delegates to tool-closing-smoke.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(here, 'tool-closing-smoke.ts')], {
  stdio: 'inherit',
  cwd: path.join(here, '..'),
})
process.exit(r.status ?? 1)
