/**
 * society-sandbox — command confinement for agents.
 * Cordis service name: `societySandbox`
 *
 * Modes (SOCIETY_SANDBOX_MODE):
 * - bwrap (default on bare Linux): bubblewrap namespaces; RW bind only agent workspace
 * - docker: outer Docker container is the isolation boundary; run with cwd=workspace,
 *   timeout + nice; no nested bwrap (often unavailable / broken). Path tools still
 *   reject traversal; run_command can still touch abs paths if argv escapes — rely on
 *   container FS + non-root user.
 *
 * Also exports HTTP host allowlist helpers used by society-tools fetch clients.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId } from '../../../src/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societySandbox: SocietySandboxService
  }
}

/** Exact hostnames allowed for tool HTTP clients. */
export const ALLOWED_HOSTS_EXACT = [
  'apihub.agnes-ai.com',
  'api.duckduckgo.com',
  'html.duckduckgo.com',
  'open.bigmodel.cn',
] as const

/** Suffix patterns: hostname === apex OR endsWith('.' + apex) for *.wikipedia.org etc. */
export const ALLOWED_HOST_SUFFIXES = ['wikipedia.org', 'wikimedia.org'] as const

const BWRAP_BIN = '/usr/bin/bwrap'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 256_000

export type SandboxMode = 'bwrap' | 'docker'

export function resolveSandboxMode(): SandboxMode {
  const raw = (process.env.SOCIETY_SANDBOX_MODE || '').trim().toLowerCase()
  if (raw === 'docker' || raw === 'container') return 'docker'
  return 'bwrap'
}

export function isHostAllowed(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!h) return false
  if ((ALLOWED_HOSTS_EXACT as readonly string[]).includes(h)) return true
  for (const apex of ALLOWED_HOST_SUFFIXES) {
    if (h === apex || h.endsWith(`.${apex}`)) return true
  }
  return false
}

/**
 * Parse URL and reject non-http(s) or non-allowlisted hosts.
 * Throws Error with a stable message prefix for tool string results.
 */
