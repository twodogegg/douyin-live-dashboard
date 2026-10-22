// 直播抓取、登录、房间校验、AI 分析与实时广播。
// 内置 Chromium 同时承担登录窗口与抓取页，登录态由持久分区自动保存。
import { BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import * as db from './db.js'
import * as agentStore from './agent.js'
import { EXTRACT_JS, OPEN_LOGIN_JS, FETCH_ROOM_JS, HARVEST_JS, CLOSE_PANEL_JS } from './extract.js'

const LIVE_HOME = 'https://live.douyin.com/'
const PARTITION = 'persist:douyin'
const VOICE_ROOM_MODE = 3 // 抖音 room.live_room_mode：3 = 语音直播间

export const STATE = {
  status: '待机',
  room: '',
  room_id: '',
  logged_in: false,
  r1_count: 0,
  r2_count: 0,
  ai_count: 0,
  last_ai: '',
}

const AI_CONF = {
  base_url: 'https://api.darl.cn/v1',
  model: 'gpt-4o-mini',
  key: '',
  window: 20,
}

let AGENT_CONF = null
let agentFile = ''
let configFile = ''
let SETTLE = 12000

let liveWin = null
let liveSes = null
let shuttingDown = false
let scraperTask = null
let RUNNING = false
let broadcaster = () => {}

const BUF = new Map() // (region,id) -> row
const SEEN = new Map() // (region,id) -> text
const R1_LINES = new Map() // 行号 -> {bid, ts, text}
const AVATARS = new Map() // 昵称 -> URL
let PREV_SUMMARY = ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toTimeString().slice(0, 8)

export async function init({ agentPath, defaultAgentPath, settle, aiConfigPath }) {
  agentFile = agentPath
  configFile = aiConfigPath || ''
  AGENT_CONF = agentStore.load(agentPath, defaultAgentPath)
  loadAiConfig()
  if (settle) SETTLE = settle
  liveSes = session.fromPartition(PARTITION)
  // 抖音是国内服务：固定直连，避免系统代理节点切换导致登录 IP 变化、被判定为新设备
  await liveSes.setProxy({ mode: 'direct' })
  watchCookies()
}

// 登录窗口里扫码成功后，cookie 一落盘就自动同步登录态，不需要用户手动点确认。
let cookieTimer = null
function watchCookies() {
  ensureLiveSession().cookies.on('changed', () => {
    clearTimeout(cookieTimer)
    cookieTimer = setTimeout(async () => {
      const ok = await loginStatus()
      if (ok) {
        if (STATE.status === '等待登录') STATE.status = '待机'
        sendStat()
      }
    }, 800)
  })
}

export function setBroadcaster(fn) {
  broadcaster = fn
}

export function broadcast(msg) {
  try {
    broadcaster(msg)
  } catch {
    /* 广播失败不影响抓取 */
  }
}

export function statMsg() {
  return {
    type: 'stat',
    status: STATE.status,
    room: STATE.room,
    room_id: STATE.room_id,
    r1_count: STATE.r1_count,
    r2_count: STATE.r2_count,
    ai_count: STATE.ai_count,
    last_ai: STATE.last_ai,
    logged_in: STATE.logged_in,
    model: AI_CONF.model,
    window: AI_CONF.window,
    has_key: !!AI_CONF.key,
  }
}

function sendStat() {
  broadcast(statMsg())
}

// ---------- 配置 ----------
// 模型配置也落盘：生产包每次启动端口不同，localStorage 会随 origin 丢失
function loadAiConfig() {
  if (!configFile) return
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
    if (c.base_url) AI_CONF.base_url = c.base_url
    if (c.model) AI_CONF.model = c.model
    if (typeof c.key === 'string') AI_CONF.key = c.key
    if (c.window) AI_CONF.window = Number(c.window) || AI_CONF.window
  } catch {
    /* 还没写过配置 */
  }
}

function saveAiConfig() {
  if (!configFile) return
  try {
    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          base_url: AI_CONF.base_url,
          model: AI_CONF.model,
          key: AI_CONF.key,
          window: AI_CONF.window,
        },
        null,
        2,
      ),
    )
  } catch {
    /* 写盘失败不影响本次运行 */
  }
}

