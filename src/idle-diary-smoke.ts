/**
 * Offline smoke: private-voice heuristics for diary (tool-side).
 */
import assert from 'node:assert/strict'
import {
  looksLikeOutboundChatLine,
  classifyIdlePrivateBody,
  isChattyPrivateText,
} from '../plugins/society-tools/src/index.ts'

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
  assert.equal(isChattyPrivateText(mixedBody), true)
  assert.equal(isChattyPrivateText('今天心里静了一点'), false)

  console.log('=== IDLE-DIARY-SMOKE PASS ===')
}

main()
