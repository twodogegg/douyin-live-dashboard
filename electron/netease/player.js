import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { getSongDetails } from './song-details.js'

const run = promisify(execFile)
const ORIGIN = 'http://127.0.0.1:19263'
const APP = '/Applications/NeteaseMusic.app'

// Only the official client's local page is allowed. No model-supplied JavaScript.
async function withPage(operation, { signal } = {}) {
  signal?.throwIfAborted()
  if (process.platform !== 'darwin') throw new Error('网易云桌面点歌目前仅支持 macOS。')
  let pages
  try {
    const timeout = AbortSignal.timeout(2000)
    const response = await fetch(`${ORIGIN}/json/list`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    pages = await response.json()
  } catch {
    signal?.throwIfAborted()
    throw new Error('网易云点歌尚未连接，请点击「连接网易云」；已运行的客户端需要重新打开。')
  }
  const page = pages.find(p => p.type === 'page' && p.url === 'orpheus://orpheus/app.html')
  if (!page?.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:19263/')) throw new Error('没有找到官方网易云播放器页面。')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0
  const fail = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(signal?.reason || new Error('网易云连接已断开。')) }
    pending.clear()
  }
  const cancel = () => { fail(); ws.close() }
  signal?.addEventListener('abort', cancel, { once: true })
  ws.addEventListener('close', fail)
  ws.addEventListener('error', fail)
  ws.addEventListener('message', event => {
    const reply = JSON.parse(event.data)
    const item = pending.get(reply.id)
    if (!item) return
    pending.delete(reply.id)
    clearTimeout(item.timer)
    if (reply.error) item.reject(new Error(reply.error.message))
    else item.resolve(reply.result)
  })
  try {
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('网易云连接超时。')), 3000)
      const aborted = () => finish(signal.reason)
      signal?.addEventListener('abort', aborted, { once: true })
      ws.addEventListener('open', () => finish(), { once: true })
      ws.addEventListener('error', () => finish(new Error('无法连接网易云。')), { once: true })
      ws.addEventListener('close', () => finish(new Error('网易云连接已断开。')), { once: true })
      if (signal?.aborted) aborted()
    })
    const call = (method, params) => new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      const id = ++seq
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('网易云操作超时。')); }, 5000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '网易云页面操作失败。')
      return result.result?.value
    }
    return await operation({ call, evaluate, signal })
  } finally { signal?.removeEventListener('abort', cancel); fail(); ws.close() }
}

export function readPlayerPage() {
  const title = document.querySelector('[data-testid="tid_minibar_title"]')
  const name = title?.querySelector('.main-title .title')?.textContent?.trim() || ''
  const artist = title?.querySelector('.author')?.textContent?.trim() || ''
  const button = document.querySelector('[data-testid="tid_playbar_play_btn"] [aria-label]')
  const progress = document.querySelector('input[type="range"][aria-valuetext]')
  if (!button) throw new Error('网易云播放控件不可用，请检查客户端版本。')
  return {
    connected: true,
    playing: button.getAttribute('aria-label') === 'pause',
    current: name ? { name, artist } : null,
    position: Number(progress?.value || 0),
    duration: Number(progress?.max || 0),
  }
}

export async function desktopStatus(options) {
  return withPage(({ evaluate }) => evaluate(`(${readPlayerPage.toString()})()`), options)
}

export async function connectDesktop({ restart = false } = {}, options = {}) {
  const { signal } = options
  try { return await desktopStatus(options) } catch { signal?.throwIfAborted() }
  let running = false
  try { await run('/usr/bin/pgrep', ['-x', 'NeteaseMusic'], { signal }); running = true } catch { signal?.throwIfAborted() }
  if (running && !restart) throw new Error('网易云已在运行，连接点歌需要重新打开客户端。')
  if (running) {
    await run('/usr/bin/osascript', ['-e', 'tell application "/Applications/NeteaseMusic.app" to quit'], { timeout: 5000, signal })
    for (let i = 0; i < 30; i++) {
      try { await run('/usr/bin/pgrep', ['-x', 'NeteaseMusic'], { signal }); await delay(100, undefined, { signal }) } catch { signal?.throwIfAborted(); running = false; break }
    }
    if (running) throw new Error('网易云尚未退出，请关闭客户端后重试连接。')
  }
  await run('/usr/bin/open', ['-a', APP, '--args', '--remote-debugging-port=19263', '--remote-debugging-address=127.0.0.1', '--force-renderer-accessibility'], { signal })
  for (let i = 0; i < 40; i++) {
    try { return await desktopStatus(options) } catch { await delay(250, undefined, { signal }) }
  }
  throw new Error('网易云启动后未能连接，请检查客户端版本或端口 19263。')
}

