/**
 * Prove generated profiles/dsh-society/lib/*.js load under Cordis
 * the same way a dsh --patch row would import them.
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PROJECT_ROOT } from './paths.ts'

process.env.SOCIETY_PROJECT_ROOT ??= PROJECT_ROOT

const LIB = path.join(PROJECT_ROOT, 'profiles', 'dsh-society', 'lib')
const ORDER = [
  'society-identity',
  'society-mailbox',
  'society-rooms',
  'society-memory',
  'society-soul',
  'society-sandbox',
  'society-tools',
  'society-llm',
  'society-scheduler',
  'society-dsh-bridge',
] as const

async function main() {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(PROJECT_ROOT).href + '/'

  for (const id of ORDER) {
    const file = path.join(LIB, `${id}.js`)
    const mod = await import(pathToFileURL(file).href)
    await ctx.plugin(mod)
  }

  await new Promise((r) => setTimeout(r, 50))

  const agents = ctx.societyIdentity.list()
  if (agents.length < 2) {
    throw new Error(`expected seed agents, got ${agents.map((a) => a.id).join(',')}`)
  }
  console.log('=== DSH-OVERLAY-SMOKE PASS ===')
  console.log(
    'agents:',
    agents.map((a) => `${a.id}/${a.llm?.provider ?? '?'}`).join(', '),
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('=== DSH-OVERLAY-SMOKE FAIL ===')
  console.error(err)
  process.exit(1)
})
