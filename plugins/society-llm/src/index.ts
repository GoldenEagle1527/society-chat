/**
 * society-llm — OpenAI-compatible chat via Agnes and/or GLM (per-agent routing).
 * Cordis service name: `societyLlm`
 *
 * Defaults: Alice/Carol → Agnes free flash; Bob → GLM glm-4-flash.
 * Image gen stays Agnes-only (society-tools).
 * Never logs API keys.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, InboxMessage } from '../../../src/types.ts'
import {
  providerModelLabel,
  requireProviderConfig,
  type LlmEndpointConfig,
  type LlmProviderId,
} from '../../../src/env.ts'
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
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
  name?: string
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

export class SocietyLlmService extends Service {
  static inject = ['societyIdentity', 'societyMemory', 'societySoul', 'societyTools']

  constructor(ctx: Context) {
    super(ctx, 'societyLlm')
  }

  /** Resolve endpoint for this agent (llm.json / profile / defaults). Never logs keys. */
  resolveConfig(agentId: AgentId): LlmEndpointConfig {
    const pref = this.ctx.societyIdentity.getLlmPreference(agentId)
    const provider: LlmProviderId = pref.provider === 'glm' ? 'glm' : 'agnes'
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
      '规则：',
      '- 始终保持上述人设、灵魂状态与记忆，用中文简短回复（通常 1～3 句）。',
      '- 只输出你要对对方说的正文，不要加「Alice:」之类前缀，不要解释你是 AI 或模型。',
      '- 不要输出思考过程或 reasoning。',
    ]
    if (withTools) {
      lines.push(
        '- 你可以使用工具：write_file / read_file / list_workspace（仅限自己的 workspace）、run_command（bubblewrap 沙箱）、web_search、generate_image。',
        '- 社交工具：create_room / invite_to_room / list_rooms / list_agents / post_room / send_dm / spawn_agent（可自建侧边群聊；spawn_agent 可诞生新 Agent，受人数上限约束）。',
        '- 只有对方明确要求生图时才调用 generate_image；不要主动刷图。',
        '- 需要落盘时用 write_file；路径必须是相对路径，禁止 .. 与绝对路径。',
        '- run_command 在沙箱内执行，默认无网络；argv[0] 必须是 /bin/ 或 /usr/bin/ 下的绝对路径。',
        '- 工具调用结束后，用简短中文向对方说明结果（例如文件名），不要粘贴大段工具原始输出。',
      )
    }
    return lines.join('\n')
  }

  buildUserPrompt(agentId: AgentId, stimulus: ReplyStimulus): string {
    const agent = this.ctx.societyIdentity.require(agentId)
    const msg = stimulus.message
    if (msg) {
      if (msg.kind === 'room' && msg.roomId) {
        const roomLabel = stimulus.roomName ? `「${stimulus.roomName}」` : ''
        return [
          `你在群聊${roomLabel}中收到一条消息。`,
          `原始投递：${msg.body}`,
          `请以 ${agent.displayName} 的身份回复这条群消息。`,
        ].join('\n')
      }
      if (msg.kind === 'direct') {
        return [
          `你收到来自 ${msg.from} 的私信：`,
          msg.body,
          `请以 ${agent.displayName} 的身份回复这条私信。`,
        ].join('\n')
      }
      return [
        `系统通知：${msg.body}`,
        `请以 ${agent.displayName} 的身份作出简短回应（如无需回应可回复「好的」）。`,
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

  /**
   * Agent turn with OpenAI tool calling (bound to this agentId's workspace).
   * Max MAX_TOOL_ROUNDS tool rounds; final assistant text is the room/DM reply.
   */
  async actAsAgent(agentId: AgentId, stimulus: ReplyStimulus): Promise<string> {
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
            content: '请根据工具结果，用中文简短回复对方（不要再调用工具）。',
          })
          const final = await this.chatCompletions(messages, cfg, { tools: false })
          const text = (final.content ?? '').trim()
          if (text) return text
        }
        throw new Error(`Empty LLM content for agent ${agentId} after tool loop`)
      }
      return cleaned
    }

    throw new Error(`actAsAgent exceeded tool rounds for ${agentId}`)
  }

  private async chatCompletions(
    messages: ChatMessage[],
    cfg: LlmEndpointConfig,
    opts: { tools: boolean; toolDefs?: ToolDefinition[] },
  ): Promise<{ content: string | null; tool_calls?: OpenAiToolCall[] }> {
    const url = `${cfg.baseUrl}/chat/completions`
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }
    if (opts.tools && opts.toolDefs?.length) {
      body.tools = opts.toolDefs
      body.tool_choice = 'auto'
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    const raw = await res.text()
    let data: OpenAiChatResponse
    try {
      data = JSON.parse(raw) as OpenAiChatResponse
    } catch {
      throw new Error(`${cfg.provider} API returned non-JSON (HTTP ${res.status})`)
    }

    if (!res.ok) {
      const msg = data.error?.message || `HTTP ${res.status}`
      throw new Error(`${cfg.provider} chat/completions failed: ${msg}`)
    }

    const choice = data.choices?.[0]?.message
    // Normalize tool_calls (some providers omit type)
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
        throw new Error(
          `${cfg.provider} response missing message.content (reasoning_content ignored)`,
        )
      }
      return { content: trimmed }
    }
    return { content: content ?? null, tool_calls }
  }
}

export const name = 'society-llm'
export const inject = ['societyIdentity', 'societyMemory', 'societySoul', 'societyTools']

export function apply(ctx: Context) {
  ctx.plugin(SocietyLlmService)
}
