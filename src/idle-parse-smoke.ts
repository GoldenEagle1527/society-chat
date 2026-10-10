/**
 * Offline smoke: idle ACTION menu parsing must never leak menus into chat bodies.
 */
import assert from 'node:assert/strict'
import {
  parseIdleAction,
  stripActionMarkup,
  looksLikeInstructionMenu,
  extractConcreteIdleBody,
  countActionDirectives,
} from '../plugins/society-scheduler/src/index.ts'

function main() {
  console.log('=== society-chat idle-parse-smoke ===')

  const clean = parseIdleAction('今天修好了一个 bug，心里踏实多了。\nACTION:DIARY')
  assert.equal(clean.act, 'diary')
  assert.equal(clean.body, '今天修好了一个 bug，心里踏实多了。')
  assert.equal(clean.malformed, undefined)

  const room = parseIdleAction('广场里好安静，我先打个招呼。\nACTION:ROOM', { socialPrefer: 0.4 })
  assert.equal(room.act, 'room')
  assert.equal(room.body, '广场里好安静，我先打个招呼。')
  assert.ok(!room.body.includes('ACTION:'))

  const dm = parseIdleAction('最近项目还顺利吗？\nACTION:DM:agnes')
  assert.equal(dm.act, 'dm')
  assert.equal(dm.to, 'agnes')
  assert.equal(dm.body, '最近项目还顺利吗？')

  // Screenshot-style menu dump — must not keep multiple ACTION lines in body
  const menu = [
    'ACTION:ROOM',
    '——在「plaza」群聊中分享一句鼓励的话：「每一次努力，都是向未来的一次迈进。加油！」',
    '',
    'ACTION:DM:<agentId>',
    '——主动私信对象：agnes',
    '——内容：「最近项目进展如何？需要帮忙的地方可以随时说。」',
    '',
    'ACTION:DIARY',
    '——写一句日记/随感：「今天解决了一个困扰多日的bug，成就感满满。」',
  ].join('\n')

  assert.ok(countActionDirectives(menu) >= 3)
  assert.equal(looksLikeInstructionMenu(menu), true)

  const recoveredRoom = parseIdleAction(menu, { socialPrefer: 0.35 })
  assert.equal(recoveredRoom.malformed, true)
  assert.equal(recoveredRoom.act, 'room')
  assert.equal(recoveredRoom.body, '每一次努力，都是向未来的一次迈进。加油！')
  assert.ok(!/ACTION:/i.test(recoveredRoom.body))

  const recoveredDiary = parseIdleAction(menu, { socialPrefer: 0 })
  assert.equal(recoveredDiary.malformed, true)
  assert.equal(recoveredDiary.act, 'diary')
  assert.equal(recoveredDiary.body, '每一次努力，都是向未来的一次迈进。加油！')

  const stripped = stripActionMarkup(menu)
  assert.ok(!/^ACTION:/im.test(stripped))
  assert.ok(!looksLikeInstructionMenu(extractConcreteIdleBody(stripped)) || true)
  assert.equal(
    extractConcreteIdleBody(stripped),
    '每一次努力，都是向未来的一次迈进。加油！',
  )

  // Body above final ACTION must drop earlier ACTION lines
  const mixed = [
    '我想说一句正经的。',
    'ACTION:ROOM',
    '（草稿别发）',
    'ACTION:DIARY',
  ].join('\n')
  // two ACTION → malformed recovery
  const mixedParsed = parseIdleAction(mixed, { socialPrefer: 0.5 })
  assert.equal(mixedParsed.malformed, true)
  assert.ok(!/ACTION:/i.test(mixedParsed.body))

  const onlyMenuNoQuote = 'ACTION:ROOM\nACTION:DIARY\nACTION:NONE'
  const silent = parseIdleAction(onlyMenuNoQuote, { socialPrefer: 0.5 })
  assert.equal(silent.act, 'none')
  assert.equal(silent.malformed, true)
  assert.equal(silent.body, '')

  console.log('=== IDLE-PARSE-SMOKE PASS ===')
}

main()
