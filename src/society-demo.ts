/**
 * Documented parallel demo helper:
 * - Prints observe URL + how to run society-run in another terminal
 * - Optionally runs a short bounded society-run inline (few exchanges)
 *
 * Never logs API keys. Free Agnes only.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { loadDotEnv, requireAgnesConfig, societyEnvInt } from './env.ts'
import { PROJECT_ROOT } from './paths.ts'

async function main() {
  console.log('=== society-chat society-demo ===')
  loadDotEnv()
  const cfg = requireAgnesConfig()
  console.log(`✓ Agnes: model=${cfg.model} key=set`)

  const host = process.env.SOCIETY_OBSERVE_HOST?.trim() || '127.0.0.1'
  const port = process.env.SOCIETY_OBSERVE_PORT?.trim() || '8787'
  console.log('')
  console.log('旁观 UI（另开终端）:')
  console.log('  npm run observe')
  console.log(`  然后打开 http://${host}:${port}/`)
  console.log('  curl http://127.0.0.1:8787/api/state')
  console.log('')
  console.log('本脚本将启动一次短界 society-run（写 data/）；observe 可并行只读轮询。')
  console.log('')

  const maxTicks = societyEnvInt('SOCIETY_DEMO_MAX_TICKS', 4)
  const maxExchanges = societyEnvInt('SOCIETY_DEMO_MAX_EXCHANGES', 3)
  const env = {
    ...process.env,
    SOCIETY_MAX_TICKS: String(maxTicks),
    SOCIETY_MAX_EXCHANGES: String(maxExchanges),
    SOCIETY_TICK_MS: process.env.SOCIETY_TICK_MS || '1000',
  }

  const runPath = path.join(PROJECT_ROOT, 'src/society-run.ts')
  const child = spawn('npx', ['tsx', runPath], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  })

  const code: number = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c ?? 1))
  })
  if (code !== 0) {
    console.error(`society-run exited ${code}`)
    process.exit(code)
  }
  console.log('')
  console.log('=== SOCIETY-DEMO DONE ===')
  console.log(`若未开旁观：npm run observe → http://${host}:${port}/`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
