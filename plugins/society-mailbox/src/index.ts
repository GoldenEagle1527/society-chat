/**
 * society-mailbox — Per-agent inbox + wake/followup hook.
 * Cordis service name: `societyMailbox`
 *
 * Delivery emits `society/mail-delivered` so schedulers / agent loops can wake.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentId, DeliverMailRequest, InboxMessage, MessageId } from '../../../src/types.ts'
import { agentDataDir } from '../../../src/paths.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    societyMailbox: SocietyMailboxService
  }
  interface Events {
    'society/mail-delivered'(msg: InboxMessage): void
    'society/agent-wake'(payload: { agentId: AgentId; reason: string; message: InboxMessage }): void
  }
}

export class SocietyMailboxService extends Service {
  static inject = ['societyIdentity']

  private readonly inboxes = new Map<AgentId, InboxMessage[]>()

  constructor(ctx: Context) {
    super(ctx, 'societyMailbox')
  }

  private ensure(agentId: AgentId): InboxMessage[] {
    // Validate agent exists when identity is available
    this.ctx.societyIdentity.require(agentId)
    if (!this.inboxes.has(agentId)) {
      this.inboxes.set(agentId, [])
    }
    return this.inboxes.get(agentId)!
  }

  deliver(req: DeliverMailRequest): InboxMessage {
    const box = this.ensure(req.to)
    const msg: InboxMessage = {
      id: randomUUID() as MessageId,
      to: req.to,
      from: req.from,
      kind: req.kind,
      roomId: req.roomId,
      body: req.body,
      createdAt: new Date().toISOString(),
      read: false,
    }
    box.push(msg)
    this.persist(req.to, box)
    this.ctx.emit('society/mail-delivered', msg)
    this.ctx.emit('society/agent-wake', {
      agentId: req.to,
      reason: `mail:${msg.kind}`,
      message: msg,
    })
    return msg
  }

  list(agentId: AgentId, opts?: { unreadOnly?: boolean }): InboxMessage[] {
    const box = this.ensure(agentId)
    return opts?.unreadOnly ? box.filter((m) => !m.read) : [...box]
  }

  markRead(agentId: AgentId, messageId: MessageId): void {
    const box = this.ensure(agentId)
    const m = box.find((x) => x.id === messageId)
    if (m) {
      m.read = true
      this.persist(agentId, box)
    }
  }

  private persist(agentId: AgentId, box: InboxMessage[]): void {
    const dir = path.join(agentDataDir(agentId), 'inbox')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(box, null, 2), 'utf8')
  }
}

export const name = 'society-mailbox'
export const inject = ['societyIdentity']

export function apply(ctx: Context) {
  ctx.plugin(SocietyMailboxService)
}