export function getConfig() {
  return { base_url: AI_CONF.base_url, model: AI_CONF.model, window: AI_CONF.window, has_key: !!AI_CONF.key }
}

export function setConfig(c) {
  if (c.base_url) AI_CONF.base_url = c.base_url
  if (c.model) AI_CONF.model = c.model
  if (typeof c.key === 'string') AI_CONF.key = c.key
  if (c.window && Number(c.window) >= 5 && Number(c.window) <= 300) AI_CONF.window = Number(c.window)
  saveAiConfig()
  sendStat()
  return { ok: true, ...getConfig() }
}

export function getAgentConfig() {
  return AGENT_CONF
}

export function setAgentConfig(conf) {
  const err = agentStore.validate(conf)
  if (err) return { ok: false, msg: err }
  agentStore.save(agentFile, conf)
  AGENT_CONF = conf
  sendStat()
  return { ok: true, config: AGENT_CONF }
}

// ---------- 浏览器窗口 ----------
export function ensureLiveWindow(show = false) {
  if (liveWin && !liveWin.isDestroyed()) return liveWin
  liveWin = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    title: '抖音直播',
    webPreferences: {
      partition: PARTITION,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  liveWin.on('close', (e) => {
    if (!shuttingDown) {
      e.preventDefault()
      liveWin.hide()
    }
  })
  liveWin.on('closed', () => {
    liveWin = null
  })
  if (show) liveWin.showInactive()
  // 新建窗口必须先加载抖音首页，否则显示出来就是白屏
  liveWin.loadURL(LIVE_HOME).catch(() => {})
  return liveWin
}

function ensureLiveSession() {
  if (!liveSes || liveSes.isDestroyed?.()) liveSes = session.fromPartition(PARTITION)
  return liveSes
}

async function load(win, url) {
  try {
    await win.loadURL(url)
  } catch {
    /* 页面里的子资源失败会 reject，但 DOM 通常已可用 */
  }
}

async function ensureHome(win) {
  const url = win.webContents.getURL()
  if (!url.startsWith('https://live.douyin.com')) await load(win, LIVE_HOME)
  return win
}

async function evalJs(win, code, ...args) {
  return win.webContents.executeJavaScript(
    `(${code})(${args.map((a) => JSON.stringify(a)).join(',')})`,
    true,
  )
}

function hasSession(cookies) {
  const now = Date.now() / 1000
  return cookies.some((c) => c.name === 'sessionid' && (!c.expirationDate || c.expirationDate > now))
}

export async function loginStatus() {
  const cookies = await ensureLiveSession().cookies.get({})
  STATE.logged_in = hasSession(cookies)
  return STATE.logged_in
}

export async function loginStart() {
  const win = ensureLiveWindow()
  await ensureHome(win)
  win.show()
  win.focus()
  STATE.status = '等待登录'
  sendStat()
  let opened = false
  try {
    opened = await evalJs(win, OPEN_LOGIN_JS)
  } catch {
    /* 登录按钮可能还没渲染 */
  }
  return { ok: true, opened }
}

export async function loginComplete() {
  if (!liveWin || liveWin.isDestroyed()) {
    return { ok: false, logged_in: false, msg: '还没有打开登录窗口，请先点「去登录」' }
  }
  // 扫码后 cookie 落盘有短暂延迟，多等几秒再判定
  for (let i = 0; i < 5; i++) {
    if (await loginStatus()) {
      STATE.status = '待机'
      sendStat()
      return { ok: true, logged_in: true }
    }
    await sleep(700)
  }
  return { ok: false, logged_in: false, msg: '还没检测到登录，请在抖音窗口里完成扫码后再点' }
}

export async function showLiveWindow() {
  const win = ensureLiveWindow()
  await ensureHome(win)
  win.show()
  win.focus()
  return { ok: true, visible: true }
}

// 登录态由持久分区自动保存；这里显式刷盘，避免刚登录就退出应用时丢失。
export async function saveLoginState() {
  if (!(await loginStatus())) return { ok: false, logged_in: false, msg: '当前未登录，无法保存' }
  await ensureLiveSession().cookies.flushStore()
  STATE.status = '待机'
  sendStat()
  return { ok: true, logged_in: true }
}

export async function clearLoginState() {
  if (scraperTask) await disconnect()
  await ensureLiveSession().clearStorageData()
  STATE.logged_in = false
  STATE.status = '待机'
  sendStat()
  const win = ensureLiveWindow()
  await load(win, LIVE_HOME)
  return { ok: true, logged_in: false }
}

export function hideLiveWindow() {
  if (liveWin && !liveWin.isDestroyed()) liveWin.hide()
  return { ok: true, visible: false }
}

// ---------- 抓取 ----------
function resetBuffers() {
  BUF.clear()
  SEEN.clear()
  R1_LINES.clear()
  AVATARS.clear()
  PREV_SUMMARY = ''
  STATE.r1_count = 0
  STATE.r2_count = 0
  STATE.ai_count = 0
  STATE.last_ai = ''
}

function normName(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d+\s+/, '')
    .replace(/^[-–—]\s*/, '')
    .replace(/\s+\d+$/, '')
    .trim()
}

