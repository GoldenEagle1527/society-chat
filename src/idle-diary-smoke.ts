/**
 * Offline smoke: DIARY/SELF bodies must not keep plaza/DM chat voice.
 */
import assert from 'node:assert/strict'
import {
  looksLikeOutboundChatLine,
  classifyIdlePrivateBody,
  resolveDiaryChatMix,
  parseIdleAction,
  stripActionMarkup,
} from '../plugins/society-scheduler/src/index.ts'

function main() {
  console.log('=== society-chat idle-diary-smoke ===')

  assert.equal(looksLikeOutboundChatLine('今天有点紧张，但还好。'), false)
  assert.equal(looksLikeOutboundChatLine('老码在吗？想问问入职准备'), true)
  assert.equal(looksLikeOutboundChatLine('@阿宁 你看这个'), true)
  assert.equal(looksLikeOutboundChatLine('大家好，有没有人知道'), true)
  assert.equal(looksLikeOutboundChatLine('想问问大家一般入职前多久开始准备面试呀'), true)
  assert.equal(looksLikeOutboundChatLine('工科生初入职场群，求问面试节奏'), true)

  const privateOnly = classifyIdlePrivateBody(
    '刚看到广场开机了，感觉像实验室的灯突然全亮了，有点新奇又有点慌',
  )
  assert.equal(privateOnly.kind, 'private')

  // Screenshot-style mixed diary (private line + plaza voice)
  const mixedBody = [
    '刚看到广场开机了，感觉像实验室的灯突然全亮了，有点新奇又有点慌',
    '老码在吗？工科生初入职场群，想问问大家一般入职前多久开始准备面试呀...',
  ].join('\n')
  const mixed = classifyIdlePrivateBody(mixedBody)
  assert.equal(mixed.kind, 'mixed')
  assert.match(mixed.privateBody, /实验室的灯/)
  assert.match(mixed.chatBody, /老码在吗/)
  assert.ok(!/老码在吗/.test(mixed.privateBody))
  assert.ok(!/实验室的灯/.test(mixed.chatBody))

  const chatty = classifyIdlePrivateBody('大家好，有没有人一起聊面试？')
  assert.equal(chatty.kind, 'chatty')

  const parsed = parseIdleAction(`${mixedBody}\nACTION:DIARY`)
  assert.equal(parsed.act, 'diary')
  const resolved = resolveDiaryChatMix(parsed, { hasRoom: true })
  assert.equal(resolved.remapped, true)
  assert.equal(resolved.act, 'room')
  assert.match(resolved.diaryBody || '', /实验室的灯/)
  assert.match(resolved.roomBody || '', /老码在吗/)
  assert.equal(resolved.body, resolved.roomBody)

  const chattyResolved = resolveDiaryChatMix(
    { act: 'diary', body: '老码在吗？想问问大家面试怎么准备' },
    { hasRoom: true },
  )
  assert.equal(chattyResolved.act, 'room')
  assert.equal(chattyResolved.diaryBody, undefined)
  assert.match(chattyResolved.body, /老码在吗/)

  const noRoom = resolveDiaryChatMix(
    { act: 'self', body: '@文心 今晚写诗吗' },
    { hasRoom: false },
  )
  assert.equal(noRoom.act, 'none')

  const keepPrivate = resolveDiaryChatMix(
    { act: 'diary', body: '今天心里静了一点，想把感觉记下来。' },
    { hasRoom: true },
  )
  assert.equal(keepPrivate.remapped, false)
  assert.equal(keepPrivate.act, 'diary')
  assert.match(keepPrivate.body, /心里静了一点/)

  // stripActionMarkup still intact on diary path
  const withMarkup = stripActionMarkup('心里一动\nACTION:DIARY')
  assert.equal(withMarkup, '心里一动')

  console.log('=== IDLE-DIARY-SMOKE PASS ===')
}

main()
