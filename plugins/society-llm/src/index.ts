/**
 * society-llm — OpenAI-compatible chat via Agnes and/or GLM (per-agent routing).
 * Cordis service name: `societyLlm`
 *
 * Defaults: Alice/Carol → Agnes free flash; Bob → GLM glm-4-flash.
 * Image gen stays Agnes-only (society-tools).
 * Never logs API keys.
 *
 * Retries: 429 → 15s; other errors → 30s; max 10 attempts.
 * Turns: structured closing tools (speak_in_room / stay_silent / write_diary / …).
 * Multi-bubble via ||| inside tool args. No ACTION: text protocol.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, InboxMessage, RoomMessage } from '../../../src/types.ts'
import {
  normalizeProviderId,
  providerModelLabel,
  requireProviderConfig,
  type LlmEndpointConfig,
  type LlmProviderId,
} from '../../../src/env.ts'
import { LlmHttpError, withLlmRetries } from '../../../src/llm-http.ts'
import {
  isClosingToolName,
  type ToolDefinition,
} from '../../society-tools/src/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyLlm: SocietyLlmService
  }
}

export interface ReplyStimulus {
  /** Raw inbox message that woke the agent (preferred). */
  message?: InboxMessage
  /** Free-form user content if no inbox message. */
  text?: string
  /** Optional short room name for prompt context. */
  roomName?: string
  /** Recent room timeline (oldest→newest), injected by LLM service if omitted. */
  roomRecent?: RoomMessage[]
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
  name?: string
}

export interface AgentTurn {
  silent: boolean
  bubbles: string[]
  raw: string
}

/** Result of a tool-closed idle or reply turn (side effects already applied by tools). */
export type ClosingActKind =
  | 'speak_in_room'
  | 'send_dm'
  | 'diary'
  | 'thought'
  | 'do_nothing'
  | 'stay_silent'
  | 'none'

export interface AgentActResult {
  /** Which closing tool succeeded (or none if soft-fail). */
  acted: ClosingActKind
  ok: boolean
  /** Tool JSON / summary for logs. */
  detail?: string
  /** Research tools used before closing. */
  researchTools: string[]
  /** True when a closing tool already posted/wrote — scheduler must not double-deliver. */
  sideEffectDone: boolean
}

export type ActMode = 'idle' | 'reply-room' | 'reply-dm'

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiChoiceMessage {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: OpenAiToolCall[]
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: OpenAiChoiceMessage; finish_reason?: string }>
  error?: { message?: string; code?: string | number }
}

const MAX_TOOL_ROUNDS = 3
const MAX_BUBBLES = 5
const MAX_BUBBLE_CHARS = 2000

/** Parse model output into silence vs one-or-more chat bubbles. Exported for smokes. */
export function parseAgentTurn(raw: string): AgentTurn {
  const text = (raw ?? '').trim()
  if (!text) return { silent: true, bubbles: [], raw: text }

  const fromJson = tryParseJsonTurn(text)
  if (fromJson) return { ...fromJson, raw: text }

  const lines = text.split(/\r?\n/)
  let action: 'silent' | 'reply' | null = null
  let cut = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (/^ACTION:\s*SILENT\s*$/i.test(line)) {
      action = 'silent'
      cut = i
      break
    }
    if (/^ACTION:\s*REPLY\s*$/i.test(line)) {
      action = 'reply'
      cut = i
      break
    }
  }

  if (action === 'silent') {
    return { silent: true, bubbles: [], raw: text }
  }

  let body = (action ? lines.slice(0, cut).join('\n') : text).trim()
  // Strip a lone ACTION:SILENT if model put it mid-body as only content
  if (/^ACTION:\s*SILENT\s*$/i.test(body)) {
    return { silent: true, bubbles: [], raw: text }
  }

  const bubbles = splitBubbles(body)
  if (bubbles.length === 0) return { silent: true, bubbles: [], raw: text }
  return { silent: false, bubbles, raw: text }
}

