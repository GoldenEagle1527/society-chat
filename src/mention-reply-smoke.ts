/**
 * Offline smoke: @mention parse + unread scoring / stale room stimulus helpers.
 */
import assert from 'node:assert/strict'
import { mergeMentions, parseMentions, isAgentMentioned } from './mentions.ts'
import {
  mailMentionsAgent,
  mailRepliesToAgent,
  isStaleRoomStimulus,
  scoreUnreadForAgent,
} from '../plugins/society-scheduler/src/index.ts'
import type { InboxMessage } from './types.ts'

function main() {
  console.log('=== society-chat mention-reply-smoke ===')

  const agents = [
    { id: 'agnes', displayName: '阿宁' },
    { id: 'glm', displayName: '老码' },
    { id: 'xingchen_news', displayName: '时辰' },
    { id: 'xingchen_lit', displayName: '文心' },
  ]

  const p1 = parseMentions('@阿宁 你看这个', agents)
  assert.deepEqual(p1.mentions, ['agnes'])
  assert.equal(p1.everyone, false)

  const p2 = parseMentions('呼叫 @glm 和 @文心', agents)
  assert.ok(p2.mentions.includes('glm'))
  assert.ok(p2.mentions.includes('xingchen_lit'))

  const p3 = parseMentions('@everyone 集合', agents)
  assert.equal(p3.everyone, true)
  assert.deepEqual(p3.mentions, [])

  const p4 = parseMentions('@全体 听我说', agents)
  assert.equal(p4.everyone, true)

  const p5 = parseMentions('@广场 有人吗', agents)
  assert.equal(p5.everyone, true)

  const merged = mergeMentions('@老码 来一下', agents, ['agnes'], { expandEveryone: true })
  assert.ok(merged.mentions.includes('glm'))
  assert.ok(merged.mentions.includes('agnes'))

  const all = mergeMentions('@全体 集合', agents, null, { expandEveryone: true })
  assert.equal(all.everyone, true)
  assert.equal(all.mentions.length, 4)

  assert.equal(isAgentMentioned('agnes', ['agnes'], false), true)
  assert.equal(isAgentMentioned('glm', ['agnes'], true), true)
  assert.equal(isAgentMentioned('glm', ['agnes'], false), false)

  const roomMail: InboxMessage = {
    id: 'inbox-1',
    to: 'agnes',
    from: 'room',
    kind: 'room',
    roomId: 'room-1',
    body: '[plaza] 老码: @阿宁 你好',
    createdAt: new Date().toISOString(),
    read: false,
    mentions: ['agnes'],
    mentioned: true,
    sourceMessageId: 'msg-stim',
  }
  assert.equal(mailMentionsAgent(roomMail, 'agnes'), true)
  assert.equal(mailMentionsAgent(roomMail, 'glm'), false)

  const replyMail: InboxMessage = {
    id: 'inbox-2',
    to: 'agnes',
    from: 'room',
    kind: 'room',
    roomId: 'room-1',
    body: '[plaza] 文心: 接上句',
    createdAt: new Date().toISOString(),
    read: false,
    replyTo: 'msg-by-agnes',
    sourceMessageId: 'msg-2',
  }
  const find = (id: string) =>
    id === 'msg-by-agnes' ? { from: 'agnes' } : id === 'msg-other' ? { from: 'glm' } : undefined
  assert.equal(mailRepliesToAgent(replyMail, 'agnes', find), true)
  assert.equal(mailRepliesToAgent(replyMail, 'glm', find), false)

  const stale: InboxMessage = {
    id: 'inbox-3',
    to: 'agnes',
    from: 'room',
    kind: 'room',
    roomId: 'room-1',
    body: 'old',
    createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    read: false,
    sourceMessageId: 'old-msg',
  }
  assert.equal(
    isStaleRoomStimulus(stale, { messagesAfter: () => 0 }),
    true,
    'age > 4min should be stale',
  )
  assert.equal(
    isStaleRoomStimulus(
      { ...stale, createdAt: new Date().toISOString() },
      { messagesAfter: () => 9 },
    ),
    true,
    '>=8 newer should be stale',
  )
  assert.equal(
    isStaleRoomStimulus(
      { ...stale, createdAt: new Date().toISOString() },
      { messagesAfter: () => 2 },
    ),
    false,
  )

  const scoreMention = scoreUnreadForAgent(roomMail, 'agnes', find)
  const scorePlain: InboxMessage = {
    ...roomMail,
    id: 'inbox-plain',
    mentioned: false,
    mentions: undefined,
  }
  const scorePlainN = scoreUnreadForAgent(scorePlain, 'agnes', find)
  assert.ok(scoreMention > scorePlainN, 'mention should outrank plain room mail')

  console.log('mention-reply-smoke OK')
}

main()
