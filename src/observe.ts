/**
 * Read-only observer UI — polls durable data/ files.
 * Default: http://127.0.0.1:8787
 * Never serves .env or API keys.
 *
 * For interactive chat use: npm run society-live
 */
import { createObserveServer, listenObserveServer } from './observe-server.ts'

async function main(): Promise<void> {
  const srv = createObserveServer({ mode: 'observe' })
  await listenObserveServer(srv)
  console.log(`[observe] http://${srv.host}:${srv.port}/`)
  console.log(`[observe] API  http://${srv.host}:${srv.port}/api/state`)
  console.log('[observe] 只读 data/；插话请用 npm run society-live')
  console.log('[observe] 不会暴露 .env / API 密钥')
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
