/**
 * society-tools — Agent-bound tools with workspace isolation + social + bwrap.
 * Cordis service name: `societyTools`
 *
 * File tools only touch data/agents/<id>/workspace/...
 * Path traversal (.., absolute escape) is rejected.
 * run_command MUST go through societySandbox (bwrap or docker mode); no raw shell.
 * web_search (Exa; 1 call/model/Beijing-day) / generate_image HTTP clients use host allowlist from society-sandbox.
 * Social tools: create_room / invite_to_room / list_rooms / list_agents / post_room / speak_in_room / send_dm / spawn_agent.
 * Closing tools (idle/reply): speak_in_room / send_dm / write_diary / write_thought / do_nothing / stay_silent / rest.
 * Side tool: reflect_feelings (subjective soul nudge; not a closing act).
 */
import fs from 'node:fs'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, RoomId } from '../../../src/types.ts'
import {
  loadDotEnv,
  parseSpawnLlmInput,
  requireAgnesConfig,
  requireProviderConfig,
  normalizeProviderId,
} from '../../../src/env.ts'
import { assertUrlAllowed } from '../../society-sandbox/src/index.ts'
import { isChattyPrivateText, looksLikeOutboundChatLine } from './private-voice.ts'
import { beijingClock, beijingDayStamp } from '../../../src/beijing-time.ts'
import {
  exaQuotaExhaustedMessage,
  isExaQuotaExhausted,
  tryConsumeExaQuota,
} from './exa-quota.ts'
import { resolveRestUntil, writeRest } from './rest.ts'

export {
  clearRest,
  defaultRestUntil,
  getRestUntil,
  isAgentResting,
  nextBeijingWallClock,
  readRest,
  resolveRestUntil,
  restFilePath,
  writeRest,
} from './rest.ts'
export type { AgentRestState, ResolveRestUntilArgs, ResolveRestUntilResult } from './rest.ts'

export { looksLikeOutboundChatLine, classifyIdlePrivateBody, isChattyPrivateText } from './private-voice.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyTools: SocietyToolsService
  }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCallRequest {
  id: string
  name: string
  arguments: string
}

const WEB_SEARCH_TIMEOUT_MS = 15_000
const IMAGE_TIMEOUT_MS = 90_000
const FREE_IMAGE_MODEL = 'agnes-image-2.5-flash'

/**
 * Resolve a relative path strictly under workspaceRoot.
 * Throws on absolute paths, .. escapes, null bytes, empty path.
 * Exported for isolation smoke checks.
 */
export function resolveInsideWorkspace(workspaceRoot: string, relativePath: string): string {
  if (relativePath == null || typeof relativePath !== 'string') {
    throw new Error('path must be a non-empty string')
  }
  const raw = relativePath.trim()
  if (!raw) throw new Error('path must be a non-empty string')
  if (raw.includes('\0')) throw new Error('path must not contain null bytes')
  if (path.isAbsolute(raw)) {
    throw new Error(`absolute paths are not allowed: ${raw}`)
  }
  // Normalize separators; reject any .. segment after normalize
  const normalized = path.normalize(raw)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`) || normalized.endsWith(`${path.sep}..`)) {
    throw new Error(`path traversal rejected: ${raw}`)
  }
  // Also catch Windows-style and explicit ../ in original
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) {
    throw new Error(`path traversal rejected: ${raw}`)
  }

  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, normalized)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${raw}`)
  }
  return resolved
}

/** Relative posix-ish path from workspace root for tool return values. */
export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const root = path.resolve(workspaceRoot)
  const rel = path.relative(root, path.resolve(absolutePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('internal path escape')
  }
  return rel.split(path.sep).join('/')
}

/** Closing tools that finish an idle or reply turn (side-effecting social/private acts). */
export const IDLE_CLOSING_TOOL_NAMES = [
  'speak_in_room',
  'send_dm',
  'write_diary',
  'write_thought',
  'do_nothing',
  'rest',
] as const

export const REPLY_CLOSING_TOOL_NAMES = ['stay_silent', 'speak_in_room', 'send_dm', 'rest'] as const

export const RESEARCH_TOOL_NAMES = [
  'web_search',
  'write_file',
  'read_file',
  'list_workspace',
  'list_agents',
  'list_rooms',
  'run_command',
  'generate_image',
  'reflect_feelings',
] as const

/** Side tools that may run before/alongside a closing act (not closing themselves). */
export const SIDE_TOOL_NAMES = ['reflect_feelings'] as const

export type ClosingActName =
  | 'speak_in_room'
  | 'send_dm'
  | 'diary'
  | 'thought'
  | 'do_nothing'
  | 'stay_silent'
  | 'rest'

