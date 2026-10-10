/**
 * society-rooms — Shared rooms: create, join, post, list members, broadcast.
 * Cordis service name: `societyRooms`
 *
 * Durable under data/society/ so observe can poll while society-run writes.
 * Posting fans out to each member's mailbox (except the sender).
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AgentId,
  CreateRoomRequest,
  MessageId,
  PostRoomMessageRequest,
  Room,
  RoomId,
  RoomMessage,
} from '../../../src/types.ts'
import { HUMAN_SPEAKER_ID, isSpecialSpeaker, speakerLabel } from '../../../src/types.ts'
import { MESSAGES_STATE_FILE, ROOMS_STATE_FILE, SOCIETY_STATE_ROOT } from '../../../src/paths.ts'
import { mergeMentions } from '../../../src/mentions.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyRooms: SocietyRoomsService
  }
  interface Events {
    'society/room-created'(room: Room): void
    'society/room-message'(msg: RoomMessage): void
    'society/room-joined'(payload: { roomId: RoomId; agentId: AgentId }): void
    /** Human/system spoke — scheduler should treat as other-party stimulus. */
    'society/external-stimulus'(payload: { from: string; roomId: RoomId }): void
  }
}

const MAX_HISTORY_PER_ROOM = 200
const MAX_MESSAGES_JSONL = 2000

interface RoomsStateFile {
  rooms: Room[]
}

export class SocietyRoomsService extends Service {
  static inject = ['societyIdentity', 'societyMailbox']

  private readonly rooms = new Map<RoomId, Room>()
  private readonly history = new Map<RoomId, RoomMessage[]>()

  constructor(ctx: Context) {
    super(ctx, 'societyRooms')
    this.loadFromDisk()
  }

  create(req: CreateRoomRequest): Room {
    const members = new Set<AgentId>(req.members ?? [])
    if (req.createdBy !== 'system') {
      this.ctx.societyIdentity.require(req.createdBy)
      members.add(req.createdBy)
    }
    for (const m of members) this.ctx.societyIdentity.require(m)

    const room: Room = {
      id: randomUUID(),
      name: req.name,
      members: [...members],
      createdAt: new Date().toISOString(),
      createdBy: req.createdBy,
    }
    this.rooms.set(room.id, room)
    this.history.set(room.id, [])
    this.persistRooms()
    this.ctx.emit('society/room-created', room)
    return room
  }

  join(roomId: RoomId, agentId: AgentId): Room {
    const room = this.require(roomId)
    this.ctx.societyIdentity.require(agentId)
    if (!room.members.includes(agentId)) {
      room.members.push(agentId)
      this.persistRooms()
      this.ctx.emit('society/room-joined', { roomId, agentId })
    }
    return room
  }

  leave(roomId: RoomId, agentId: AgentId): Room {
    const room = this.require(roomId)
    room.members = room.members.filter((m) => m !== agentId)
    this.persistRooms()
    return room
  }

  listMembers(roomId: RoomId): AgentId[] {
    return [...this.require(roomId).members]
  }

  get(roomId: RoomId): Room | undefined {
    return this.rooms.get(roomId)
  }

  listRooms(): Room[] {
    return [...this.rooms.values()]
  }

  require(roomId: RoomId): Room {
    const r = this.rooms.get(roomId)
    if (!r) throw new Error(`Unknown room: ${roomId}`)
    return r
  }

  historyOf(roomId: RoomId): RoomMessage[] {
    this.require(roomId)
    return [...(this.history.get(roomId) ?? [])]
  }

  /** Look up a message by id within a room (or any room if roomId omitted). */
  findMessage(messageId: MessageId, roomId?: RoomId): RoomMessage | undefined {
    if (roomId) {
      return (this.history.get(roomId) ?? []).find((m) => m.id === messageId)
    }
    for (const msgs of this.history.values()) {
      const hit = msgs.find((m) => m.id === messageId)
      if (hit) return hit
    }
    return undefined
  }

  /** How many messages in this room were posted after `messageId` (0 if unknown). */
  messagesAfter(roomId: RoomId, messageId: MessageId): number {
    const hist = this.history.get(roomId) ?? []
    const idx = hist.findIndex((m) => m.id === messageId)
    if (idx < 0) return 0
    return hist.length - 1 - idx
  }

  /** All recent messages across rooms (newest last), for observers. */
  recentMessages(limit = 50): RoomMessage[] {
    const all: RoomMessage[] = []
    for (const msgs of this.history.values()) all.push(...msgs)
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return all.slice(-limit)
  }

