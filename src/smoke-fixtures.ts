/**
 * Register classic alice/bob pair for smokes when seed JSON is gone.
 * Never logs API keys.
 */
import type { Context } from '@deepseek-ai/cordis'

export function ensureSmokeAliceBob(ctx: Context): void {
  if (!ctx.societyIdentity.get('alice')) {
    ctx.societyIdentity.register({
      id: 'alice',
      displayName: 'Alice',
      persona: '好奇、友善的研究员，喜欢分享发现。',
      soul: {
        openness: 0.8,
        trust: 0.6,
        energy: 0.7,
        interests: ['探索', '聊天', '笔记'],
      },
      llm: { provider: 'agnes', model: 'agnes-3.0-flash' },
    })
    ctx.societySoul.load('alice')
    ctx.societyMemory.load('alice')
  }
  if (!ctx.societyIdentity.get('bob')) {
    ctx.societyIdentity.register({
      id: 'bob',
      displayName: 'Bob',
      persona: '冷静务实的工程师，注重细节和安全。',
      soul: {
        openness: 0.5,
        trust: 0.5,
        energy: 0.6,
        interests: ['系统', '隔离', '工具'],
      },
      llm: { provider: 'glm', model: 'glm-4-flash' },
    })
    ctx.societySoul.load('bob')
    ctx.societyMemory.load('bob')
  }
}