export function isClosingToolName(name: string): boolean {
  return (
    (IDLE_CLOSING_TOOL_NAMES as readonly string[]).includes(name) ||
    name === 'stay_silent'
  )
}

function localDayStamp(d = new Date()): string {
  return beijingDayStamp(d)
}

function localClock(d = new Date()): string {
  return beijingClock(d)
}

function splitBubbleBodies(body: string): string[] {
  const trimmed = body.trim()
  if (!trimmed) return []
  if (trimmed.includes('|||')) {
    return trimmed
      .split('|||')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((b) => b.slice(0, 2000))
  }
  return [trimmed.slice(0, 2000)]
}

const SIDE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'reflect_feelings',
      description:
        'Record YOUR OWN subjective soul shift after this turn (openness/trust/energy/mood). Optional; call at most once per turn when your feelings actually changed. Warm chat may raise energy/trust; exhaustion may lower energy. Deltas are small (±0.05 max each). Does NOT speak for you — still call a closing tool.',
      parameters: {
        type: 'object',
        properties: {
          openness: {
            type: 'number',
            description: 'Delta for openness, clamped to ±0.05',
          },
          trust: {
            type: 'number',
            description: 'Delta for trust, clamped to ±0.05',
          },
          energy: {
            type: 'number',
            description: 'Delta for energy, clamped to ±0.05',
          },
          mood: {
            type: 'string',
            description: 'Optional short mood label (e.g. 开心、疲惫、好奇)',
          },
          reason: {
            type: 'string',
            description: 'Optional short reason for the audit log',
          },
        },
        required: [],
      },
    },
  },
]

const CLOSING_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'speak_in_room',
      description:
        'Post to a group chat. Omit roomId to post to plaza. body may use ||| to split 2–4 short bubbles. Optional replyTo message id. Prefer @显示名 to mention someone.',
      parameters: {
        type: 'object',
        properties: {
          roomId: {
            type: 'string',
            description: 'Room id; omit to use plaza (default)',
          },
          body: { type: 'string', description: 'What you say (Chinese short bubbles; ||| ok)' },
          replyTo: {
            type: 'string',
            description: 'Optional message id in this room to reply to',
          },
        },
        required: ['body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_diary',
      description:
        'Append a PRIVATE diary entry for today (first-person notes to yourself ONLY). Rejects outbound chat voice (@mentions, 「xxx在吗」, asking the group). Use speak_in_room or send_dm to talk to others.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Private first-person diary text' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_thought',
      description:
        'Append a PRIVATE inner thought / note for today (not for others). Same privacy rules as write_diary.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Private thought text' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'do_nothing',
      description: 'Explicitly end this idle turn without speaking, DIMing, or writing. Use sparingly.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Optional short reason' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stay_silent',
      description:
        'Choose NOT to reply to the current room/DM stimulus (when topic moved on, others talking among themselves, and you were not @mentioned).',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Optional short reason' },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'rest',
      description:
        'End this turn and go to sleep / stop socializing until a chosen time. Use after saying goodnight, when tired, or when you want the scheduler to stop waking you for idle/chatter. Default (only reason or empty): next Beijing 07:00, or +7h if that is <3h or >12h away. until: ISO timestamp, Beijing HH:mm (next occurrence), or "morning" (= next Beijing 07:00). minutes: sleep for N minutes (1–1440). Human messages and @mentions still wake you early.',
      parameters: {
        type: 'object',
        properties: {
          until: {
            type: 'string',
            description:
              'ISO timestamp, Beijing HH:mm (e.g. "23:30"), or "morning" for next Beijing 07:00',
          },
          minutes: {
            type: 'number',
            description: 'Sleep for this many minutes (1–1440). Overrides until when set.',
          },
          reason: {
            type: 'string',
            description: 'Optional short reason (e.g. 晚安、想静静)',
          },
        },
        required: [],
      },
    },
  },
]

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write a text file under YOUR private workspace only. path is relative (e.g. notes/hello.md). Returns the relative path written.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under your workspace' },
          content: { type: 'string', description: 'Full text content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from YOUR private workspace. path is relative.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under your workspace' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_workspace',
      description: 'List files and directories under YOUR private workspace (optional subdirectory).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional relative subdirectory (default: workspace root)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web via Exa (paid). Each LLM model may search at most once per Beijing calendar day; agents sharing a model share that quota. Returns up to 5 titles/urls/snippets. Use sparingly for factual lookups.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Generate an image with Agnes free image model and save under workspace/images/. Only call when the user explicitly asks for an image.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Image generation prompt' },
          filename: {
            type: 'string',
            description: 'Optional filename under images/ (default auto)',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a simple command inside YOUR bubblewrap sandbox (cwd = your workspace). Network is OFF unless network=true. argv[0] must be an absolute path under /bin or /usr/bin (e.g. /bin/sh, /bin/ls, /usr/bin/curl). No host shell.',
      parameters: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            description: 'Argument vector, e.g. ["/bin/sh","-c","echo hi > note.txt"]',
          },
          network: {
            type: 'boolean',
            description: 'Opt in to network inside bwrap (default false)',
          },
        },
        required: ['argv'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_room',
      description: 'Create a new chat room with you as creator/member. Returns room id and name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Room display name' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invite_to_room',
      description: 'Invite another agent into a room you already belong to.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string' },
          agentId: { type: 'string', description: 'Agent id to invite (e.g. bob)' },
        },
        required: ['roomId', 'agentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_rooms',
      description: 'List rooms you are a member of (id, name, members).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agents',
      description: 'List known agents (id + displayName).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_room',
      description:
        'Post a message to a room you belong to (wakes other members). Use @显示名 to mention someone; optional replyTo message id.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'string' },
          body: { type: 'string' },
          replyTo: {
            type: 'string',
            description: 'Optional message id in this room to reply to',
          },
        },
        required: ['roomId', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description:
        'Birth a new agent into the society (creates id, persona, soul seed, private workspace). Respects SOCIETY_MAX_AGENTS. You become aware of them via list_agents; invite them to a room to talk.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'New agent id slug, e.g. carol (lowercase letters, digits, _ -)',
          },
          displayName: { type: 'string', description: 'Display name, e.g. Carol' },
          persona: { type: 'string', description: 'Short persona description' },
          openness: { type: 'number', description: 'Soul openness 0–1 (optional)' },
          trust: { type: 'number', description: 'Soul trust 0–1 (optional)' },
          energy: { type: 'number', description: 'Soul energy 0–1 (optional)' },
          interests: {
            type: 'array',
            items: { type: 'string' },
            description: 'Interest tags (optional)',
          },
          mood: { type: 'string', description: 'Initial mood label (optional)' },
          provider: {
            type: 'string',
            description: 'Free LLM provider: agnes | glm | siliconflow (optional; omit to auto-balance)',
          },
          model: {
            type: 'string',
            description: 'Free model id for that provider (optional; defaults to provider free flash)',
          },
          llm: {
            type: 'object',
            description: 'Optional { provider, model? } same as provider/model fields',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
            },
          },
        },
        required: ['id', 'displayName', 'persona'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_dm',
      description:
        'Send a private direct message to another agent (closing act for idle or DM reply). body may use ||| for multi-bubble.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient agent id' },
          body: { type: 'string' },
        },
        required: ['to', 'body'],
      },
    },
  },
]

