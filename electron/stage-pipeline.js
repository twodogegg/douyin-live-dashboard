// 主播回复的流水线：未读信箱 + 句子拆分 + 双缓冲。
//
// 目标是让「开口等待」和「句中停顿」都尽量消失：
//   1. 未读信箱：主播正在说话时照常收集弹幕，不再只留最后一条。
//   2. 句子流水线：模型输出被拆成句子，第一句一生成完就送去 TTS，
//      后面几句在播放进行中继续生成与合成。
//   3. 提前量：当前句开始播放时，下一句已经在音频缓冲里。

const SENTENCE_END = /[。！？!?…~～]/
const SOFT_BREAK = /[，,、；;：:]/

/**
 * 把一段回复切成适合逐句合成的片段。
 * 太短的句子会与相邻句合并，避免 TTS 反复起停听起来破碎。
 */
export function splitSentences(text, { min = 6, max = 60 } = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (!source) return []
  const parts = []
  let buffer = ''
  for (const char of source) {
    buffer += char
    const hard = SENTENCE_END.test(char)
    const soft = SOFT_BREAK.test(char) && buffer.length >= max
    // 没有任何标点的长句按长度硬切，避免一整段塞进一次 TTS 起播很慢。
    const forced = buffer.length >= max * 2
    if (hard || soft || forced) {
      parts.push(buffer.trim())
      buffer = ''
    }
  }
  if (buffer.trim()) parts.push(buffer.trim())
  // 合并过短的碎片，控制碎片总数，避免一句回复被切成十几个音频请求。
  const merged = []
  for (const part of parts) {
    if (!part) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && (last.length < min || part.length < min) && last.length + part.length <= max) {
      merged[merged.length - 1] = `${last}${part}`
    } else merged.push(part)
  }
  return merged.length ? merged : [source]
}

/**
 * 未读信箱：把主播说话期间收到的观众消息攒起来，按观众合并、去重、标记过期。
 * 回复时整段带进上下文，而不是只取最后一条。
 */
export function createInbox({ max = 60, expireMs = 30000 } = {}) {
  let items = []
  let seq = 0
  return {
    get size() { return items.length },
    list() { return items.map(item => ({ ...item })) },
    push({ user, text, id, now = Date.now() }) {
      const name = String(user || '').trim()
      const body = String(text || '').trim()
      if (!name || !body) return false
      // 同一观众的相同内容不重复入箱（DOM 重建会换 id 但内容不变）。
      if (items.some(item => item.user === name && item.text === body)) return false
      // 同一观众连发短句合并到上一条，避免一个人刷屏占满信箱。
      const last = items[items.length - 1]
      if (last && last.user === name && now - last.ts < 8000 && last.text.length + body.length < 120) {
        last.text = `${last.text} ${body}`
        last.ts = now
        last.merged = (last.merged || 1) + 1
        return true
      }
      items.push({ key: String(id ?? ++seq), user: name, text: body, ts: now, merged: 1 })
      if (items.length > max) items = items.slice(-max)
      return true
    },
    // 取出尚未过期的一批：太旧的弹幕不再回应，避免对着空气说话。
    drain(now = Date.now()) {
      const fresh = items.filter(item => now - item.ts <= expireMs)
      const stale = items.length - fresh.length
      items = []
      return { items: fresh, stale }
    },
    clear() { items = [] },
  }
}

/**
 * 把信箱里的一批消息整理成给模型的上下文：按观众聚合，保留时间顺序。
 */
export function formatInbox(items) {
  if (!items.length) return ''
  const groups = new Map()
  for (const item of items) {
    if (!groups.has(item.user)) groups.set(item.user, [])
    groups.get(item.user).push(item.merged > 1 ? `${item.text}（连发 ${item.merged} 条）` : item.text)
  }
  return [...groups.entries()].map(([user, texts]) => `${user}：${texts.join(' / ')}`).join('\n')
}