export function assertUrlAllowed(url: string): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`URL rejected (invalid): ${url}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`URL rejected (protocol ${u.protocol}): ${url}`)
  }
  if (!isHostAllowed(u.hostname)) {
    throw new Error(`URL rejected (host not allowlisted): ${u.hostname}`)
  }
  return u
}

export interface RunConfinedOptions {
  /** When true, keep network (--share-net with unshare-all style). Default false. */
  network?: boolean
  timeoutMs?: number
  stdin?: string
  /** Extra env vars inside sandbox (never pass secrets unless caller intends). */
  env?: Record<string, string>
}

export interface RunConfinedResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** True when bwrap binary missing / failed to spawn (bwrap mode only). */
  unavailable?: boolean
  mode?: SandboxMode
}

export class SocietySandboxService extends Service {
  static inject = ['societyIdentity']

  constructor(ctx: Context) {
    super(ctx, 'societySandbox')
  }

  mode(): SandboxMode {
    return resolveSandboxMode()
  }

  /** Absolute workspace path for agent (must exist). */
  workspaceOf(agentId: AgentId): string {
    const ws = this.ctx.societyIdentity.require(agentId).workspacePath
    fs.mkdirSync(ws, { recursive: true })
    return path.resolve(ws)
  }

  bwrapAvailable(): boolean {
    try {
      return fs.existsSync(BWRAP_BIN) && fs.statSync(BWRAP_BIN).isFile()
    } catch {
      return false
    }
  }

  /**
   * Run argv confined to the agent's workspace.
   * argv[0] should be an absolute path under /bin or /usr/bin.
   */
  async runConfined(
    agentId: AgentId,
    argv: string[],
    opts: RunConfinedOptions = {},
  ): Promise<RunConfinedResult> {
    this.ctx.societyIdentity.require(agentId)
    if (!argv?.length) {
      return {
        code: 1,
        stdout: '',
        stderr: 'Error: argv must be a non-empty array',
        timedOut: false,
        mode: this.mode(),
      }
    }

    const mode = this.mode()
    const workspace = this.workspaceOf(agentId)
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const baseEnv: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      HOME: workspace,
      LANG: 'C.UTF-8',
      ...opts.env,
    }

    if (mode === 'docker') {
      return runDockerConfined(workspace, argv, {
        timeoutMs,
        stdin: opts.stdin,
        env: baseEnv,
        network: opts.network === true,
      })
    }

    if (!this.bwrapAvailable()) {
      return {
        code: 127,
        stdout: '',
        stderr: `Error: bwrap not found at ${BWRAP_BIN}. Set SOCIETY_SANDBOX_MODE=docker inside containers, or install bubblewrap on the host.`,
        timedOut: false,
        unavailable: true,
        mode,
      }
    }

    const network = opts.network === true
    const bwrapArgs = buildBwrapArgs(workspace, network)
    bwrapArgs.push('--', ...argv)

    const result = await spawnCaptured(BWRAP_BIN, bwrapArgs, {
      timeoutMs,
      stdin: opts.stdin,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/agent',
        LANG: 'C.UTF-8',
        ...opts.env,
      },
    })
    return { ...result, mode }
  }
}

/** Build bwrap argv (without the trailing command). Exported for smoke diagnostics. */
export function buildBwrapArgs(workspaceAbs: string, network: boolean): string[] {
  const args: string[] = [
    '--unshare-user-try',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--tmpfs',
    '/',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--ro-bind-try',
    '/etc/resolv.conf',
    '/etc/resolv.conf',
    '--ro-bind-try',
    '/etc/ssl',
    '/etc/ssl',
    '--ro-bind-try',
    '/etc/nsswitch.conf',
    '/etc/nsswitch.conf',
    '--ro-bind-try',
    '/etc/hosts',
    '/etc/hosts',
    '--ro-bind-try',
    '/etc/passwd',
    '/etc/passwd',
    '--ro-bind-try',
    '/etc/group',
    '/etc/group',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home',
    '--bind',
    workspaceAbs,
    '/home/agent',
    '--chdir',
    '/home/agent',
    '--clearenv',
    '--setenv',
    'HOME',
    '/home/agent',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
  ]
  if (!network) {
    args.push('--unshare-net')
  }
  return args
}

/**
 * Docker / container mode: no bwrap. cwd locked to workspace; timeout; optional nice.
 * Network flag is advisory in this mode (process shares container net namespace).
 */
function runDockerConfined(
  workspaceAbs: string,
  argv: string[],
  opts: {
    timeoutMs: number
    stdin?: string
    env: Record<string, string>
    network: boolean
  },
): Promise<RunConfinedResult> {
  const niceBin = fs.existsSync('/usr/bin/nice')
    ? '/usr/bin/nice'
    : fs.existsSync('/bin/nice')
      ? '/bin/nice'
      : null

  let cmd: string
  let args: string[]
  if (niceBin) {
    cmd = niceBin
    args = ['-n', '10', ...argv]
  } else {
    cmd = argv[0]!
    args = argv.slice(1)
  }

  // network=false cannot unshare net without privileges; document as container-level.
  void opts.network

  return spawnCaptured(cmd, args, {
    timeoutMs: opts.timeoutMs,
    stdin: opts.stdin,
    env: opts.env,
    cwd: workspaceAbs,
  }).then((r) => ({ ...r, mode: 'docker' as const }))
}

function spawnCaptured(
  cmd: string,
  args: string[],
  opts: {
    timeoutMs: number
    stdin?: string
    env: Record<string, string>
    cwd?: string
  },
): Promise<RunConfinedResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      cwd: opts.cwd,
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString('utf8')
        if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]'
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString('utf8')
        if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]'
      }
    })

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: timedOut ? 124 : code,
        stdout,
        stderr: timedOut ? (stderr ? stderr + '\n' : '') + 'Error: run_command timed out' : stderr,
        timedOut,
      })
    }

    child.on('error', (err) => {
      stderr = (stderr ? stderr + '\n' : '') + `Error: spawn failed — ${err.message}`
      finish(127)
    })
    child.on('close', (code) => finish(code))

    if (opts.stdin != null && child.stdin) {
      child.stdin.end(opts.stdin)
    } else {
      child.stdin?.end()
    }
  })
}

export const name = 'society-sandbox'
export const inject = ['societyIdentity']

export function apply(ctx: Context) {
  ctx.plugin(SocietySandboxService)
}