function tryParseJsonTurn(text: string): Omit<AgentTurn, 'raw'> | null {
  let candidate = text.trim()
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidate = fence[1]!.trim()

  // Prefer object or array slice
  const objStart = candidate.indexOf('{')
  const arrStart = candidate.indexOf('[')
  let slice: string | null = null
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    const end = candidate.lastIndexOf('}')
    if (end > objStart) slice = candidate.slice(objStart, end + 1)
  } else if (arrStart >= 0) {
    const end = candidate.lastIndexOf(']')
    if (end > arrStart) slice = candidate.slice(arrStart, end + 1)
  }
  if (!slice) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }

  if (Array.isArray(parsed)) {
    const bubbles = parsed
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_BUBBLES)
      .map((b) => b.slice(0, MAX_BUBBLE_CHARS))
    if (bubbles.length === 0) return { silent: true, bubbles: [] }
    return { silent: false, bubbles }
  }

  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (o.reply === false || o.silent === true) {
      return { silent: true, bubbles: [] }
    }
    if (Array.isArray(o.bubbles)) {
      const bubbles = o.bubbles
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .slice(0, MAX_BUBBLES)
        .map((b) => b.slice(0, MAX_BUBBLE_CHARS))
      if (bubbles.length === 0) return { silent: true, bubbles: [] }
      return { silent: false, bubbles }
    }
    if (typeof o.text === 'string' && o.text.trim()) {
      return { silent: false, bubbles: splitBubbles(o.text.trim()) }
    }
    if (o.reply === true && typeof o.body === 'string') {
      return { silent: false, bubbles: splitBubbles(o.body.trim()) }
    }
  }
  return null
}

function splitBubbles(body: string): string[] {
  const trimmed = body.trim()
  if (!trimmed) return []
  if (trimmed.includes('|||')) {
    return trimmed
      .split('|||')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_BUBBLES)
      .map((b) => b.slice(0, MAX_BUBBLE_CHARS))
  }
  // Numbered parts: "1. ...\n2. ..." only when ≥2 clear numbered lines
  const numbered = trimmed.match(/^\s*\d+[.)、]\s+.+/gm)
  if (numbered && numbered.length >= 2) {
    const parts = numbered
      .map((line) => line.replace(/^\s*\d+[.)、]\s+/, '').trim())
      .filter(Boolean)
      .slice(0, MAX_BUBBLES)
      .map((b) => b.slice(0, MAX_BUBBLE_CHARS))
    if (parts.length >= 2) return parts
  }
  return [trimmed.slice(0, MAX_BUBBLE_CHARS)]
}

export class SocietyLlmService extends Service {
  static inject = ['societyIdentity', 'societyMemory', 'societySoul', 'societyTools', 'societyRooms']

  constructor(ctx: Context) {
    super(ctx, 'societyLlm')
  }

  /** Resolve endpoint for this agent (llm.json / profile / defaults). Never logs keys. */
  resolveConfig(agentId: AgentId): LlmEndpointConfig {
    const pref = this.ctx.societyIdentity.getLlmPreference(agentId)
    const provider: LlmProviderId = normalizeProviderId(pref.provider)
    return requireProviderConfig(provider, pref.model)
  }

  /** Safe label for logs: provider=model */
  describeAgentRoute(agentId: AgentId): string {
    return providerModelLabel(this.resolveConfig(agentId))
  }

