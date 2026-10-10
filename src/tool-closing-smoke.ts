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
  clearRest,
  isAgentResting,
  readRest,
  resolveRestUntil,
  defaultRestUntil,
} from '../plugins/society-tools/src/index.ts'
import { agentDataDir } from './paths.ts'
import fs from 'node:fs'
import path from 'node:path'
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

  assert.ok(isClosingToolName('rest'))
  assert.ok(IDLE_CLOSING_TOOL_NAMES.includes('rest'))
  assert.ok(REPLY_CLOSING_TOOL_NAMES.includes('rest'))
  assert.ok(idleNames.includes('rest'), `idle missing rest: ${idleNames.join(',')}`)
  assert.ok(replyNames.includes('rest'), `reply missing rest: ${replyNames.join(',')}`)

  // resolveRestUntil: minutes / morning / default
  const byMin = resolveRestUntil({ minutes: 30 }, Date.parse('2026-10-10T12:00:00+08:00'))
  assert.equal(byMin.mode, 'minutes')
  assert.ok(byMin.until.getTime() - Date.parse('2026-10-10T12:00:00+08:00') === 30 * 60_000)

  const byMorning = resolveRestUntil({ until: 'morning' }, Date.parse('2026-10-10T22:00:00+08:00'))
  assert.equal(byMorning.mode, 'morning')
  // next Beijing 07:00 after 22:00 is next calendar morning
  assert.ok(byMorning.until.toISOString().includes('T23:00:00.000Z') || byMorning.until.getUTCHours() === 23)

  const def = defaultRestUntil(Date.parse('2026-10-10T22:00:00+08:00'))
  assert.ok(def.getTime() > Date.parse('2026-10-10T22:00:00+08:00'))

  clearRest('bob')
  const rested = await ctx.societyTools.execute(
    'bob',
    'rest',
    JSON.stringify({ minutes: 45, reason: '晚安测试' }),
  )
  const restObj = JSON.parse(rested) as {
    ok: boolean
    acted: string
    until: string
    mode: string
    reason?: string
  }
  assert.equal(restObj.ok, true)
  assert.equal(restObj.acted, 'rest')
  assert.equal(restObj.mode, 'minutes')
  assert.equal(restObj.reason, '晚安测试')
  assert.ok(isAgentResting('bob'))
  const restFile = path.join(agentDataDir('bob'), 'rest.json')
  assert.ok(fs.existsSync(restFile), 'rest.json should persist')
  const stored = readRest('bob')
  assert.ok(stored)
  assert.equal(stored!.reason, '晚安测试')
  clearRest('bob')
  assert.equal(isAgentResting('bob'), false)
  console.log('✓ rest closing tool persists snooze; clearRest wakes')

  // Subjective soul: no auto heuristic on room post; only reflect_feelings
  const bobBefore = { ...ctx.societySoul.get('bob') }
  ctx.societyRooms.post({
    roomId: room.id,
    from: 'alice',
    body: '危险！系统崩溃了吗？谢谢你的分享，很有趣！',
  })
  const bobAfterPost = ctx.societySoul.get('bob')
  assert.equal(bobAfterPost.trust, bobBefore.trust, 'room fan-out must not change listener trust')
  assert.equal(bobAfterPost.energy, bobBefore.energy, 'room fan-out must not drain listener energy')
  assert.equal(bobAfterPost.openness, bobBefore.openness, 'room fan-out must not change listener openness')

  const reflected = await ctx.societyTools.execute(
    'bob',
    'reflect_feelings',
    JSON.stringify({
      energy: 0.2,
      trust: 0.03,
      mood: '愉快',
      reason: '和 Alice 聊得开心',
    }),
  )
  const refObj = JSON.parse(reflected) as {
    ok: boolean
    acted: string
    deltas: { energy: number; trust: number; openness: number }
    after: { energy: number; trust: number; mood: string }
  }
  assert.equal(refObj.ok, true)
  assert.equal(refObj.acted, 'reflect_feelings')
  assert.equal(refObj.deltas.energy, 0.05, 'energy delta must clamp to ±0.05')
  assert.equal(refObj.deltas.trust, 0.03)
  assert.equal(refObj.after.mood, '愉快')
  const bobSoul = ctx.societySoul.get('bob')
  assert.ok(Math.abs(bobSoul.energy - Math.min(1, bobBefore.energy + 0.05)) < 1e-9)
  assert.ok(Math.abs(bobSoul.trust - Math.min(1, bobBefore.trust + 0.03)) < 1e-9)
  console.log('✓ reflect_feelings updates only caller; clamps ±0.05; no room heuristic')

  assert.ok(idleNames.includes('reflect_feelings'), 'idle tools must include reflect_feelings')
  assert.ok(replyNames.includes('reflect_feelings'), 'reply tools must include reflect_feelings')
  assert.equal(isClosingToolName('reflect_feelings'), false)

  // Prompt strings used by llm must not advertise ACTION menus
  const sys = ctx.societyLlm.buildSystemPrompt('alice', true)
  assert.ok(!/ACTION:ROOM/.test(sys))
  assert.ok(!/ACTION:SILENT/.test(sys))
  assert.ok(/speak_in_room/.test(sys) || /收束工具/.test(sys))
  assert.ok(/\brest\b/.test(sys), 'system prompt must mention rest')
  assert.ok(/reflect_feelings/.test(sys), 'system prompt must mention reflect_feelings')
  assert.ok(/主观/.test(sys) || /reflect_feelings/.test(sys))
  assert.ok(/当前北京时间：\d{4}-\d{2}-\d{2}/.test(sys), 'system prompt must include Beijing date')
  assert.ok(/Asia\/Shanghai/.test(sys), 'system prompt must name Asia/Shanghai')
  assert.ok(/星期/.test(sys), 'system prompt must include Chinese weekday')

  await app.dispose()
  console.log('=== TOOL-CLOSING-SMOKE PASS ===')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