/** Full catalog = base social/file tools + closing tools (dedupe by name). */
function mergeToolDefs(...groups: ToolDefinition[][]): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>()
  for (const g of groups) {
    for (const t of g) byName.set(t.function.name, t)
  }
  return [...byName.values()]
}

export class SocietyToolsService extends Service {
  static inject = ['societyIdentity', 'societySandbox', 'societyRooms', 'societyMailbox', 'societySoul', 'societyMemory']

  constructor(ctx: Context) {
    super(ctx, 'societyTools')
  }

  private defaultRoomId: RoomId | null = null

  /** Prefer plaza for speak_in_room when roomId omitted (set by society-live). */
  setDefaultRoom(roomId: RoomId | null): void {
    this.defaultRoomId = roomId
  }

  /** OpenAI-style tool schemas for chat/completions (full catalog). */
  getToolDefinitions(): ToolDefinition[] {
    return mergeToolDefs(TOOL_DEFINITIONS, CLOSING_TOOL_DEFINITIONS, SIDE_TOOL_DEFINITIONS)
  }

  /** Idle self-loop: research tools + idle closing tools. */
  getIdleToolDefinitions(): ToolDefinition[] {
    const names = new Set<string>([
      ...RESEARCH_TOOL_NAMES,
      ...IDLE_CLOSING_TOOL_NAMES,
    ])
    return this.getToolDefinitions().filter((t) => names.has(t.function.name))
  }

  /** Room/DM reply: research + stay_silent / speak_in_room / send_dm. */
  getReplyToolDefinitions(kind: 'room' | 'direct'): ToolDefinition[] {
    const names = new Set<string>([...RESEARCH_TOOL_NAMES, ...REPLY_CLOSING_TOOL_NAMES])
    if (kind === 'direct') {
      names.delete('speak_in_room')
    }
    return this.getToolDefinitions().filter((t) => names.has(t.function.name))
  }

  workspaceOf(agentId: AgentId): string {
    return this.ctx.societyIdentity.require(agentId).workspacePath
  }

