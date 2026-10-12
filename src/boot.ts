/**
 * Boot a Cordis root context with society plugins.
 * This is a Harness-compatible composition: each plugin exports name/inject/apply.
 * When full dsh is available later, the same plugins can be listed in cordis.patch.yml.
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as identity from '../plugins/society-identity/src/index.ts'
import * as mailbox from '../plugins/society-mailbox/src/index.ts'
import * as rooms from '../plugins/society-rooms/src/index.ts'
import * as world from '../plugins/society-world/src/index.ts'
import * as memory from '../plugins/society-memory/src/index.ts'
import * as soul from '../plugins/society-soul/src/index.ts'
import * as sandbox from '../plugins/society-sandbox/src/index.ts'
import * as tools from '../plugins/society-tools/src/index.ts'
import * as llm from '../plugins/society-llm/src/index.ts'
import * as scheduler from '../plugins/society-scheduler/src/index.ts'
import { PROJECT_ROOT } from './paths.ts'

export interface SocietyApp {
  ctx: Context
  dispose: () => Promise<void>
}

export async function bootSociety(opts?: { loadSeeds?: boolean }): Promise<SocietyApp> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(PROJECT_ROOT).href + '/'

  // Mount order: identity → mailbox → rooms → world → memory/soul(stub) → sandbox → tools → llm → scheduler
  await ctx.plugin(identity)
  await ctx.plugin(mailbox)
  await ctx.plugin(rooms)
  await ctx.plugin(world)
  await ctx.plugin(memory)
  await ctx.plugin(soul)
  await ctx.plugin(sandbox)
  await ctx.plugin(tools)
  await ctx.plugin(llm)
  await ctx.plugin(scheduler)

  await settle()

  if (opts?.loadSeeds !== false) {
    // Persist first. Default agents/*.json seeds only when disk is empty
    // (seed-cast is source of truth for the user cast). SOCIETY_NO_DEFAULT_SEEDS=1 skips JSON seeds.
    ctx.societyIdentity.loadPersisted()
    const noDefault =
      process.env.SOCIETY_NO_DEFAULT_SEEDS === '1' ||
      /^true$/i.test(process.env.SOCIETY_NO_DEFAULT_SEEDS || '') ||
      /^yes$/i.test(process.env.SOCIETY_NO_DEFAULT_SEEDS || '')
    if (!noDefault && ctx.societyIdentity.list().length === 0) {
      ctx.societyIdentity.loadSeeds()
    }
  }

  return {
    ctx,
    dispose: async () => {
      ctx.societyScheduler.stop()
      ctx.societyScheduler.disableAutoReply()
      const fiber = (ctx as unknown as { fiber?: { dispose?: () => Promise<void> } }).fiber
      await fiber?.dispose?.()
    },
  }
}

function settle(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** CLI: boot and print registered agents. */
async function main() {
  const app = await bootSociety()
  const agents = app.ctx.societyIdentity.list()
  console.log(`[society] booted with ${agents.length} agents:`)
  for (const a of agents) {
    console.log(`  - ${a.id} (${a.displayName}) workspace=${a.workspacePath}`)
  }
  await app.dispose()
}

const isDirect =
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) ||
  process.argv[1]?.endsWith('boot.ts')

if (isDirect) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