function trackR1Line(m, now) {
  const key = m.id
  const line = R1_LINES.get(key)
  if (line) {
    line.ts = now
    if (line.text === m.text) return [null, null]
    line.text = m.text
    return [line.bid, m.text]
  }
  const bid = `${m.user}\u0000${key}`
  R1_LINES.set(key, { bid, ts: now, text: m.text })
  STATE.r1_count += 1
  return [bid, m.text]
}

export async function connect(roomId) {
  const rid = String(roomId || '').trim()
  if (!/^\d{4,20}$/.test(rid)) return { ok: false, msg: '房号必须是纯数字' }
  if (scraperTask) return { ok: false, msg: '已连接，请先断开再换房号' }
  if (!(await loginStatus())) {
    STATE.logged_in = false
    sendStat()
    return { ok: false, msg: '未登录，请先完成登录' }
  }

  const win = ensureLiveWindow()
  await ensureHome(win)
  const info = await evalJs(win, FETCH_ROOM_JS, rid).catch(() => null)
  if (!info || !info.ok) return { ok: false, msg: '房间不存在或查询失败，请检查房号' }
  if (info.status !== 2) return { ok: false, msg: '该房间当前未开播' }
  if (info.mode !== VOICE_ROOM_MODE) return { ok: false, msg: '只支持语音直播间，该房间不是语音直播' }

  resetBuffers()
  STATE.status = '连接中'
  STATE.room = info.title || ''
  STATE.room_id = rid
  broadcast({ type: 'reset' })
  sendStat()
  win.showInactive()
  scraperTask = scraperTaskRun(rid).finally(() => {
    scraperTask = null
  })
  return { ok: true, room_id: rid, room: STATE.room }
}

export async function disconnect() {
  if (!scraperTask) {
    STATE.status = '待机'
    STATE.room = ''
    STATE.room_id = ''
    sendStat()
    return { ok: true }
  }
  RUNNING = false
  try {
    await scraperTask
  } catch {
    /* 忽略抓取任务退出异常 */
  }
  scraperTask = null
  STATE.status = '待机'
  STATE.room = ''
  STATE.room_id = ''
  sendStat()
  return { ok: true }
}