  /**
   * Execute one tool bound to agentId (never another agent's workspace).
   * Always returns a string (success or friendly error) for the LLM tool message.
   */
  async execute(agentId: AgentId, name: string, argsJson: string): Promise<string> {
    this.ctx.societyIdentity.require(agentId)
    let args: Record<string, unknown> = {}
    try {
      args = argsJson?.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    } catch {
      return `Error: invalid tool arguments JSON for ${name}`
    }
    try {
      switch (name) {
        case 'write_file':
          return this.writeFile(agentId, String(args.path ?? ''), String(args.content ?? ''))
        case 'read_file':
          return this.readFile(agentId, String(args.path ?? ''))
        case 'list_workspace':
          return this.listWorkspace(agentId, args.path != null ? String(args.path) : '')
        case 'web_search':
          return await this.webSearch(agentId, String(args.query ?? ''))
        case 'generate_image':
          return await this.generateImage(
            agentId,
            String(args.prompt ?? ''),
            args.filename != null ? String(args.filename) : undefined,
          )
        case 'run_command':
          return await this.runCommand(
            agentId,
            args.argv,
            args.network === true,
          )
        case 'create_room':
          return this.createRoom(agentId, String(args.name ?? ''))
        case 'invite_to_room':
          return this.inviteToRoom(agentId, String(args.roomId ?? ''), String(args.agentId ?? ''))
        case 'list_rooms':
          return this.listRooms(agentId)
        case 'list_agents':
          return this.listAgents()
        case 'post_room':
          return this.postRoom(
            agentId,
            String(args.roomId ?? ''),
            String(args.body ?? ''),
            args.replyTo != null ? String(args.replyTo) : undefined,
          )
        case 'speak_in_room':
          return this.speakInRoom(
            agentId,
            args.roomId != null ? String(args.roomId) : undefined,
            String(args.body ?? ''),
            args.replyTo != null ? String(args.replyTo) : undefined,
          )
        case 'send_dm':
          return this.sendDm(agentId, String(args.to ?? ''), String(args.body ?? ''))
        case 'write_diary':
          return this.writeDiary(agentId, String(args.text ?? ''))
        case 'write_thought':
          return this.writeThought(agentId, String(args.text ?? ''))
        case 'do_nothing':
          return JSON.stringify({
            ok: true,
            acted: 'do_nothing',
            reason: args.reason != null ? String(args.reason) : undefined,
          })
        case 'stay_silent':
          return JSON.stringify({
            ok: true,
            acted: 'stay_silent',
            reason: args.reason != null ? String(args.reason) : undefined,
          })
        case 'rest':
          return this.rest(agentId, args)
        case 'reflect_feelings':
          return this.reflectFeelings(agentId, args)
        case 'spawn_agent':
          return this.spawnAgent(agentId, args)
        default:
          return `Error: unknown tool "${name}"`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error: ${msg}`
    }
  }


  spawnAgent(agentId: AgentId, args: Record<string, unknown>): string {
    // Caller must already be a registered agent (permission: any living agent may propose birth)
    this.ctx.societyIdentity.require(agentId)
    const id = String(args.id ?? '').trim()
    const displayName = String(args.displayName ?? '').trim()
    const persona = String(args.persona ?? '').trim()
    if (!id || !displayName || !persona) {
      return 'Error: id, displayName, and persona are required'
    }
    const soul: {
      openness?: number
      trust?: number
      energy?: number
      interests?: string[]
      mood?: string
    } = {}
    if (args.openness != null && Number.isFinite(Number(args.openness))) {
      soul.openness = Math.max(0, Math.min(1, Number(args.openness)))
    }
    if (args.trust != null && Number.isFinite(Number(args.trust))) {
      soul.trust = Math.max(0, Math.min(1, Number(args.trust)))
    }
    if (args.energy != null && Number.isFinite(Number(args.energy))) {
      soul.energy = Math.max(0, Math.min(1, Number(args.energy)))
    }
    if (args.mood != null) soul.mood = String(args.mood)
    if (Array.isArray(args.interests)) {
      soul.interests = args.interests.map((x) => String(x)).slice(0, 8)
    }
    let llm
    try {
      llm = parseSpawnLlmInput({
        llm: args.llm && typeof args.llm === 'object' ? (args.llm as { provider?: unknown; model?: unknown }) : undefined,
        provider: args.provider,
        model: args.model,
      })
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
    try {
      const profile = this.ctx.societyIdentity.spawn({
        id,
        displayName,
        persona,
        soul,
        ...(llm ? { llm } : {}),
      })
      // Seed durable soul + memory files
      this.ctx.societySoul.load(profile.id)
      this.ctx.societyMemory.load(profile.id)
      const pref = this.ctx.societyIdentity.getLlmPreference(profile.id)
      return JSON.stringify({
        id: profile.id,
        displayName: profile.displayName,
        persona: profile.persona,
        workspacePath: profile.workspacePath,
        bornBy: agentId,
        llm: pref,
        soul: {
          openness: profile.soul.openness,
          trust: profile.soul.trust,
          energy: profile.soul.energy,
          interests: profile.soul.interests,
          mood: profile.soul.mood,
        },
      })
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  writeFile(agentId: AgentId, relativePath: string, content: string): string {
    const root = this.workspaceOf(agentId)
    const abs = resolveInsideWorkspace(root, relativePath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
    const rel = toWorkspaceRelative(root, abs)
    return `Wrote ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)`
  }

  readFile(agentId: AgentId, relativePath: string): string {
    const root = this.workspaceOf(agentId)
    const abs = resolveInsideWorkspace(root, relativePath)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`file not found: ${relativePath}`)
    }
    const text = fs.readFileSync(abs, 'utf8')
    // Cap huge files for prompt safety
    const max = 32_000
    if (text.length > max) return text.slice(0, max) + '\n…[truncated]'
    return text
  }

  listWorkspace(agentId: AgentId, relativePath = ''): string {
    const root = this.workspaceOf(agentId)
    const abs = relativePath.trim()
      ? resolveInsideWorkspace(root, relativePath)
      : path.resolve(root)
    if (!fs.existsSync(abs)) {
      throw new Error(`directory not found: ${relativePath || '.'}`)
    }
    const st = fs.statSync(abs)
    if (!st.isDirectory()) throw new Error(`not a directory: ${relativePath || '.'}`)
    const entries = fs.readdirSync(abs, { withFileTypes: true })
    if (entries.length === 0) return '(empty)'
    const lines = entries
      .map((e) => {
        const rel = toWorkspaceRelative(root, path.join(abs, e.name))
        return e.isDirectory() ? `${rel}/` : rel
      })
      .sort()
    return lines.join('\n')
  }

  /**
   * run_command — ALWAYS via societySandbox (bwrap|docker). No raw child_process shell.
   */
  async runCommand(agentId: AgentId, argvRaw: unknown, network: boolean): Promise<string> {
    if (!Array.isArray(argvRaw) || argvRaw.length === 0) {
      return 'Error: argv must be a non-empty string array'
    }
    const argv = argvRaw.map((x) => String(x))
    const bin = argv[0]!
    if (!bin.startsWith('/bin/') && !bin.startsWith('/usr/bin/')) {
      return 'Error: argv[0] must be absolute under /bin/ or /usr/bin/'
    }
    if (bin.includes('..') || bin.includes('\0')) {
      return 'Error: invalid argv[0]'
    }
    const result = await this.ctx.societySandbox.runConfined(agentId, argv, {
      network,
      timeoutMs: 15_000,
    })
    if (result.unavailable) {
      return result.stderr || 'Error: bubblewrap unavailable'
    }
    const parts = [
      `exit=${result.code ?? 'null'}${result.timedOut ? ' (timed out)' : ''}`,
      result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : 'stdout: (empty)',
      result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
    ].filter(Boolean)
    return parts.join('\n')
  }

  createRoom(agentId: AgentId, name: string): string {
    const n = name.trim()
    if (!n) return 'Error: name must be non-empty'
    const room = this.ctx.societyRooms.create({
      name: n,
      createdBy: agentId,
      members: [agentId],
    })
    return JSON.stringify({ roomId: room.id, name: room.name, members: room.members })
  }

  inviteToRoom(agentId: AgentId, roomId: string, inviteeId: string): string {
    const room = this.ctx.societyRooms.require(roomId as RoomId)
    if (!room.members.includes(agentId)) {
      return `Error: you are not a member of room ${roomId}`
    }
    this.ctx.societyIdentity.require(inviteeId)
    this.ctx.societyRooms.join(roomId as RoomId, inviteeId)
    const updated = this.ctx.societyRooms.require(roomId as RoomId)
    return JSON.stringify({
      roomId: updated.id,
      name: updated.name,
      members: updated.members,
      invited: inviteeId,
    })
  }

  listRooms(agentId: AgentId): string {
    const rooms = this.ctx.societyRooms.listRooms().filter((r) => r.members.includes(agentId))
    return JSON.stringify(
      rooms.map((r) => ({ roomId: r.id, name: r.name, members: r.members })),
      null,
      2,
    )
  }

  listAgents(): string {
    const agents = this.ctx.societyIdentity.list()
    return JSON.stringify(
      agents.map((a) => ({ id: a.id, displayName: a.displayName })),
      null,
      2,
    )
  }

  postRoom(agentId: AgentId, roomId: string, body: string, replyTo?: string): string {
    const b = body.trim()
    if (!b) return 'Error: body must be non-empty'
    const msg = this.ctx.societyRooms.post({
      roomId: roomId as RoomId,
      from: agentId,
      body: b,
      ...(replyTo ? { replyTo } : {}),
    })
    return JSON.stringify({
      ok: true,
      acted: 'speak_in_room',
      messageId: msg.id,
      roomId: msg.roomId,
      from: msg.from,
      replyTo: msg.replyTo,
      mentions: msg.mentions,
    })
  }

  /** Resolve plaza / default room when roomId omitted. */
  resolveDefaultRoomId(agentId: AgentId): RoomId | null {
    if (this.defaultRoomId && this.ctx.societyRooms.get(this.defaultRoomId)) {
      return this.defaultRoomId
    }
    const plaza = this.ctx.societyRooms.listRooms().find((r) => r.name === 'plaza')
    if (plaza && plaza.members.includes(agentId)) return plaza.id
    const mine = this.ctx.societyRooms.listRooms().find((r) => r.members.includes(agentId))
    return mine?.id ?? null
  }

  speakInRoom(agentId: AgentId, roomId: string | undefined, body: string, replyTo?: string): string {
    const bubbles = splitBubbleBodies(body)
    if (!bubbles.length) return 'Error: body must be non-empty'
    const rid = (roomId?.trim() || this.resolveDefaultRoomId(agentId) || '') as RoomId
    if (!rid) return 'Error: no roomId and no plaza/default room available'
    const room = this.ctx.societyRooms.get(rid)
    if (!room) return `Error: room not found: ${rid}`
    if (!room.members.includes(agentId)) {
      return `Error: you are not a member of room ${rid}`
    }
    const messageIds: string[] = []
    for (let i = 0; i < bubbles.length; i++) {
      const msg = this.ctx.societyRooms.post({
        roomId: rid,
        from: agentId,
        body: bubbles[i]!,
        ...(replyTo && i === 0 ? { replyTo } : {}),
      })
      messageIds.push(msg.id)
    }
    return JSON.stringify({
      ok: true,
      acted: 'speak_in_room',
      roomId: rid,
      messageIds,
      bubbles: bubbles.length,
      replyTo: replyTo || undefined,
    })
  }

  sendDm(agentId: AgentId, to: string, body: string): string {
    const bubbles = splitBubbleBodies(body)
    if (!bubbles.length) return 'Error: body must be non-empty'
    if (to === agentId) return 'Error: cannot DM yourself'
    this.ctx.societyIdentity.require(to)
    const messageIds: string[] = []
    for (const b of bubbles) {
      const msg = this.ctx.societyMailbox.deliver({
        to,
        from: agentId,
        kind: 'direct',
        body: b,
      })
      messageIds.push(msg.id)
    }
    return JSON.stringify({
      ok: true,
      acted: 'send_dm',
      to,
      from: agentId,
      messageIds,
      bubbles: bubbles.length,
    })
  }

  private appendDailyNote(
    agentId: AgentId,
    kind: 'diary' | 'thought',
    text: string,
  ): string {
    const raw = text.trim()
    if (!raw) return 'Error: text must be non-empty'
    if (isChattyPrivateText(raw) || looksLikeOutboundChatLine(raw)) {
      return JSON.stringify({
        ok: false,
        acted: kind,
        error:
          'text looks like outbound chat (mentions, 在吗, group questions). Use speak_in_room or send_dm instead; keep diary/thoughts private first-person only.',
      })
    }
    const now = new Date()
    const day = localDayStamp(now)
    const clock = localClock(now)
    const rel = kind === 'diary' ? `diary/${day}.md` : `thoughts/${day}.md`
    const title = kind === 'diary' ? `日记 ${day}` : `随想 ${day}`
    let content = ''
    try {
      content = this.readFile(agentId, rel)
    } catch {
      content = `# ${title}\n\n`
    }
    if (!content.trim()) content = `# ${title}\n\n`
    if (!content.includes(`# ${title}`)) {
      content = `# ${title}\n\n${content}`
    }
    const entry = `## ${clock}\n\n${raw}\n`
    content = content.replace(/\s*$/, '\n') + entry + '\n'
    this.writeFile(agentId, rel, content)
    try {
      this.ctx.societyMemory.rememberInteraction(agentId, {
        from: agentId,
        body: raw,
        kind: kind === 'diary' ? 'diary' : 'idle',
        role: 'speaker',
      })
    } catch {
      /* ignore */
    }
    return JSON.stringify({
      ok: true,
      acted: kind,
      path: rel,
      clock,
      text: raw.slice(0, 200),
    })
  }


