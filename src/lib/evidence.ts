import { api } from '../api'
import type { DmMsg } from '../types'

export type EvidenceRun = { role: 'me' | 'user'; text: string; ts: number }

// 画像的依据是模型压缩过的原文，可能带引号、省略号，也可能是用户的语音转写。
// 先按引号原文和整句子句精确找；找不到再退到片段匹配。片段匹配最容易把 AI 回复里
// “你刚问我‘听得够吗’”这类引用误判成本人所说，所以阈值收紧，且严格匹配优先。
const GRAM = 3
const normalize = (text: string) => (text || '').replace(/[\s"'“”‘’「」『』《》…·,，.。、;；:：!！?？()（）\[\]【】\-—~]/g, '')
const grams = (text: string) => {
  const clean = normalize(text)
  if (!clean) return []
  if (clean.length <= GRAM) return [clean]
  return Array.from({ length: clean.length - GRAM + 1 }, (_, i) => clean.slice(i, i + GRAM))
}
const messageText = (m: DmMsg) => [m.text, m.transcript, m.author].filter(Boolean).join(' ')
const covers = (probes: Set<string>, text: string) => {
  const own = grams(text)
  return own.length ? new Set(own.filter(g => probes.has(g))).size / own.length : 0
}
const QUOTE = /["“「『]([^"”」』]{2,40})["”」』]/g

export function locateEvidence(messages: DmMsg[], evidence: string): EvidenceRun[] {
  if (!messages.length || !evidence.trim()) return []
  const picked: number[] = []
  const taken = new Set<number>()
  const take = (index: number) => {
    if (index < 0 || taken.has(index)) return
    taken.add(index)
    picked.push(index)
  }

  // ① 依据里的引号片段：AI 常在回复中逐字引用对方原话。
  for (const quote of [...evidence.matchAll(QUOTE)].map(m => normalize(m[1])).filter(q => q.length >= 2)) {
    take(messages.findIndex((m, i) => !taken.has(i) && normalize(messageText(m)).includes(quote)))
  }

  // ② 依据常写成“原话；原话”，按分隔符切开逐句精确匹配。
  for (const clause of evidence.split(/[;；\n]+/).map(normalize).filter(c => c.length >= 2)) {
    take(messages.findIndex((m, i) => !taken.has(i) && normalize(messageText(m)).includes(clause)))
  }

  // ③ 片段匹配：模型改写过的说法（如“周晓禾（小禾），杭州人”）。
  if (!picked.length) {
    const probes = new Set(grams(evidence))
    const scored = messages
      .map((message, index) => ({ index, score: grams(messageText(message)).filter(g => probes.has(g)).length, coverage: covers(probes, messageText(message)) }))
      .filter(hit => hit.score > 0)
    const max = Math.max(0, ...scored.map(h => h.score))
    for (const hit of scored.filter(h => h.score >= Math.max(3, Math.ceil(max * 0.6)) || h.coverage >= 0.7)) take(hit.index)
  }

  if (!picked.length) return []
  picked.sort((a, b) => a - b)
  const runs: EvidenceRun[] = []
  let last = -2
  for (const index of picked) {
    const message = messages[index]
    const role: EvidenceRun['role'] = message.direction === 'out' ? 'me' : 'user'
    const text = messageText(message)
    const run = runs.at(-1)
    if (index === last + 1 && run && run.role === role) {
      run.text += `\n${text}`
      run.ts ||= message.ts
    } else {
      runs.push({ role, text, ts: message.ts })
    }
    last = index
  }
  return runs.slice(0, 8)
}

export async function findEvidence(convId: string, evidence: string): Promise<EvidenceRun[]> {
  const result = await api.dmMsgs(convId, 400)
  return locateEvidence(result?.messages || [], evidence)
}