  /** Build a Chinese-friendly system prompt from identity + soul + memory + tools. */
  buildSystemPrompt(agentId: AgentId, withTools: boolean): string {
    const agent = this.ctx.societyIdentity.require(agentId)
    const soulSection = this.ctx.societySoul.getPromptSection(agentId)
    const memorySection = this.ctx.societyMemory.getPromptSection(agentId)
    const lines = [
      `你是 ${agent.displayName}（内部 id: ${agent.id}）。`,
      `人设：${agent.persona}`,
      soulSection,
      memorySection,
      '你是独立的人：先过自己的生活（思考、日记、工具、主动私信）；广场/群聊只是可选社交工具，不是你存在的全部。',
      '规则：',
      '- 始终保持上述人设、灵魂状态与记忆，用中文简短说话。',
      '- 不要加「Alice:」之类前缀，不要解释你是 AI 或模型。',
      '- 不要输出思考过程或 reasoning。',
      '- 收到消息后先判断要不要开口：若消息 @点名你、回复你的话、问候你、问你问题、或私信给你，应当回复（调用 speak_in_room / send_dm），不要 stay_silent。',
      '- 群聊里别人互相对话、话题与你无关、刺激已被更新的话题盖过且你未被 @，调用 stay_silent，不要抢着刷屏。',
      '- 点名某人时在正文里写 @显示名（例如 @阿宁）；回复某条时系统会自动挂 replyTo。',
      '- 长话可在工具参数 body 里用 ||| 拆成 2～4 条短气泡。单条尽量一两句。不要扮演别人发言。',
      '- 禁止输出 ACTION: 控制行或把工具菜单抄进聊天；只能通过工具完成发言/日记/沉默。',
    ]
    if (withTools) {
      lines.push(
        '- 研究工具（可选）：web_search / write_file / read_file / list_workspace / list_agents / list_rooms / run_command / generate_image。',
        '- 收束工具（本回合必须最终调用其一）：speak_in_room / send_dm / write_diary / write_thought / do_nothing（空闲）或 stay_silent / speak_in_room / send_dm（回复）。',
        '- write_diary / write_thought 只能写给自己的第一人称私密内容；想喊人、提问群友、说「xxx在吗」必须用 speak_in_room 或 send_dm。',
        '- 若兴趣含时政/新闻/辩论/政治：空闲时请先 web_search 再 speak_in_room 或 write_diary。',
        '- 只有对方明确要求生图时才调用 generate_image。',
        '- 路径必须相对 workspace；run_command 的 argv[0] 必须是 /bin/ 或 /usr/bin/ 下绝对路径。',
      )
    }
    return lines.join('\n')
  }

  buildUserPrompt(agentId: AgentId, stimulus: ReplyStimulus): string {
    const agent = this.ctx.societyIdentity.require(agentId)
    const msg = stimulus.message
    const decideHint =
      '先决定要不要回：若对方 @你 / 回复你 / 问候或问你，必须调用 speak_in_room（或私信 send_dm）；若刺激已被更新话题盖过且你未被点名，调用 stay_silent。要回则在工具 body 里写短气泡（可用 |||；点名别人用 @显示名）。不要输出 ACTION: 文本。'
    if (msg) {
      if (msg.kind === 'room' && msg.roomId) {
        const roomLabel = stimulus.roomName ? `「${stimulus.roomName}」` : ''
        const recent =
          stimulus.roomRecent ??
          this.ctx.societyRooms.historyOf(msg.roomId).slice(-8)
        const nameOf = (id: string) => this.ctx.societyIdentity.displayNameOf(id)
        const timeline = recent
          .map((m) => {
            const mark = m.id === msg.sourceMessageId ? ' ←【你正在回应的这条】' : ''
            const reply =
              m.replyTo
                ? ` (回复 ${recent.find((x) => x.id === m.replyTo)?.from ? nameOf(recent.find((x) => x.id === m.replyTo)!.from) : m.replyTo.slice(0, 8)})`
                : ''
            const at =
              m.mentions?.length
                ? ` [@${m.mentions.map(nameOf).join(' @')}]`
                : ''
            return `- [${m.id.slice(0, 8)}] ${nameOf(m.from)}${reply}${at}: ${m.body}${mark}`
          })
          .join('\n')
        const mentioned =
          msg.mentioned || msg.mentions?.includes(agentId)
            ? '是，这条消息点名了你。'
            : '否，你未被明确 @。'
        const replyTarget = msg.replyTo
          ? `该消息本身在回复另一条（id=${msg.replyTo.slice(0, 8)}）。`
          : ''
        return [
          `你在群聊${roomLabel}中收到一条消息。`,
          `原始投递：${msg.body}`,
          `是否点名你：${mentioned} ${replyTarget}`.trim(),
          '广场最近消息（旧→新）：',
          timeline || '（暂无历史）',
          decideHint,
          `若开口，请以 ${agent.displayName} 的身份说话，对准正确的人；可用 @显示名。系统会自动把你的回复挂到刺激消息上。`,
        ].join('\n')
      }
      if (msg.kind === 'direct') {
        const fromLabel = this.ctx.societyIdentity.displayNameOf(String(msg.from))
        return [
          `你收到来自 ${fromLabel}（${msg.from}）的私信（私信默认应回复，除非是骚扰/无意义刷屏）：`,
          msg.body,
          '用 send_dm 回复；长话可用 ||| 拆分。一般不要 stay_silent。',
          `请以 ${agent.displayName} 的身份说话。`,
        ].join('\n')
      }
      return [
        `系统通知：${msg.body}`,
        decideHint,
        `若开口，请以 ${agent.displayName} 的身份作简短回应。`,
      ].join('\n')
    }
    const text = stimulus.text?.trim()
    if (!text) throw new Error('replyAsAgent: stimulus.message or stimulus.text required')
    return text
  }

