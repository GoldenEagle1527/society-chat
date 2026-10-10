/**
 * Detect outbound chat voice that must not land in private diary/thoughts.
 */

const CAST_NAME_RE = /老码|阿宁|时辰|文心|agnes|glm|xingchen[_a-z0-9]*/i

/**
 * True if a single line looks like outbound plaza/DM speech
 * (addressing others, @mentions, group questions) rather than private notes.
 */
export function looksLikeOutboundChatLine(line: string): boolean {
  const t = String(line || '').trim()
  if (!t) return false
  if (/@[\w\u4e00-\u9fff]+/.test(t)) return true
  if (/(在吗|大家好|有没有人|想问问大家|群里|有人吗|谁在|请问大家|各位好)/.test(t)) return true
  if (/想问问|大家一般|有没有人会|求问|初入职场群/.test(t)) return true
  if (CAST_NAME_RE.test(t) && /(在吗|你好|请问|帮忙|一起|怎么看|觉得呢|对吗|来一下|看一下)/.test(t)) {
    return true
  }
  if (CAST_NAME_RE.test(t) && /[，,]\s*.*[？?]/.test(t) && /(你|您)/.test(t)) return true
  return false
}

export type PrivateBodyClass = {
  kind: 'private' | 'chatty' | 'mixed'
  privateBody: string
  chatBody: string
}

/** Split diary/self body into private reflection vs outbound chat voice. */
export function classifyIdlePrivateBody(body: string): PrivateBodyClass {
  const raw = String(body || '').trim()
  if (!raw) return { kind: 'private', privateBody: '', chatBody: '' }

  const chunks = raw
    .split(/\r?\n|\|\|\|/g)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!chunks.length) return { kind: 'private', privateBody: '', chatBody: '' }

  const privateParts: string[] = []
  const chatParts: string[] = []
  for (const c of chunks) {
    if (looksLikeOutboundChatLine(c)) chatParts.push(c)
    else privateParts.push(c)
  }

  if (!chatParts.length && chunks.length === 1 && looksLikeOutboundChatLine(raw)) {
    return { kind: 'chatty', privateBody: '', chatBody: raw }
  }
  if (!chatParts.length && /[。！？\n]/.test(raw) && /(在吗|想问问大家|大家好|有没有人|@)/.test(raw)) {
    const parts = raw.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 2) {
      privateParts.length = 0
      for (const p of parts) {
        if (looksLikeOutboundChatLine(p)) chatParts.push(p)
        else privateParts.push(p)
      }
    }
  }

  const privateBody = privateParts.join('\n').trim()
  const chatBody = chatParts.join('\n').trim()
  if (chatBody && privateBody) return { kind: 'mixed', privateBody, chatBody }
  if (chatBody) return { kind: 'chatty', privateBody: '', chatBody }
  return { kind: 'private', privateBody: privateBody || raw, chatBody: '' }
}

/** True if any chunk looks like outbound chat (reject whole diary write). */
export function isChattyPrivateText(text: string): boolean {
  const c = classifyIdlePrivateBody(text)
  return c.kind === 'chatty' || c.kind === 'mixed'
}