  /**
   * Post to a room and deliver a copy to every other member's mailbox.
   * Parses @mentions from body (merged with explicit req.mentions).
   * Fan-out still goes to all members for plaza continuity; mentioned recipients
   * get mentioned=true so the scheduler can prioritize them.
   */
  post(req: PostRoomMessageRequest): RoomMessage {
    const room = this.require(req.roomId)
    // system / human may post without being room members
    if (!isSpecialSpeaker(req.from) && !room.members.includes(req.from)) {
      throw new Error(`Agent ${req.from} is not a member of room ${req.roomId}`)
    }
    const body = String(req.body || '').trim()
    if (!body) throw new Error('message body is empty')
    if (body.length > 4000) throw new Error('message body too long (max 4000)')

    let replyTo = req.replyTo ? String(req.replyTo).trim() : undefined
    if (replyTo) {
      const target = this.findMessage(replyTo, req.roomId)
      if (!target) {
        throw new Error(`replyTo message ${replyTo} not found in room ${req.roomId}`)
      }
    } else {
      replyTo = undefined
    }

    const agents = this.ctx.societyIdentity.list()
    const merged = mergeMentions(body, agents, req.mentions, { expandEveryone: true })
    // Keep only room members (+ broadcast already expanded to all agents; intersect members)
    const memberSet = new Set(room.members)
    const mentions = merged.mentions.filter((id) => memberSet.has(id))
    const everyone = merged.everyone

    const msg: RoomMessage = {
      id: randomUUID(),
      roomId: req.roomId,
      from: req.from,
      body,
      createdAt: new Date().toISOString(),
      ...(replyTo ? { replyTo } : {}),
      ...(mentions.length ? { mentions } : {}),
    }
    const hist = this.history.get(req.roomId)!
    hist.push(msg)
    if (hist.length > MAX_HISTORY_PER_ROOM) {
      hist.splice(0, hist.length - MAX_HISTORY_PER_ROOM)
    }
    this.appendMessage(msg)
    this.ctx.emit('society/room-message', msg)

    if (isSpecialSpeaker(req.from)) {
      this.ctx.emit('society/external-stimulus', { from: req.from, roomId: room.id })
    }

    const fromLabel =
      req.from === HUMAN_SPEAKER_ID
        ? this.ctx.societyIdentity.displayNameOf(HUMAN_SPEAKER_ID)
        : req.from === 'system'
          ? speakerLabel('system')
          : this.ctx.societyIdentity.get(req.from)?.displayName || req.from

    for (const member of room.members) {
      if (member === req.from) continue
      const mentioned = everyone || mentions.includes(member)
      this.ctx.societyMailbox.deliver({
        to: member,
        from: 'room',
        kind: 'room',
        roomId: room.id,
        body: `[${room.name}] ${fromLabel}: ${body}`,
        replyTo: msg.replyTo,
        mentions: mentions.length ? mentions : undefined,
        sourceMessageId: msg.id,
        mentioned,
      })
    }
    return msg
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(ROOMS_STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(ROOMS_STATE_FILE, 'utf8')) as RoomsStateFile
        for (const room of raw.rooms ?? []) {
          if (!room?.id || !room.name) continue
          this.rooms.set(room.id, {
            id: room.id,
            name: room.name,
            members: Array.isArray(room.members) ? room.members.map(String) : [],
            createdAt: room.createdAt || new Date().toISOString(),
            createdBy: room.createdBy || 'system',
          })
          this.history.set(room.id, [])
        }
      }
      if (fs.existsSync(MESSAGES_STATE_FILE)) {
        const lines = fs.readFileSync(MESSAGES_STATE_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
        const recent = lines.slice(-MAX_MESSAGES_JSONL)
        for (const line of recent) {
          try {
            const rawMsg = JSON.parse(line) as RoomMessage
            if (!rawMsg?.id || !rawMsg.roomId) continue
            const msg: RoomMessage = {
              id: String(rawMsg.id),
              roomId: String(rawMsg.roomId),
              from: rawMsg.from,
              body: String(rawMsg.body || ''),
              createdAt: String(rawMsg.createdAt || ''),
            }
            if (rawMsg.replyTo) msg.replyTo = String(rawMsg.replyTo)
            if (Array.isArray(rawMsg.mentions) && rawMsg.mentions.length) {
              msg.mentions = rawMsg.mentions.map(String)
            }
            if (!this.history.has(msg.roomId)) this.history.set(msg.roomId, [])
            this.history.get(msg.roomId)!.push(msg)
          } catch {
            /* skip bad line */
          }
        }
        for (const [roomId, msgs] of this.history) {
          msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          if (msgs.length > MAX_HISTORY_PER_ROOM) {
            this.history.set(roomId, msgs.slice(-MAX_HISTORY_PER_ROOM))
          }
        }
      }
    } catch (err) {
      this.ctx.logger('society-rooms').warn(
        `loadFromDisk failed: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  private persistRooms(): void {
    fs.mkdirSync(SOCIETY_STATE_ROOT, { recursive: true })
    const payload: RoomsStateFile = { rooms: this.listRooms() }
    const tmp = `${ROOMS_STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, ROOMS_STATE_FILE)
  }

  private appendMessage(msg: RoomMessage): void {
    fs.mkdirSync(SOCIETY_STATE_ROOT, { recursive: true })
    fs.appendFileSync(MESSAGES_STATE_FILE, JSON.stringify(msg) + '\n', 'utf8')
  }
}

export const name = 'society-rooms'
export const inject = ['societyIdentity', 'societyMailbox']

export function apply(ctx: Context) {
  ctx.plugin(SocietyRoomsService)
}