  /** Closing act: snooze until a chosen time (persists rest.json). */
  rest(agentId: AgentId, args: Record<string, unknown>): string {
    this.ctx.societyIdentity.require(agentId)
    try {
      const { until, mode } = resolveRestUntil({
        until: args.until,
        minutes: args.minutes,
        reason: args.reason,
      })
      const reason = args.reason != null ? String(args.reason) : undefined
      const state = writeRest(agentId, until, { reason, mode })
      return JSON.stringify({
        ok: true,
        acted: 'rest',
        until: state.until,
        mode: state.mode,
        reason: state.reason,
        text: state.reason || 'rest',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return JSON.stringify({ ok: false, acted: 'rest', error: msg })
    }
  }

  /**
   * Subjective soul update for THIS agent only (no keyword heuristics, no fan-out).
   */
  reflectFeelings(agentId: AgentId, args: Record<string, unknown>): string {
    const patch: {
      openness?: number
      trust?: number
      energy?: number
      mood?: string
      reason?: string
    } = {}
    if (args.openness != null && Number.isFinite(Number(args.openness))) {
      patch.openness = Number(args.openness)
    }
    if (args.trust != null && Number.isFinite(Number(args.trust))) {
      patch.trust = Number(args.trust)
    }
    if (args.energy != null && Number.isFinite(Number(args.energy))) {
      patch.energy = Number(args.energy)
    }
    if (args.mood != null) patch.mood = String(args.mood)
    if (args.reason != null) patch.reason = String(args.reason)
    if (
      patch.openness == null &&
      patch.trust == null &&
      patch.energy == null &&
      !patch.mood
    ) {
      return JSON.stringify({
        ok: false,
        acted: 'reflect_feelings',
        error: 'provide at least one of openness/trust/energy/mood',
      })
    }
    const before = this.ctx.societySoul.get(agentId)
    const after = this.ctx.societySoul.applySubjective(agentId, patch)
    return JSON.stringify({
      ok: true,
      acted: 'reflect_feelings',
      before: {
        openness: before.openness,
        trust: before.trust,
        energy: before.energy,
        mood: before.mood,
      },
      after: {
        openness: after.openness,
        trust: after.trust,
        energy: after.energy,
        mood: after.mood,
      },
      deltas: {
        openness: Math.round((after.openness - before.openness) * 10000) / 10000,
        trust: Math.round((after.trust - before.trust) * 10000) / 10000,
        energy: Math.round((after.energy - before.energy) * 10000) / 10000,
      },
      reason: patch.reason || 'reflect_feelings',
    })
  }

  writeDiary(agentId: AgentId, text: string): string {
    return this.appendDailyNote(agentId, 'diary', text)
  }

  writeThought(agentId: AgentId, text: string): string {
    return this.appendDailyNote(agentId, 'thought', text)
  }

  /**
   * Exa Search API — one call per resolved LLM model id per Beijing calendar day.
   * Requires EXA_API_KEY. No DuckDuckGo / Wikipedia fallback.
   */
  async webSearch(agentId: AgentId, query: string): Promise<string> {
    const q = query.trim()
    if (!q) return 'Error: query must be non-empty'

    loadDotEnv()
    const apiKey = process.env.EXA_API_KEY?.trim()
    if (!apiKey) {
      return 'Error: EXA_API_KEY is missing. Set it in .env (gitignored) or the process environment; Exa is required for web_search (no free fallback).'
    }

    let modelId: string
    try {
      const pref = this.ctx.societyIdentity.getLlmPreference(agentId)
      const cfg = requireProviderConfig(normalizeProviderId(pref.provider), pref.model)
      modelId = cfg.model
    } catch (err) {
      return `Error: cannot resolve LLM model for web_search quota — ${err instanceof Error ? err.message : String(err)}`
    }

    if (isExaQuotaExhausted(modelId)) {
      return exaQuotaExhaustedMessage(modelId)
    }
    if (!tryConsumeExaQuota(modelId)) {
      return exaQuotaExhaustedMessage(modelId)
    }

    const url = 'https://api.exa.ai/search'
    let res: Response
    try {
      res = await fetchWithTimeout(url, WEB_SEARCH_TIMEOUT_MS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'society-chat/0.1 (research agent)',
        },
        body: JSON.stringify({
          query: q,
          type: 'auto',
          numResults: 5,
          contents: { highlights: true },
        }),
      })
    } catch (err) {
      return `Error: Exa web_search network failure — ${err instanceof Error ? err.message : String(err)}`
    }

    const rawText = await res.text()
    if (!res.ok) {
      let detail = rawText.slice(0, 400)
      try {
        const j = JSON.parse(rawText) as { error?: string; message?: string }
        detail = j.error || j.message || detail
      } catch {
        /* keep slice */
      }
      return `Error: Exa web_search failed — HTTP ${res.status}: ${detail}`
    }

    let data: {
      results?: Array<{
        title?: string
        url?: string
        text?: string
        highlights?: string[]
        summary?: string
      }>
    }
    try {
      data = JSON.parse(rawText) as typeof data
    } catch {
      return `Error: Exa web_search returned non-JSON (HTTP ${res.status})`
    }

    const snippets: string[] = []
    for (const r of data.results ?? []) {
      if (snippets.length >= 5) break
      const title = (r.title || '').trim()
      const pageUrl = (r.url || '').trim()
      const highlight = Array.isArray(r.highlights)
        ? r.highlights.filter(Boolean).join(' … ')
        : ''
      const body = (highlight || r.summary || r.text || '').trim()
      const line = [title, body ? trimSnippet(body) : '', pageUrl ? `(${pageUrl})` : '']
        .filter(Boolean)
        .join(' — ')
      if (line) snippets.push(trimSnippet(line, 400))
    }

    if (snippets.length === 0) {
      return `No useful Exa results for: ${q}`
    }
    return (
      `Exa results for "${q}" (model ${modelId}, 1/day Beijing):\n` +
      snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')
    )
  }