  /**
   * One-shot chat completion as the given agent (no tools).
   * Prefer actAsAgent when tools may be needed.
   */
  async replyAsAgent(agentId: AgentId, stimulus: ReplyStimulus): Promise<string> {
    this.ctx.societyIdentity.require(agentId)
    const cfg = this.resolveConfig(agentId)
    this.ctx.logger('society-llm').info(`chat ${agentId} ${providerModelLabel(cfg)} (no-tools)`)
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(agentId, false) },
      { role: 'user', content: this.buildUserPrompt(agentId, stimulus) },
    ]
    const { content } = await this.chatCompletions(messages, cfg, { tools: false })
    const cleaned = (content ?? '').trim()
    if (!cleaned) throw new Error(`Empty LLM content for agent ${agentId}`)
    return cleaned
  }

  /** Same as replyAsAgent but parsed into silence / bubbles. */
  async replyTurnAsAgent(agentId: AgentId, stimulus: ReplyStimulus): Promise<AgentTurn> {
    const raw = await this.replyAsAgent(agentId, stimulus)
    return parseAgentTurn(raw)
  }

  /**
   * @deprecated Prefer actClosedTurn — text returns are no longer posted by scheduler.
   * Kept for birth/tools smokes that only need tool execution mid-turn.
   */
  async actAsAgent(agentId: AgentId, stimulus: ReplyStimulus): Promise<string> {
    const result = await this.actClosedTurn(agentId, stimulus, 'reply-room')
    return JSON.stringify(result)
  }

  /** @deprecated Use actClosedTurn; maps closing tools to legacy AgentTurn shape. */
  async actTurnAsAgent(agentId: AgentId, stimulus: ReplyStimulus): Promise<AgentTurn> {
    const mode: ActMode =
      stimulus.message?.kind === 'direct' ? 'reply-dm' : 'reply-room'
    const result = await this.actClosedTurn(agentId, stimulus, mode)
    if (result.acted === 'stay_silent' || result.acted === 'do_nothing' || result.acted === 'none') {
      return { silent: true, bubbles: [], raw: result.detail || '' }
    }
    // Side effects already done by tools — bubbles empty so scheduler does not re-post
    return { silent: false, bubbles: [], raw: result.detail || result.acted }
  }

  /**
   * Tool-closed turn: optional research tools, then MUST call exactly one closing tool.
   * Providers get tool_choice=auto (required not universally supported); if model returns
   * only text, one nudge retry; still no closing tool → soft-fail acted=none (no post).
   */
  async actClosedTurn(
    agentId: AgentId,
    stimulus: ReplyStimulus,
    mode: ActMode,
    opts?: { injectReplyTo?: string; defaultDmTo?: string },
  ): Promise<AgentActResult> {
    this.ctx.societyIdentity.require(agentId)
    const cfg = this.resolveConfig(agentId)
    this.ctx.logger('society-llm').info(
      `chat ${agentId} ${providerModelLabel(cfg)} (closing-tools mode=${mode})`,
    )

    const tools =
      mode === 'idle'
        ? this.ctx.societyTools.getIdleToolDefinitions()
        : this.ctx.societyTools.getReplyToolDefinitions(mode === 'reply-dm' ? 'direct' : 'room')

    const userContent =
      mode === 'idle'
        ? stimulus.text || this.buildUserPrompt(agentId, stimulus)
        : this.buildUserPrompt(agentId, stimulus)

    const closingHint =
      mode === 'idle'
        ? [
            '【收束规则】可先用研究工具（如 web_search），但本回合结束前必须调用且仅调用一个收束工具：',
            'speak_in_room（去广场/群聊说话；可省略 roomId） / send_dm / write_diary / write_thought / do_nothing。',
            '禁止输出 ACTION: 行，禁止只回纯文本。日记必须是写给自己的私密话。',
          ].join('\n')
        : [
            '【收束规则】可先用研究工具，但本回合结束前必须调用且仅调用一个收束工具：',
            mode === 'reply-dm'
              ? 'send_dm（回对方）或 stay_silent。'
              : 'speak_in_room（回复当前刺激；系统会自动带 replyTo）或 stay_silent；一般不要改去私信。',
            '禁止输出 ACTION: 行，禁止只回纯文本当回复。',
          ].join('\n')

    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(agentId, true) },
      { role: 'user', content: `${userContent}\n\n${closingHint}` },
    ]

    const researchTools: string[] = []
    let nudged = false

    for (let round = 0; round <= MAX_TOOL_ROUNDS + 1; round++) {
      const allowTools = true
      const result = await this.chatCompletions(messages, cfg, {
        tools: allowTools,
        toolDefs: tools,
        toolChoice: 'auto',
      })

      if (result.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.tool_calls,
        })

        let closing: AgentActResult | null = null
        for (const tc of result.tool_calls) {
          let argsJson = tc.function.arguments || '{}'
          if (tc.function.name === 'speak_in_room' && opts?.injectReplyTo) {
            try {
              const args = JSON.parse(argsJson) as Record<string, unknown>
              if (!args.replyTo) args.replyTo = opts.injectReplyTo
              if (!args.roomId && stimulus.message?.roomId) args.roomId = stimulus.message.roomId
              argsJson = JSON.stringify(args)
            } catch {
              /* keep original */
            }
          }
          if (tc.function.name === 'send_dm' && opts?.defaultDmTo) {
            try {
              const args = JSON.parse(argsJson) as Record<string, unknown>
              if (!args.to) args.to = opts.defaultDmTo
              argsJson = JSON.stringify(args)
            } catch {
              /* keep original */
            }
          }

          const toolResult = await this.ctx.societyTools.execute(
            agentId,
            tc.function.name,
            argsJson,
          )
          this.ctx.logger('society-llm').info(
            `tool ${agentId} ${tc.function.name} → ${toolResult.slice(0, 160)}`,
          )
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: toolResult,
          })

          if (isClosingToolName(tc.function.name)) {
            const parsed = parseClosingToolResult(tc.function.name, toolResult)
            if (parsed.ok) {
              closing = { ...parsed, researchTools }
            } else if (parsed.acted === 'diary' || parsed.acted === 'thought') {
              // Chatty reject — nudge to use speak_in_room; do not treat as success
              messages.push({
                role: 'user',
                content:
                  '上一次日记/随想因像群聊喊话被拒绝。请改用 speak_in_room 或 send_dm 说话，或写真正私密的第一人称日记。必须再调用一个收束工具。',
              })
            } else {
              closing = { ...parsed, researchTools }
            }
          } else {
            researchTools.push(tc.function.name)
          }
        }

        if (closing?.ok) return closing
        // Continue loop for more research or retry after diary reject
        continue
      }

      // Text-only response — nudge once then soft-fail
      const cleaned = (result.content ?? '').trim()
      if (!nudged) {
        nudged = true
        messages.push({
          role: 'assistant',
          content: cleaned || null,
        })
        messages.push({
          role: 'user',
          content:
            '不要只输出文字。请立刻调用一个收束工具（speak_in_room / send_dm / write_diary / write_thought / do_nothing 或 stay_silent）完成本回合。',
        })
        continue
      }

      this.ctx.logger('society-llm').warn(
        `closing soft-fail ${agentId}: text-only after nudge (${cleaned.slice(0, 80)})`,
      )
      return {
        acted: 'none',
        ok: false,
        detail: cleaned.slice(0, 200),
        researchTools,
        sideEffectDone: false,
      }
    }

    return {
      acted: 'none',
      ok: false,
      detail: 'exceeded tool rounds without closing tool',
      researchTools,
      sideEffectDone: false,
    }
  }

  private async chatCompletions(
    messages: ChatMessage[],
    cfg: LlmEndpointConfig,
    opts: { tools: boolean; toolDefs?: ToolDefinition[]; toolChoice?: 'auto' | 'required' | 'none' },
  ): Promise<{ content: string | null; tool_calls?: OpenAiToolCall[] }> {
    const log = (msg: string) => this.ctx.logger('society-llm').warn(msg)
    return withLlmRetries(
      `${cfg.provider} chat/completions`,
      () => this.chatCompletionsOnce(messages, cfg, opts),
      log,
    )
  }

  private async chatCompletionsOnce(
    messages: ChatMessage[],
    cfg: LlmEndpointConfig,
    opts: { tools: boolean; toolDefs?: ToolDefinition[]; toolChoice?: 'auto' | 'required' | 'none' },
  ): Promise<{ content: string | null; tool_calls?: OpenAiToolCall[] }> {
    const url = `${cfg.baseUrl}/chat/completions`
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: 0.7,
      max_tokens: 1536,
    }
    if (opts.tools && opts.toolDefs?.length) {
      body.tools = opts.toolDefs
      // Prefer auto: Agnes/GLM/SiliconFlow do not all accept tool_choice=required reliably.
      body.tool_choice = opts.toolChoice ?? 'auto'
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new LlmHttpError(cfg.provider, 0, `${cfg.provider} network error: ${msg}`)
    }

    const raw = await res.text()
    let data: OpenAiChatResponse
    try {
      data = JSON.parse(raw) as OpenAiChatResponse
    } catch {
      throw new LlmHttpError(
        cfg.provider,
        res.status,
        `${cfg.provider} API returned non-JSON (HTTP ${res.status})`,
      )
    }

    if (!res.ok) {
      const msg = data.error?.message || `HTTP ${res.status}`
      throw new LlmHttpError(
        cfg.provider,
        res.status,
        `${cfg.provider} chat/completions failed: ${msg}`,
      )
    }

    const choice = data.choices?.[0]?.message
    let tool_calls = choice?.tool_calls?.length ? choice.tool_calls : undefined
    if (tool_calls) {
      tool_calls = tool_calls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: 'function' as const,
        function: {
          name: tc.function?.name || '',
          arguments:
            typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
        },
      }))
    }
    const content = choice?.content ?? null
    if (!tool_calls?.length) {
      const trimmed = (content ?? '').trim()
      // When tools were offered, empty text is allowed so the closing-tool nudge can run.
      if (!trimmed && !(opts.tools && opts.toolDefs?.length)) {
        throw new LlmHttpError(
          cfg.provider,
          res.status,
          `${cfg.provider} response missing message.content (reasoning_content ignored)`,
        )
      }
      return { content: trimmed || null }
    }
    return { content: content ?? null, tool_calls }
  }
}


