/**
 * society-dsh-bridge — mounts after society-* services when loaded via real dsh.
 * Loads seed agents and logs readiness. Does NOT replace society-chat's agent-loop /
 * observe UI; those stay on `npm run society-live` until wired to ctx.agents.
 */
import type { Context } from '@deepseek-ai/cordis'
import { PROJECT_ROOT } from '../../../src/paths.ts'

export const name = 'society-dsh-bridge'
export const inject = [
  'societyIdentity',
  'societyMailbox',
  'societyRooms',
  'societyMemory',
  'societySoul',
  'societySandbox',
  'societyTools',
  'societyLlm',
  'societyScheduler',
]

export interface Config {
  /** Load agents/*.json seeds and persisted profiles (default true). */
  loadSeeds?: boolean
  /** Start autonomous heartbeat (default false under dsh — avoid surprise LLM spend). */
  autoStartScheduler?: boolean
}

export function apply(ctx: Context, config: Config = {}) {
  const loadSeeds = config.loadSeeds !== false
  const autoStart = config.autoStartScheduler === true

  if (loadSeeds) {
    ctx.societyIdentity.loadSeeds()
    ctx.societyIdentity.loadPersisted()
  }

  const agents = ctx.societyIdentity.list().map((a) => a.id)
  console.log(
    `[society-dsh-bridge] ready · root=${PROJECT_ROOT} · agents=[${agents.join(', ')}] · scheduler=${autoStart ? 'on' : 'off'}`,
  )
  console.log(
    '[society-dsh-bridge] note: multi-agent chat loop + Telegram UI still run via society-chat (`npm run society-live` / Docker). This overlay only registers Cordis services inside dsh.',
  )

  if (autoStart) {
    ctx.societyScheduler.enableAutoReply()
    ctx.societyScheduler.start()
  }

  ctx.emit('society/dsh-bridge-ready', { agents, projectRoot: PROJECT_ROOT })
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'society/dsh-bridge-ready'(info: { agents: string[]; projectRoot: string }): void
  }
}