async function scraperTaskRun(rid) {
  RUNNING = true
  let win = null
  try {
    win = ensureLiveWindow()
    await load(win, LIVE_HOME + rid)
    await sleep(SETTLE)
    STATE.room = win.webContents.getTitle() || STATE.room
    STATE.status = '已进房'
    sendStat()

    let harvestUntil = 0
    try {
      if (await evalJs(win, HARVEST_JS)) harvestUntil = Date.now() + 4000
    } catch {
      /* 补采失败不影响抓取 */
    }

    let lastFlush = Date.now()
    let lastPrune = Date.now()
    let lastAvPush = 0
    let avDirty = false
    const sessionNo = String(Math.floor(Date.now() / 1000))

    while (RUNNING) {
      const now = Date.now()
      let data
      try {
        data = await evalJs(win, EXTRACT_JS)
      } catch (e) {
        STATE.status = `页面异常: ${e.message}`
        sendStat()
        await sleep(3000)
        continue
      }
      if (!data) {
        await sleep(500)
        continue
      }

      for (const [name, url] of Object.entries(data.avatars || {})) {
        if (AVATARS.get(name) !== url) {
          AVATARS.set(name, url)
          avDirty = true
        }
      }

      for (const region of ['r1', 'r2']) {
        for (const m of data[region] || []) {
          const key = `${region}:${m.id}`
          if (SEEN.get(key) === m.text) continue
          const isNew = !SEEN.has(key)
          SEEN.set(key, m.text)
          const dbKey = `${sessionNo}:${region}:${m.id}`
          const ts = now / 1000
          BUF.set(key, { ts, region, user: m.user, text: m.text, db_key: dbKey })
          const avatar = AVATARS.get(normName(m.user)) || null
          db.upsertMsg(dbKey, ts, region, m.user, m.text, avatar)
          if (region === 'r1') {
            const [bid, text] = trackR1Line(m, ts)
            if (bid === null) continue
            broadcast({ type: 'r1', id: bid, user: m.user, text, time: stamp(), avatar })
          } else if (isNew) {
            STATE.r2_count += 1
            broadcast({ type: 'r2', id: m.id, user: m.user, text: m.text, time: stamp(), avatar })
          }
        }
      }

      if (harvestUntil && now > harvestUntil) {
        try {
          await evalJs(win, CLOSE_PANEL_JS)
        } catch {
          /* 面板可能已关 */
        }
        harvestUntil = 0
      }
      if (avDirty && now - lastAvPush > 5000) {
        broadcast({ type: 'avatars', map: Object.fromEntries(AVATARS) })
        avDirty = false
        lastAvPush = now
      }
      if (now - lastPrune > 10000) {
        for (const [k, l] of R1_LINES) if (now / 1000 - l.ts > 60) R1_LINES.delete(k)
        sendStat()
        lastPrune = now
      }
      lastFlush = await maybeAnalyze(lastFlush)
      await sleep(500)
    }
  } catch (e) {
    STATE.status = `异常: ${e.message}`
    sendStat()
  } finally {
    RUNNING = false
  }
}

// ---------- 分析 ----------
function collapseR1(rows, gap) {
  const byUser = new Map()
  for (const r of rows) {
    if (!byUser.has(r.user)) byUser.set(r.user, [])
    byUser.get(r.user).push(r)
  }
  const out = []
  for (const rs of byUser.values()) {
    let cur = []
    for (const r of rs.sort((a, b) => a.ts - b.ts)) {
      if (cur.length && r.ts - cur[cur.length - 1].ts > gap) {
        out.push(cur.reduce((a, b) => (a.text.length > b.text.length ? a : b)))
        cur = []
      }
      cur.push(r)
    }
    if (cur.length) out.push(cur.reduce((a, b) => (a.text.length > b.text.length ? a : b)))
  }
  return out
}

function collapseR2(rows, maxChars = 16, minCount = 2) {
  const groups = new Map()
  const out = []
  for (const r of rows) {
    const t = (r.text || '').replace(/\s+/g, '')
    if (t && t.length <= maxChars) {
      if (!groups.has(t)) groups.set(t, [])
      groups.get(t).push(r)
    } else {
      out.push(r)
    }
  }
  for (const rs of groups.values()) {
    if (rs.length < minCount) {
      out.push(...rs)
      continue
    }
    const last = rs.reduce((a, b) => (a.ts > b.ts ? a : b))
    out.push({ ...last, text: `${last.text.trim()}（×${rs.length}）` })
  }
  return out
}

function isNoChange(summary, marker) {
  const first = (summary.trim().split(/\r?\n/)[0] || '').trim().replace(/^[-•* ]+/, '').toUpperCase()
  return first === marker.trim().toUpperCase()
}

function stripChangeMarker(summary) {
  const lines = summary.trim().split(/\r?\n/)
  if (lines.length && (lines[0] || '').trim().replace(/^[-•* ]+/, '').toUpperCase() === 'CHANGE')
    return lines.slice(1).join('\n').trim()
  return summary.trim()
}