function parseClosingToolResult(name: string, toolResult: string): AgentActResult {
  const sideEffectDone = ['speak_in_room', 'send_dm', 'write_diary', 'write_thought'].includes(name)
  let acted: ClosingActKind = 'none'
  if (name === 'speak_in_room') acted = 'speak_in_room'
  else if (name === 'send_dm') acted = 'send_dm'
  else if (name === 'write_diary') acted = 'diary'
  else if (name === 'write_thought') acted = 'thought'
  else if (name === 'do_nothing') acted = 'do_nothing'
  else if (name === 'stay_silent') acted = 'stay_silent'

  if (toolResult.startsWith('Error:')) {
    return {
      acted,
      ok: false,
      detail: toolResult,
      researchTools: [],
      sideEffectDone: false,
    }
  }
  try {
    const j = JSON.parse(toolResult) as { ok?: boolean; acted?: string; error?: string }
    if (j.ok === false) {
      return {
        acted,
        ok: false,
        detail: j.error || toolResult,
        researchTools: [],
        sideEffectDone: false,
      }
    }
    return {
      acted,
      ok: true,
      detail: toolResult,
      researchTools: [],
      sideEffectDone,
    }
  } catch {
    // Non-JSON success strings for legacy tools — treat closing names as ok
    return {
      acted,
      ok: true,
      detail: toolResult,
      researchTools: [],
      sideEffectDone: sideEffectDone && !toolResult.startsWith('Error:'),
    }
  }
}

export const name = 'society-llm'
export const inject = ['societyIdentity', 'societyMemory', 'societySoul', 'societyTools', 'societyRooms']

export function apply(ctx: Context) {
  ctx.plugin(SocietyLlmService)
}
