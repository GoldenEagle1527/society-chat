/** Shared society types (Harness-compatible plugin layer). */

export type AgentId = string
export type RoomId = string
export type MessageId = string

export interface SoulState {
  openness: number
  trust: number
  energy: number
  interests: string[]
  /** Short mood label, e.g. 平静 / 好奇 / 警惕 */
  mood?: string
  /** Free-form notes the soul plugin may append */
  notes?: string
}

export type LlmProviderId = 'agnes' | 'glm' | 'siliconflow'

/** Per-agent chat provider preference (also stored as data/agents/<id>/llm.json). */
export interface AgentLlmPreference {
  provider: LlmProviderId
  /** Optional model override (still must pass free-model guards). */
  model?: string
}

export interface AgentProfile {
  id: AgentId
  displayName: string
  persona: string
  soul: SoulState
  /** Absolute path to this agent's private workspace. */
  workspacePath: string
  createdAt: string
  /** Optional seed preference; runtime may also read llm.json. */
  llm?: AgentLlmPreference
}

export interface RoomMessage {
  id: MessageId
  roomId: RoomId
  from: AgentId | 'system' | 'human'
  body: string
  createdAt: string
  /** When set, this message replies to another message in the same room. */
  replyTo?: MessageId
  /** Agent ids @mentioned in the body (plus any explicit list). */
  mentions?: AgentId[]
}

export interface Room {
  id: RoomId
  name: string
  members: AgentId[]
  createdAt: string
  createdBy: AgentId | 'system'
}

export interface InboxMessage {
  id: MessageId
  to: AgentId
  from: AgentId | 'system' | 'room' | 'human'
  kind: 'direct' | 'room' | 'system'
  /** When kind=room, the originating room id. */
  roomId?: RoomId
  body: string
  createdAt: string
  read: boolean
  /** Room message this mail replies to (copied from RoomMessage.replyTo). */
  replyTo?: MessageId
  /** Agents @mentioned on the source room/DM message. */
  mentions?: AgentId[]
  /** For kind=room: the RoomMessage.id that spawned this inbox copy. */
  sourceMessageId?: MessageId
  /** True when this recipient was specifically @mentioned (or @everyone). */
  mentioned?: boolean
}

export interface CreateRoomRequest {
  name: string
  createdBy: AgentId | 'system'
  members?: AgentId[]
}

export interface PostRoomMessageRequest {
  roomId: RoomId
  from: AgentId | 'system' | 'human'
  body: string
  replyTo?: MessageId
  /** Optional explicit mentions; merged with body @parse on post. */
  mentions?: AgentId[]
}

export interface DeliverMailRequest {
  to: AgentId
  from: AgentId | 'system' | 'room' | 'human'
  kind: InboxMessage['kind']
  roomId?: RoomId
  body: string
  replyTo?: MessageId
  mentions?: AgentId[]
  sourceMessageId?: MessageId
  mentioned?: boolean
}

/** One interaction fact for society-memory. */
export interface MemoryInteraction {
  kind: 'room' | 'direct' | 'system' | 'diary' | 'idle' | 'self'
  from: AgentId | 'system' | 'room'
  body: string
  roomId?: RoomId
  roomName?: string
  /** How this agent relates to the event. */
  role: 'speaker' | 'listener'
  at?: string
}

export interface WorkingMemoryLine {
  ts: string
  from: string
  body: string
  kind: string
  roomId?: string
}

export interface EpisodicMemory {
  ts: string
  summary: string
  salience: number
}

export interface SemanticBelief {
  subject: string
  belief: string
  confidence: number
}

export interface AgentLlmBudget {
  /** Local calendar day YYYY-MM-DD (Asia/Shanghai on the box). */
  day: string
  llmCalls: number
}

export interface AgentMemoryStore {
  working: WorkingMemoryLine[]
  episodic: EpisodicMemory[]
  semantic: SemanticBelief[]
  updatedAt: string
  /** Daily-ish LLM call counter for scheduler budget. */
  budget?: AgentLlmBudget
}

/** Synthetic speaker for the human operator in the observe/live UI. */
export const HUMAN_SPEAKER_ID = 'human' as const
export type HumanSpeakerId = typeof HUMAN_SPEAKER_ID

export function isSpecialSpeaker(id: string): boolean {
  return id === 'system' || id === HUMAN_SPEAKER_ID
}

/** UI / mailbox label for a speaker id. */
export function speakerLabel(id: string): string {
  if (id === HUMAN_SPEAKER_ID) return '你'
  if (id === 'system') return '系统'
  if (id === 'room') return '房间'
  return id
}
