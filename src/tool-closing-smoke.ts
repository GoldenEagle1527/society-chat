/**
 * Offline smoke: closing-tool catalog + write_diary chatty reject + private voice.
 * No network / API keys.
 */
import assert from 'node:assert/strict'
import {
  IDLE_CLOSING_TOOL_NAMES,
  REPLY_CLOSING_TOOL_NAMES,
  isClosingToolName,
  looksLikeOutboundChatLine,
  classifyIdlePrivateBody,
  isChattyPrivateText,
} from '../plugins/society-tools/src/index.ts'
import { bootSociety } from './boot.ts'
import { ensureSmokeAliceBob } from './smoke-fixtures.ts'
import { loadDotEnv } from './env.ts'

async function main() {
  console.log('=== society-chat tool-closing-smoke ===')

  assert.ok(isClosingToolName('speak_in_room'))
  assert.ok(isClosingToolName('write_diary'))
  assert.ok(isClosingToolName('stay_silent'))
  assert.ok(isClosingToolName('do_nothing'))
  assert.equal(isClosingToolName('web_search'), false)
  assert.ok(IDLE_CLOSING_TOOL_NAMES.includes('speak_in_room'))
  assert.ok(REPLY_CLOSING_TOOL_NAMES.includes('stay_silent'))

  assert.equal(looksLikeOutboundChatLine('今天有点紧张，但还好。'), false)
  assert.equal(looksLikeOutboundChatLine('老码在吗？想问问入职准备'), true)
  assert.equal(looksLikeOutboundChatLine('@阿宁 你看这个'), true)
  assert.equal(isChattyPrivateText('老码在吗？大家好'), true)
  assert.equal(isChattyPrivateText('心里静了一点，想记下来。'), false)

  const mixed = classifyIdlePrivateBody(
    '刚看到广场开机了，有点慌\n老码在吗？想问问大家面试怎么准备',
  )
  assert.equal(mixed.kind, 'mixed')
  assert.match(mixed.privateBody, /广场开机/)
  assert.match(mixed.chatBody, /老码在吗/)

  loadDotEnv()
  const app = await bootSociety({ loadSeeds: true })
  const { ctx } = app
  ensureSmokeAliceBob(ctx)

  const idleNames = ctx.societyTools.getIdleToolDefinitions().map((t) => t.function.name)
  for (const n of IDLE_CLOSING_TOOL_NAMES) {
    assert.ok(idleNames.includes(n), `idle missing ${n}: ${idleNames.join(',')}`)
  }
  assert.ok(idleNames.includes('web_search'))
  assert.equal(idleNames.includes('stay_silent'), false)
  assert.equal(idleNames.includes('ACTION:ROOM' as string), false)

  const replyNames = ctx.societyTools.getReplyToolDefinitions('room').map((t) => t.function.name)
  assert.ok(replyNames.includes('stay_silent'))
  assert.ok(replyNames.includes('speak_in_room'))
  assert.equal(replyNames.includes('write_diary'), false)

  const room = ctx.societyRooms.create({
    name: 'plaza',
    createdBy: 'alice',
    members: ['alice', 'bob'],
  })
  ctx.societyTools.setDefaultRoom(room.id)

  const chatty = await ctx.societyTools.execute(
    'alice',
    'write_diary',
    JSON.stringify({ text: '老码在吗？想问问大家面试怎么准备' }),
  )
  const chattyObj = JSON.parse(chatty) as { ok: boolean; error?: string }
  assert.equal(chattyObj.ok, false)
  assert.match(chattyObj.error || '', /speak_in_room|outbound|私密/)
  console.log('✓ write_diary rejects chatty voice')

  const privateOk = await ctx.societyTools.execute(
    'alice',
    'write_diary',
    JSON.stringify({ text: '今天心里静了一点，想把感觉记下来。' }),
  )
  const priv = JSON.parse(privateOk) as { ok: boolean; acted: string; path: string }
  assert.equal(priv.ok, true)
  assert.equal(priv.acted, 'diary')
  assert.match(priv.path, /^diary\/\d{4}-\d{2}-\d{2}\.md$/)
  console.log('✓ write_diary accepts private first-person')

  const spoke = await ctx.societyTools.execute(
    'alice',
    'speak_in_room',
    JSON.stringify({ body: '广场好安静|||我先打个招呼' }),
  )
  const spokeObj = JSON.parse(spoke) as {
    ok: boolean
    acted: string
    bubbles: number
    messageIds: string[]
  }
  assert.equal(spokeObj.ok, true)
  assert.equal(spokeObj.acted, 'speak_in_room')
  assert.equal(spokeObj.bubbles, 2)
  assert.equal(spokeObj.messageIds.length, 2)
  const hist = ctx.societyRooms.historyOf(room.id)
  assert.equal(hist.filter((m) => m.from === 'alice').length, 2)
  console.log('✓ speak_in_room posts ||| bubbles to plaza')

  const silent = await ctx.societyTools.execute(
    'bob',
    'stay_silent',
    JSON.stringify({ reason: 'topic moved on' }),
  )
  const silentObj = JSON.parse(silent) as { ok: boolean; acted: string }
  assert.equal(silentObj.ok, true)
  assert.equal(silentObj.acted, 'stay_silent')

  const noop = await ctx.societyTools.execute('bob', 'do_nothing', '{}')
  assert.equal(JSON.parse(noop).acted, 'do_nothing')

  // Prompt strings used by llm must not advertise ACTION menus
  const sys = ctx.societyLlm.buildSystemPrompt('alice', true)
  assert.ok(!/ACTION:ROOM/.test(sys))
  assert.ok(!/ACTION:SILENT/.test(sys))
  assert.ok(/speak_in_room/.test(sys) || /收束工具/.test(sys))

  await app.dispose()
  console.log('=== TOOL-CLOSING-SMOKE PASS ===')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
