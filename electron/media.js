// 复用 ai-tools 的作品详情与图文页面数据解析，媒体经本地代理预览。
import { BrowserWindow, session } from 'electron'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { normalizeNote, parseNoteState, readNoteDetail } from './media-data.js'
import { imageData } from './im.js'

const PARTITION = 'persist:douyin'
const cache = new Map()
const pending = new Map()
const firstUrl = urls => (urls || []).find(url => /^https:\/\//.test(url))
const mediaKey = message => message.aweme_id ? 'aweme:' + message.aweme_id : message.key

async function captureDetail(message) {
  const id = message.aweme_id
  const win = new BrowserWindow({
    show: false,
    webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const debug = win.webContents.debugger
  let timer, poll
  try {
    await win.loadURL('about:blank')
    debug.attach('1.3')
    await debug.sendCommand('Network.enable')
    return await new Promise((resolve, reject) => {
      const requests = new Set()
      let checking = false
      timer = setTimeout(() => reject(new Error('作品解析超时，请在抖音打开检查作品是否可见')), 25000)
      debug.on('message', async (_event, method, params) => {
        if (method === 'Network.responseReceived') {
          const url = new URL(params.response.url)
          if (url.pathname === '/aweme/v1/web/aweme/detail/' && url.searchParams.get('aweme_id') === id && params.response.status === 200) requests.add(params.requestId)
        }
        if (method !== 'Network.loadingFinished' || !requests.delete(params.requestId)) return
        try {
          const body = await debug.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          const payload = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body)
          if (String(payload.aweme_detail?.aweme_id) === id) resolve(payload.aweme_detail)
        } catch { /* 页面重试时继续等待 */ }
      })
      poll = setInterval(async () => {
        if (checking || win.isDestroyed()) return
        checking = true
        try {
          const state = await win.webContents.executeJavaScript(`({
            note: (${readNoteDetail.toString()})(${JSON.stringify(id)}),
            entries: location.pathname.startsWith('/note/') ? (self.__pace_f || []).filter(e => Array.isArray(e) && typeof e[1] === 'string' && e[1].includes(${JSON.stringify(id)})) : []
          })`)
          const detail = normalizeNote(state.note, id) || parseNoteState(state.entries, id)
          if (detail) resolve(detail)
        } catch { /* 导航期间暂时没有页面上下文 */ }
        finally { checking = false }
      }, 250)
      win.loadURL('https://www.douyin.com/' + (message.kind === 'note' || message.video_url?.includes('/note/') ? 'note/' : 'video/') + id).catch(() => {})
    })
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    if (!win.isDestroyed()) win.destroy()
  }
}

async function resolveMedia(message) {
  const key = mediaKey(message)
  const existing = cache.get(key)
  if (existing && existing.expires > Date.now()) return existing
  if (pending.has(key)) return pending.get(key)
  const task = (async () => {
    let kind = message.kind
    let url = message.media_url
    let images = message.images || []
    let text = message.text
    let author = message.author
    if (message.aweme_id) {
      const detail = await captureDetail(message)
      text = detail.desc || text
      author = detail.author?.nickname || author
      if (detail.images?.length) {
        kind = 'note'
        images = detail.images.map(image => firstUrl([...(image.url_list || []), ...(image.download_url_list || [])]))
      } else {
        kind = 'video'
        const video = detail.video || {}
        url = firstUrl(['play_addr_h264', 'play_addr', 'play_addr_265', 'download_addr'].flatMap(k => video[k]?.url_list || []))
      }
    }
    if (kind === 'image') images = [await imageData(message)]
    const urls = kind === 'video' ? [url] : images
    if (!urls.length || urls.some(u => !u)) throw new Error('作品没有可用的媒体地址，请在抖音打开检查原消息')
    for (const source of urls) {
      if (kind === 'image' && /^data:image\/[\w.+-]+;base64,/.test(source)) continue
      const parsed = new URL(source)
      if (parsed.protocol !== 'https:' || !/(^|\.)(douyinvod\.com|douyin\.com|douyinpic\.com|douyincdn\.com|bytecdn\.cn|byteimg\.com|ibytedtos\.com)$/.test(parsed.hostname)) {
        throw new Error('没有读取到可预览的抖音媒体源')
      }
    }
    const result = { kind, url, images, text, author, referer: message.video_url || 'https://www.douyin.com/', expires: Date.now() + 5 * 60000 }
    cache.set(key, result)
    return result
  })()
  pending.set(key, task)
  try { return await task } finally { pending.delete(key) }
}

export async function prepareMedia(message, refresh = false) {
  if (refresh) cache.delete(mediaKey(message))
  const media = await resolveMedia(message)
  const url = '/dm/media/' + encodeURIComponent(message.key)
  return { ok: true, kind: media.kind, text: media.text, author: media.author,
    ...(media.kind === 'video' ? { url } : { images: media.images.map((_, i) => `${url}?image=${i}`) }) }
}

export async function streamMedia(message, req, res, imageIndex) {
  if (!message) throw new Error('媒体消息不存在')
  let response
  for (let attempt = 0; attempt < 2; attempt++) {
    const media = await resolveMedia(message)
    const url = imageIndex === null ? media.url : media.images[imageIndex]
    if (!url) throw new Error('图片序号或媒体地址无效')
    const inline = url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s)
    if (inline) {
      const body = Buffer.from(inline[2], 'base64')
      res.writeHead(200, { 'Content-Type': inline[1], 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      return res.end(body)
    }
    response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': session.fromPartition(PARTITION).getUserAgent(), Referer: media.referer,
        ...(req.headers.range ? { Range: req.headers.range } : {}) },
    })
    if (![401, 403, 404, 410].includes(response.status) || attempt === 1) break
    await response.body?.cancel()
    cache.delete(mediaKey(message))
  }
  if (!response.ok && response.status !== 416) throw new Error(`媒体源返回 ${response.status}，请重新打开或重试`)
  const headers = { 'Cache-Control': 'no-store' }
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  res.writeHead(response.status, headers)
  if (response.body) await pipeline(Readable.fromWeb(response.body), res)
  else res.end()
}
