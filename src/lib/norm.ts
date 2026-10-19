// 与后端 norm_name 及抓取 EXTRACT_JS 保持一致：去名次前缀、徽章占位、尾部分数，
// 让「观众 / 麦位」卡片上的昵称能跟消息里的昵称对上。
export const norm = (s: string) =>
  (s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d+\s+/, '')
    .replace(/^[-–—]\s*/, '')
    .replace(/\s+\d+$/, '')
    .trim()

export const AV_COLORS = [
  '#5b8def', '#8b5cf6', '#e0653f', '#2fa36b',
  '#c2557a', '#4aa8c0', '#9b7a41', '#6b7a99',
]

// 没有真实头像时，用昵称首字 + 哈希配色兜底
export function hashColor(name: string): string {
  let h = 0
  for (const c of name || '') h = (h * 31 + c.codePointAt(0)!) >>> 0
  return AV_COLORS[h % AV_COLORS.length]
}
