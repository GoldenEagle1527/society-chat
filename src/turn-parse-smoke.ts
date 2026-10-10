/**
 * Offline smoke: bubble splitting helpers + retry delay (no network / keys).
 * ACTION: text protocol removed — silence is stay_silent tool, not ACTION:SILENT.
 */
import assert from 'node:assert/strict'
import { parseAgentTurn } from '../plugins/society-llm/src/index.ts'
import { LlmHttpError, llmRetryDelayMs } from './llm-http.ts'

function main() {
  console.log('=== society-chat turn-parse-smoke ===')

  const multi = parseAgentTurn('先说一句|||再说一句|||第三句')
  assert.equal(multi.silent, false)
  assert.deepEqual(multi.bubbles, ['先说一句', '再说一句', '第三句'])

  const jsonBubbles = parseAgentTurn('{"reply":true,"bubbles":["a","b"]}')
  assert.equal(jsonBubbles.silent, false)
  assert.deepEqual(jsonBubbles.bubbles, ['a', 'b'])

  const silentJson = parseAgentTurn('{"reply":false}')
  assert.equal(silentJson.silent, true)

  const plain = parseAgentTurn('就这一句')
  assert.equal(plain.silent, false)
  assert.deepEqual(plain.bubbles, ['就这一句'])

  const empty = parseAgentTurn('')
  assert.equal(empty.silent, true)

  assert.equal(llmRetryDelayMs(new LlmHttpError('agnes', 429, 'rate')), 15_000)
  assert.equal(llmRetryDelayMs(new LlmHttpError('agnes', 500, 'err')), 30_000)
  assert.equal(llmRetryDelayMs(new Error('network')), 30_000)

  console.log('=== TURN-PARSE-SMOKE PASS ===')
}

main()
