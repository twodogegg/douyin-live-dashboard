// CDN 域名、尺寸后缀和签名会变化，素材路径里的资源 ID 保持不变。
export function mediaIdentity(url) {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    return decodeURIComponent(parsed.pathname).replace(/^\/(img|obj)\//, '/').split('~')[0]
  } catch { return '' }
}

export function normalizeNote(detail, awemeId) {
  if (String(detail?.awemeId) !== awemeId || !detail.images?.length) return null
  return { aweme_id: awemeId, aweme_type: 68, desc: detail.desc || '',
    author: { nickname: detail.authorInfo?.nickname || '' },
    images: detail.images.map(image => ({ url_list: image.urlList || image.url_list || [] })) }
}

// 部分已登录页面不再把作品详情写入 __pace_f，复用页面实际渲染的作品数据。
export function readNoteDetail(awemeId) {
  const el = document.querySelector('[data-e2e="note-detail"]')
  let fiber = el?.[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]
  for (let n = 0; fiber && n < 20; n++, fiber = fiber.return) {
    const props = fiber.memoizedProps
    const detail = props?.awemeInfo || props?.aweme?.detail
    if (String(detail?.awemeId) === awemeId && detail.images?.length) {
      return { awemeId, desc: detail.desc, authorInfo: { nickname: detail.authorInfo?.nickname },
        images: detail.images.map(image => ({ urlList: image.urlList || image.url_list || [] })) }
    }
  }
  return null
}

export function parseNoteState(entries, awemeId) {
  for (const entry of entries) {
    const text = Array.isArray(entry) ? entry[1] : ''
    if (typeof text !== 'string' || !text.includes(awemeId)) continue
    const marker = text.indexOf('"detail":')
    if (marker < 0) continue
    const start = text.indexOf('{', marker)
    let depth = 0, quoted = false, escaped = false
    for (let i = start; i >= 0 && i < text.length; i++) {
      const c = text[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') quoted = false
      } else if (c === '"') quoted = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          const detail = JSON.parse(text.slice(start, i + 1))
          const note = normalizeNote(detail, awemeId)
          if (note) return note
          break
        } catch { break }
      }
    }
  }
  return null
}
