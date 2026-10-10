/**
 * society-llm — OpenAI-compatible chat via Agnes and/or GLM (per-agent routing).
 * Cordis service name: `societyLlm`
 *
 * Defaults: Alice/Carol → Agnes free flash; Bob → GLM glm-4-flash.
 * Image gen stays Agnes-only (society-tools).
 * Never logs API keys.
 *
 * Retries: 429 → 15s; other errors → 30s; max 10 attempts.
 * Turns: optional silence + multi-bubble (||| / JSON).
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
import type { ToolDefinition } from '../../society-tools/src/index.ts'

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
      '- 收到消息后先判断要不要开口：若消息 @点名你、回复你的话、问候你、问你问题、或私信给你，应当回复，不要 SILENT。',
      '- 群聊里别人互相对话、话题与你无关、刺激已被更新的话题盖过且你未被 @，可只输出一行 ACTION:SILENT（或 JSON {"reply":false}），不要抢着刷屏。',
      '- 点名某人时在正文里写 @显示名（例如 @阿宁）；回复某条时系统会自动挂 replyTo，你只需对准说话对象。',
      '- 若要回复：可把长话拆成 2～4 条短气泡，用 ||| 分隔；或输出 JSON {"reply":true,"bubbles":["第一句","第二句"]}；也可在最后一行写 ACTION:REPLY。',
      '- 单条气泡尽量一两句；整轮最多约 4 条气泡。不要扮演别人发言。',
    ]
    if (withTools) {
      lines.push(
        '- 你可以使用工具：write_file / read_file / list_workspace（仅限自己的 workspace）、run_command（bubblewrap 沙箱）、web_search、generate_image。',
        '- 社交工具：create_room / invite_to_room / list_rooms / list_agents / post_room / send_dm / spawn_agent（可自建侧边群聊；spawn_agent 可诞生新 Agent，受人数上限约束）。',
        '- 若兴趣含时政/新闻/辩论/政治：空闲时请主动 web_search 查近期热点，再简短分享或记日记，不要只会空想。',
        '- 只有对方明确要求生图时才调用 generate_image；不要主动刷图。',
        '- 需要落盘时用 write_file；路径必须是相对路径，禁止 .. 与绝对路径。',
        '- run_command 在沙箱内执行，默认无网络；argv[0] 必须是 /bin/ 或 /usr/bin/ 下的绝对路径。',
        '- 工具调用结束后，用简短中文向对方说明结果（例如文件名），不要粘贴大段工具原始输出；仍可用 ||| 拆多气泡，或 ACTION:SILENT。',
      )
    }
    return lines.join('\n')
  }

  buildUserPrompt(agentId: AgentId, stimulus: ReplyStimulus): string {
    const agent = this.ctx.societyIdentity.require(agentId)
    const msg = stimulus.message
    const decideHint =
      '先决定要不要回：若对方 @你 / 回复你 / 问候或问你，必须回复；若刺激已被更新话题盖过且你未被点名，输出 ACTION:SILENT。要回则用短气泡（可用 |||；点名别人用 @显示名）。'
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
          '用短气泡回复；长话可用 ||| 拆分。一般不要 SILENT。',
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
   * Agent turn with OpenAI tool calling (bound to this agentId's workspace).
   * Max MAX_TOOL_ROUNDS tool rounds; final assistant text is the room/DM reply body.
   */
  async actAsAgent(agentId: AgentId, stimulus: ReplyStimulus): Promise<string> {
    const turn = await this.actTurnAsAgent(agentId, stimulus)
    if (turn.silent) return 'ACTION:SILENT'
    return turn.raw
  }

  /** Tool-capable turn returning parsed silence / bubbles. */
  async actTurnAsAgent(agentId: AgentId, stimulus: ReplyStimulus): Promise<AgentTurn> {
    this.ctx.societyIdentity.require(agentId)
    const cfg = this.resolveConfig(agentId)
    this.ctx.logger('society-llm').info(`chat ${agentId} ${providerModelLabel(cfg)} (tools)`)
    const tools = this.ctx.societyTools.getToolDefinitions()
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(agentId, true) },
      { role: 'user', content: this.buildUserPrompt(agentId, stimulus) },
    ]

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const allowTools = round < MAX_TOOL_ROUNDS
      const result = await this.chatCompletions(messages, cfg, {
        tools: allowTools,
        toolDefs: tools,
      })

      if (result.tool_calls?.length && allowTools) {
        messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.tool_calls,
        })
        for (const tc of result.tool_calls) {
          const toolResult = await this.ctx.societyTools.execute(
            agentId,
            tc.function.name,
            tc.function.arguments || '{}',
          )
          this.ctx.logger('society-llm').info(
            `tool ${agentId} ${tc.function.name} → ${toolResult.slice(0, 120)}`,
          )
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: toolResult,
          })
        }
        continue
      }

      const cleaned = (result.content ?? '').trim()
      if (!cleaned) {
        if (round < MAX_TOOL_ROUNDS) {
          messages.push({
            role: 'user',
            content:
              '请根据工具结果决定：不回则 ACTION:SILENT；要回则用中文短气泡（可用 |||），不要再调用工具。',
          })
          const final = await this.chatCompletions(messages, cfg, { tools: false })
          const text = (final.content ?? '').trim()
          if (text) return parseAgentTurn(text)
        }
        throw new Error(`Empty LLM content for agent ${agentId} after tool loop`)
      }
      return parseAgentTurn(cleaned)
    }

    throw new Error(`actAsAgent exceeded tool rounds for ${agentId}`)
  }

  private async chatCompletions(
    messages: ChatMessage[],
    cfg: LlmEndpointConfig,
    opts: { tools: boolean; toolDefs?: ToolDefinition[] },
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
    opts: { tools: boolean; toolDefs?: ToolDefinition[] },
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
      body.tool_choice = 'auto'
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
      if (!trimmed) {
        throw new LlmHttpError(
          cfg.provider,
          res.status,
          `${cfg.provider} response missing message.content (reasoning_content ignored)`,
        )
      }
      return { content: trimmed }
    }
    return { content: content ?? null, tool_calls }
  }
}

export const name = 'society-llm'
export const inject = ['societyIdentity', 'societyMemory', 'societySoul', 'societyTools', 'societyRooms']

export function apply(ctx: Context) {
  ctx.plugin(SocietyLlmService)
}