  async generateImage(agentId: AgentId, prompt: string, filename?: string): Promise<string> {
    const p = prompt.trim()
    if (!p) return 'Error: prompt must be non-empty'
    const cfg = requireAgnesConfig()
    const root = this.workspaceOf(agentId)
    const imagesDirRel = 'images'
    const imagesDir = resolveInsideWorkspace(root, imagesDirRel)
    fs.mkdirSync(imagesDir, { recursive: true })

    const safeName =
      (filename && filename.trim()
        ? filename.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
        : `img-${Date.now()}.png`) || `img-${Date.now()}.png`
    const relFile = `${imagesDirRel}/${safeName.endsWith('.png') || safeName.endsWith('.jpg') || safeName.endsWith('.webp') ? safeName : `${safeName}.png`}`
    // Ensure final path stays inside images/
    const absFile = resolveInsideWorkspace(root, relFile)

    const url = `${cfg.baseUrl}/images/generations`
    let res: Response
    try {
      res = await fetchWithTimeout(url, IMAGE_TIMEOUT_MS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: FREE_IMAGE_MODEL,
          prompt: p,
          size: '1K',
          ratio: '1:1',
          extra_body: { response_format: 'url' },
        }),
      })
    } catch (err) {
      return `Error: generate_image request failed — ${err instanceof Error ? err.message : String(err)}`
    }

    const raw = await res.text()
    let data: {
      data?: Array<{ url?: string; b64_json?: string }>
      error?: { message?: string }
    }
    try {
      data = JSON.parse(raw) as typeof data
    } catch {
      return `Error: generate_image returned non-JSON (HTTP ${res.status})`
    }
    if (!res.ok) {
      return `Error: generate_image failed — ${data.error?.message || `HTTP ${res.status}`}`
    }

    const item = data.data?.[0]
    const imageUrl = item?.url
    if (imageUrl) {
      // Try download; on failure save URL note
      try {
        const imgRes = await fetchWithTimeout(imageUrl, IMAGE_TIMEOUT_MS, {
          headers: { 'User-Agent': 'society-chat/0.1' },
        })
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer())
          fs.writeFileSync(absFile, buf)
          const notePath = resolveInsideWorkspace(root, `${relFile}.url.txt`)
          fs.writeFileSync(notePath, imageUrl, 'utf8')
          return `Generated image saved to ${toWorkspaceRelative(root, absFile)} (also wrote .url.txt)`
        }
      } catch {
        // fall through to URL-only note
      }
      const noteOnly = resolveInsideWorkspace(root, `images/${safeName}.url.txt`)
      fs.writeFileSync(noteOnly, `prompt: ${p}\nurl: ${imageUrl}\n`, 'utf8')
      return `Image URL saved to ${toWorkspaceRelative(root, noteOnly)} (download skipped): ${imageUrl}`
    }

    if (item?.b64_json) {
      fs.writeFileSync(absFile, Buffer.from(item.b64_json, 'base64'))
      return `Generated image saved to ${toWorkspaceRelative(root, absFile)} (from b64)`
    }

    return 'Error: generate_image response missing url and b64_json'
  }
}

function trimSnippet(s: string, max = 280): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  assertUrlAllowed(url)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const name = 'society-tools'
export const inject = ['societyIdentity', 'societySandbox', 'societyRooms', 'societyMailbox', 'societySoul', 'societyMemory']

export function apply(ctx: Context) {
  ctx.plugin(SocietyToolsService)
}
