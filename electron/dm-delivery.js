export function deliveryContent(expected, actual) {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
  if (!clean(actual)) return ''
  if (clean(expected) === clean(actual)) return 'complete'
  // 兼容旧版 DOM 注入只发送首段的情况：确认已发送部分，不能重复发送全文。
  const first = String(expected || '').split(/\r?\n/)[0]
  return /\r?\n/.test(expected) && clean(first) === clean(actual) ? 'partial' : ''
}

// 回执必须属于新创建、已得到服务端 ID 的本人消息；历史相同文本不能充当回执。
export function confirmedOutgoing(before, after, text, started) {
  if (!before.ok || !after.ok || !before.active_id || before.active_id !== after.active_id) return null
  const ids = new Set(before.messages.map(m => m.source_id).filter(Boolean))
  const clients = new Set(before.messages.map(m => m.client_id).filter(Boolean))
  const message = after.messages.find(m => m.direction === 'out' && m.server_confirmed
    && m.source_id && !ids.has(m.source_id) && (!m.client_id || !clients.has(m.client_id))
    && m.ts * 1000 >= started - 2000 && m.ts * 1000 <= started + 60000 && deliveryContent(text, m.text))
  if (!message) return null
  return deliveryContent(text, message.text) === 'partial' ? { ...message, partial: true } : message
}