async function postChat(messages, override = {}) {
  const res = await fetch(`${AI_CONF.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_CONF.key}` },
    body: JSON.stringify({
      model: AI_CONF.model,
      temperature: override.temperature ?? AGENT_CONF.temperature,
      max_tokens: override.max_tokens ?? AGENT_CONF.max_tokens,
      messages,
    }),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    const err = new Error(body)
    err.httpStatus = res.status
    throw err
  }
  return res.json()
}

async function callLlm(transcript, prevSummary) {
  const maxChars = Number(AGENT_CONF.max_chars)
  if (transcript.length > maxChars) transcript = '（较早内容已截断）\n' + transcript.slice(-maxChars)
  let user = `本时段直播间文本：\n${transcript}`
  if (AGENT_CONF.keep_prev_summary && prevSummary)
    user = `上一时段摘要（供衔接参考）：\n${prevSummary}\n\n${user}`

  const messages = [
    { role: 'system', content: AGENT_CONF.system_prompt },
    { role: 'user', content: user },
  ]
  let text = ''
  // 模型输出被 max_tokens 截断时自动续写，避免摘要停在半句
  for (let i = 0; i < 3; i++) {
    const data = await postChat(messages)
    const choice = data.choices && data.choices[0]
    const part = (choice && choice.message && choice.message.content) || ''
    text += part
    if (!choice || choice.finish_reason !== 'length') break
    messages.push({ role: 'assistant', content: part })
    messages.push({ role: 'user', content: '继续输出被截断的剩余内容，只输出剩余部分，不要重复已经输出的内容。' })
  }
  return text.trim()
}

async function maybeAnalyze(lastFlush) {
  const now = Date.now()
  if (now - lastFlush < AI_CONF.window * 1000) return lastFlush
  if (!AI_CONF.key || BUF.size < Number(AGENT_CONF.min_messages))
    return AI_CONF.key ? now : lastFlush

  const rows = [...BUF.values()]
  const r1Rows = collapseR1(rows.filter((r) => r.region === 'r1'), Number(AGENT_CONF.r1_gap))
  let r2Rows = rows.filter((r) => r.region !== 'r1')
  if (AGENT_CONF.merge_repeats)
    r2Rows = collapseR2(r2Rows, Number(AGENT_CONF.repeat_max_chars), Number(AGENT_CONF.repeat_min_count))
  const all = r1Rows.concat(r2Rows)
  const keys = rows.map((r) => r.db_key).filter(Boolean)
  const n = rows.length
  BUF.clear()

  const lines = all
    .sort((a, b) => a.ts - b.ts)
    .map((r) => `[${AGENT_CONF.region_labels[r.region] || r.region}] ${r.user ? `${r.user}：` : ''}${r.text}`)
  const transcript = lines.join('\n')

  const time = stamp()
  const wid = db.openWindow(now / 1000, time, n, AI_CONF.model, keys)
  broadcast({ type: 'ai_pending', time, count: n })
  let ok = true
  let summary
  try {
    summary = await callLlm(transcript, PREV_SUMMARY)
  } catch (e) {
    summary = e.httpStatus ? `模型请求失败 HTTP ${e.httpStatus}: ${e.message}` : `模型请求失败: ${e.message}`
    ok = false
  }
  if (ok) summary = stripChangeMarker(summary) || AGENT_CONF.no_change_marker
  const noChange = ok && isNoChange(summary, AGENT_CONF.no_change_marker)
  db.closeWindow(wid, summary)

  if (noChange && AGENT_CONF.suppress_no_change) {
    broadcast({ type: 'ai_drop', time })
    return Date.now()
  }

  if (ok) PREV_SUMMARY = summary
  STATE.ai_count += 1
  STATE.last_ai = time
  broadcast({ type: 'ai', time, count: n, summary, model: AI_CONF.model })
  sendStat()
  return Date.now()
}

// 供私信模块复用同一套模型配置
export function aiConfig() {
  return { base_url: AI_CONF.base_url, model: AI_CONF.model, has_key: !!AI_CONF.key }
}

export async function chatComplete(messages, override = {}) {
  const data = await postChat(messages, override)
  const choice = data.choices && data.choices[0]
  return ((choice && choice.message && choice.message.content) || '').trim()
}

export function shutdown() {
  shuttingDown = true
  RUNNING = false
  if (liveWin && !liveWin.isDestroyed()) liveWin.destroy()
}