async function searchPage(query, operation, options) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('请输入 1–200 字的歌名或歌手。')
  return withPage(async ({ call, evaluate, signal }) => {
    await evaluate(`(() => {
      const input = document.querySelector('[data-testid="tid_searchbox_input"]')
      if (!input) throw new Error('找不到网易云搜索框。')
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query.trim())})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await delay(1200, undefined, { signal })
    let ids = []
    for (let i = 0; i < 40; i++) {
      ids = await evaluate(`(() => {
        const tip = document.querySelector('[data-testid="tid_searchresults_tip"]')
        if (!tip?.textContent.includes(${JSON.stringify(query.trim())})) return []
        return [...document.querySelectorAll('[data-testid="tid_cell_pc_common_songcard"]')]
          .map(e => JSON.parse(e.dataset.log || '{}').params?.s_cid).filter(id => /^\\d+$/.test(id || ''))
      })()`)
      if (ids.length) break
      await delay(200, undefined, { signal })
    }
    if (!ids.length) throw new Error('网易云没有返回可点播的歌曲，请换一个歌名或补充歌手。')
    return operation({ ids: [...new Set(ids.map(String))], evaluate })
  }, options)
}

export async function desktopSearch(query, options) {
  return searchPage(query, async ({ ids }) => {
    const details = await getSongDetails(ids.slice(0, 10), options)
    return { songs: ids.map(id => details.songs.find(s => String(s.id) === id)).filter(Boolean) }
  }, options)
}

export async function desktopPlay({ songId, query }, options = {}) {
  const { signal } = options
  if (!/^\d{1,20}$/.test(String(songId))) throw new Error('歌曲标识无效。')
  const details = await getSongDetails([String(songId)], options)
  const song = details.songs[0]
  if (!song) throw new Error('没有找到歌曲详情。')
  return searchPage(query, async ({ ids, evaluate }) => {
    if (!ids.includes(String(songId))) throw new Error('搜索结果已变化，未播放其他歌曲，请重新点歌。')
    const before = await evaluate(`(${readPlayerPage.toString()})()`)
    if (before.playing && before.current?.name === song.name && song.artists.some(a => before.current.artist.includes(a))) return { ...before, song }
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('[data-testid="tid_trackcard_play_btn"]')]
        .find(e => String(JSON.parse(e.dataset.log || '{}').params?.s_songId) === ${JSON.stringify(String(songId))})
      if (!button) throw new Error('找不到指定歌曲的播放按钮。')
      button.click()
    })()`)
    for (let i = 0; i < 40; i++) {
      const state = await evaluate(`(${readPlayerPage.toString()})()`)
      if (state.playing && state.current?.name === song.name && song.artists.some(a => state.current.artist.includes(a))) return { ...state, song }
      await delay(250, undefined, { signal })
    }
    throw new Error('未能确认歌曲开始播放，可能需要登录、会员或歌曲暂不可用。')
  }, options)
}

export async function desktopControl(action, options) {
  if (!['play_pause', 'next', 'previous'].includes(action)) throw new Error('播放操作无效。')
  const id = { play_pause: 'tid_playbar_play_btn', next: 'tid_playbar_next_btn', previous: 'tid_playbar_prev_btn' }[action]
  return withPage(async ({ evaluate, signal }) => {
    await evaluate(`(() => { const e=document.querySelector('[data-testid="${id}"]'); if (!e) throw new Error('找不到播放控件'); e.click(); })()`)
    await delay(300, undefined, { signal })
    return evaluate(`(${readPlayerPage.toString()})()`)
  }, options)
}
