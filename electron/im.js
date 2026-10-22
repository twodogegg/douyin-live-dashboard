// 私信：独立内置窗口读取抖音私信、生成回复草稿、串行发送。
// 首期只做「草稿 + 人工点发送」，不做任何自动发包。
import { BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import * as db from './db.js'
import * as live from './live.js'
import {
  IM_SCAN_JS, IM_OPEN_JS, IM_SEND_JS, IM_DUMP_JS, IM_OPEN_INFO_JS, IM_GROUP_JS, IM_MEMBER_DM_JS,
} from './im-extract.js'

const PARTITION = 'persist:douyin'
const MSG_HOME = 'https://www.douyin.com/chat?isPopup=1'
const FALLBACK_PROMPT =
  '你是抖音语音直播间的客服助理，用简体中文回复用户私信。' +
  '语气自然、简短（不超过 40 字），像真人在打字。' +
  '只回答与直播间、服务、内容相关的问题；遇到价格、退款、联系方式、投诉、违法违规等，只输出「[转人工]」。' +
  '不要暴露你是 AI，不要编造活动、优惠或承诺。'

const DM = {
  status: '未启动',
  running: false,
  url: '',
  error: '',
  conv_count: 0,
  active_id: '',
  unread: 0,
  last_scan: '',
  sending: false,
}

let win = null
let timer = null
let started = false
let scanning = false
let shuttingDown = false
let agentFile = ''
let AGENT = { system_prompt: FALLBACK_PROMPT, temperature: 0.6 }
let lastStatJson = ''
let lastPrune = 0

const IDX = new Map() // conv_id -> 列表下标
const CONV = new Map() // conv_id -> 上次扫描到的会话快照
const PREV = new Map() // conv_id -> 上次扫描到的消息指纹（dir|text）
const CHILDREN = [] // 弹出的子窗口（成员主页/单聊）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toTimeString().slice(0, 8)

export function init({ dmAgentPath, defaultDmAgentPath }) {
  agentFile = dmAgentPath
  AGENT = loadAgent(dmAgentPath, defaultDmAgentPath)
}

function loadAgent(file, defFile) {
  try {
    const conf = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (conf && conf.system_prompt) return conf
  } catch {
    /* 还没写过，落到默认 */
  }
  let def = { system_prompt: FALLBACK_PROMPT, temperature: 0.6 }
  try {
    def = JSON.parse(fs.readFileSync(defFile, 'utf-8'))
  } catch {
    /* 默认文件缺失时用内置文案 */
  }
  try {
    fs.writeFileSync(file, JSON.stringify(def, null, 2))
  } catch {
    /* 写盘失败不影响本次运行 */
  }
  return def
}

function evalJs(w, code, ...args) {
  return w.webContents.executeJavaScript(
    `(${code})(${args.map((a) => JSON.stringify(a)).join(',')})`,
    true,
  )
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    title: '抖音私信',
    webPreferences: {
      partition: PARTITION,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.on('close', (e) => {
    if (!shuttingDown) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })
  // 私信入口可能用 window.open 打开独立窗口（如群成员主页）
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 1000,
      height: 760,
      show: true,
      webPreferences: {
        partition: PARTITION,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  }))
  win.webContents.on('did-create-window', (child) => wireChild(child))
  return win
}

// 子窗口（用户主页等）里再开的窗口也要纳入管理
function wireChild(child) {
  CHILDREN.push(child)
  child.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([a-z0-9-]+\.)?douyin\.com\//i.test(url)) {
      child.loadURL(url).catch(() => {})
    }
    return { action: 'deny' }
  })
  child.webContents.on('did-create-window', (c) => wireChild(c))
}

export function dmStat() {
  return {
    type: 'dm_stat',
    status: DM.status,
    running: started,
    url: DM.url,
    error: DM.error,
    conv_count: DM.conv_count,
    active_id: DM.active_id,
    unread: DM.unread,
    last_scan: DM.last_scan,
    sending: DM.sending,
  }
}

function sendStat(force = false) {
  const msg = dmStat()
  const json = JSON.stringify(msg)
  if (!force && json === lastStatJson) return
  lastStatJson = json
  live.broadcast(msg)
}

export async function start() {
  const w = ensureWindow()
  if (started) {
    sendStat(true)
    return { ok: true, ...dmStat() }
  }
  started = true
  DM.running = true
  DM.status = '打开私信页…'
  sendStat(true)
  await sleep(200) // 等 CDP 的 Network.enable 生效
  try {
    await w.loadURL(MSG_HOME)
  } catch {
    /* 页面里的子资源失败会 reject，但 DOM 通常已可用 */
  }
  DM.status = '等待私信页加载'
  sendStat(true)
  schedule()
  return { ok: true, ...dmStat() }
}

export function stop() {
  started = false
  DM.running = false
  DM.status = '已停止'
  clearTimeout(timer)
  timer = null
  sendStat(true)
  return { ok: true, ...dmStat() }
}

export async function showWindow() {
  const w = ensureWindow()
  if (!started) await start()
  w.show()
  w.focus()
  return { ok: true }
}

export async function syncOnce() {
  if (!started) return { ok: false, msg: '私信还没启动' }
  await tick()
  return { ok: true, ...dmStat() }
}

export async function dumpPage() {
  const w = ensureWindow()
  if (!started) await start()
  return evalJs(w, IM_DUMP_JS)
}


// 打开群信息面板并读取群资料
export async function groupInfo(convId) {
  if (!started) return { ok: false, msg: '私信还没启动' }
  if (convId && convId !== DM.active_id) await select(convId)
  const w = ensureWindow()
  const opened = await evalJs(w, IM_OPEN_INFO_JS)
  if (!opened || !opened.ok) return opened || { ok: false, msg: '打开群信息失败' }
  if (!opened.already) await sleep(900)
  return evalJs(w, IM_GROUP_JS)
}

// 在子窗口里等「私信」按钮并点开聊天
const FIND_MSG_BTN = `() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '私信');
  if (!b) return { ok: false };
  const r = b.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
}`

const CHILD_CHAT_STATE = `() => {
  const list = document.querySelector('.messageMessageListlist');
  const box = list ? list.getBoundingClientRect() : null;
  // 只看当前对话的消息区，避免把左侧别的会话预览误判成限制提示
  const chatText = list ? (list.innerText || '') : '';
  const pageText = document.body.innerText || '';
  const followBtn = [...document.querySelectorAll('button')]
    .find(x => /^(关注|已关注|相互关注|互相关注)$/.test((x.innerText || '').trim()));
  return {
    hasChat: !!(box && box.width > 100) && !!document.querySelector('[data-e2e="msg-input"]'),
    limited: /只能发送一条文字消息/.test(chatText),
    needFollow: /关注后才能私信|关注后即可私信|仅关注的人/.test(pageText),
    followText: followBtn ? (followBtn.innerText || '').trim() : '',
  };
}`

async function waitNewChild(beforeIds) {
  for (let i = 0; i < 16; i++) {
    await sleep(500)
    const found = CHILDREN.filter((w) => !w.isDestroyed() && !beforeIds.has(w.id))
    if (found.length) return found[found.length - 1]
  }
  return null
}

async function startChatInChild(child) {
  for (let i = 0; i < 16; i++) {
    const btn = await evalJs(child, FIND_MSG_BTN).catch(() => null)
    if (btn && btn.ok) {
      if (btn.w > 0) {
        child.showInactive()
        child.webContents.sendInputEvent({ type: 'mouseMove', x: btn.x, y: btn.y })
        child.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
        child.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 })
      }
      await sleep(2000)
      let st = await evalJs(child, CHILD_CHAT_STATE).catch(() => null)
      if (st && st.hasChat) return st
      // 真实点击没生效时再用页面内 click()
      await evalJs(
        child,
        `() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '私信'); if (b) b.click(); }`,
      ).catch(() => {})
      await sleep(2500)
      st = await evalJs(child, CHILD_CHAT_STATE).catch(() => null)
      return st || { hasChat: false }
    }
    await sleep(500)
  }
  return { hasChat: false }
}

// 点群成员头像 → 打开其主页 → 自动点「私信」进入单聊
export async function memberChat(idx) {
  if (!started) return { ok: false, msg: '私信还没启动' }
  const beforeIds = new Set(CHILDREN.filter((w) => !w.isDestroyed()).map((w) => w.id))
  const r = await evalJs(ensureWindow(), IM_MEMBER_DM_JS, Number(idx) || 0)
  if (!r || !r.ok) return r || { ok: false, msg: '点击成员失败' }

  const child = await waitNewChild(beforeIds)
  if (!child) return { ok: false, msg: '没能打开成员主页' }
  const st = await startChatInChild(child)
  try {
    child.show()
    child.focus()
  } catch {
    /* 窗口可能已关闭 */
  }
  const chatting = !!(st && st.hasChat)
  return {
    ok: true,
    name: r.name,
    chatting,
    limited: !!(st && st.limited),
    needFollow: !!(st && st.needFollow),
    followText: (st && st.followText) || '',
    msg: chatting ? '' : '已打开成员主页，请在窗口里点「私信」',
  }
}

// 对当前打开的子窗口点「关注」
export async function followMember() {
  const alive = CHILDREN.filter((w) => !w.isDestroyed())
  const child = alive[alive.length - 1]
  if (!child) return { ok: false, msg: '没有打开的成员窗口' }
  const r = await evalJs(
    child,
    `() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => /^(关注|已关注|相互关注|互相关注)$/.test((x.innerText || '').trim()));
      if (!b) return { ok: false, msg: '没找到关注按钮' };
      const rect = b.getBoundingClientRect();
      return { ok: true, text: (b.innerText || '').trim(), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width) };
    }`,
  ).catch(() => null)
  if (!r || !r.ok) return r || { ok: false, msg: '读取关注按钮失败' }
  if (r.w > 0) {
    child.showInactive()
    child.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y })
    child.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    child.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  }
  await sleep(1500)
  const after = await evalJs(child, CHILD_CHAT_STATE).catch(() => null)
  return { ok: true, before: r.text, after: (after && after.followText) || '' }
}

// 打开指定会话并同步一次消息
export async function select(convId) {
  if (!started) return { ok: false, msg: '私信还没启动' }
  if (!IDX.has(convId)) {
    try {
      ingest(await evalJs(ensureWindow(), IM_SCAN_JS))
    } catch {
      /* 下面会给出失败原因 */
    }
  }
  const idx = IDX.get(convId)
  if (idx === undefined) return { ok: false, msg: '会话不在当前列表里，请先同步' }
  const r = await evalJs(ensureWindow(), IM_OPEN_JS, idx)
  if (!r || !r.ok) return { ok: false, msg: (r && r.msg) || '打开会话失败' }
  await sleep(800)
  try {
    ingest(await evalJs(ensureWindow(), IM_SCAN_JS))
  } catch {
    /* 打不开也先返回成功，下一轮轮询会补上 */
  }
  return { ok: true, active_id: DM.active_id }
}

function schedule() {
  clearTimeout(timer)
  if (!started) return
  timer = setTimeout(() => tick(), 1000)
}

async function tick() {
  if (!started) return
  if (scanning || DM.sending) {
    schedule()
    return
  }
  scanning = true
  try {
    const w = ensureWindow()
    const data = await evalJs(w, IM_SCAN_JS)
    ingest(data)
  } catch (e) {
    DM.status = '读取失败'
    DM.error = String((e && e.message) || e).slice(0, 200)
    sendStat()
  } finally {
    scanning = false
    schedule()
  }
}

function ingest(data) {
  if (!data || !data.ok) {
    const url = (data && data.url) || ''
    DM.url = url
    DM.status = /passport|login/i.test(url) ? '需要登录' : '等待私信页加载'
    DM.error = ''
    sendStat()
    return
  }

  DM.status = '已连接'
  DM.url = data.url
  DM.error = ''
  DM.last_scan = stamp()
  const now = Date.now() / 1000
  const convs = data.conversations || []

  convs.forEach((c) => {
    IDX.set(c.id, c.idx)
    const prev = CONV.get(c.id)
    CONV.set(c.id, c)
    const changed = !prev || prev.name !== c.name || prev.avatar !== c.avatar || prev.preview !== c.preview
    // 列表本身按最新排序；首次扫描按下标递减，既保留顺序又不伪造真实时间
    const lastTs = changed ? now - c.idx * 0.001 : prev.last_ts || now
    db.dmUpsertConv({
      id: c.id,
      name: c.name,
      avatar: c.avatar,
      preview: c.preview,
      last_ts: lastTs,
      last_time: c.time_text,
      unread: c.unread,
    })
    if (changed) {
      live.broadcast({
        type: 'dm_conv',
        conv: {
          id: c.id,
          name: c.name,
          avatar: c.avatar,
          preview: c.preview,
          last_ts: lastTs,
          last_time: c.time_text,
          unread: c.unread,
        },
      })
    }
  })

  DM.conv_count = convs.length
  DM.unread = convs.reduce((n, c) => n + (c.unread || 0), 0)

  // 清掉已不存在/换了 id 的旧会话（最多每 60s 一次，避免列表抖动时误删）
  if (data.diag && data.diag.exact && convs.length && Date.now() - lastPrune > 60000) {
    lastPrune = Date.now()
    const keep = new Set(convs.map((c) => c.id))
    const removed = db.dmPruneConvs([...keep])
    if (removed) {
      for (const id of [...CONV.keys()]) if (!keep.has(id)) CONV.delete(id)
      for (const id of [...PREV.keys()]) if (!keep.has(id)) PREV.delete(id)
      for (const id of [...IDX.keys()]) if (!keep.has(id)) IDX.delete(id)
    }
  }

  DM.active_id = data.active_id || DM.active_id

  const activeId = data.active_id || ''
  if (activeId) {
    const msgs = data.messages || []
    for (const m of pickNew(activeId, msgs)) {
      const key = `${activeId}:${m.key}`
      const row = {
        key,
        conv_id: activeId,
        direction: m.direction,
        kind: m.kind || 'text',
        text: m.text,
        thumb: m.thumb || '',
        author: m.author || '',
        ts: now,
        time: stamp(),
      }
      if (db.dmInsertMsg(row)) live.broadcast({ type: 'dm_msg', conv_id: activeId, msg: row })
    }
  }

  sendStat()
}

// 只把「相对上轮新增的尾部」当成新消息，避免虚拟列表滚动导致重复入库
function pickNew(convId, msgs) {
  const cur = msgs.map((m) => m.fp || `${m.direction}|${m.text}`)
  const prev = PREV.get(convId) || []
  PREV.set(convId, cur)
  if (!prev.length) return msgs
  // prev 应该是 cur 的前缀：找最长的「prev 尾部 == cur 头部」
  let overlap = 0
  for (let n = Math.min(prev.length, cur.length); n > 0; n--) {
    let same = true
    for (let i = 0; i < n; i++) {
      if (prev[prev.length - n + i] !== cur[i]) {
        same = false
        break
      }
    }
    if (same) {
      overlap = n
      break
    }
  }
  if (!overlap) return []
  return msgs.slice(overlap)
}

export async function draft(convId) {
  const conv = db.dmGetConv(convId)
  if (!conv) return { ok: false, msg: '会话不存在，请先同步私信' }
  const conf = live.aiConfig()
  if (!conf.has_key) return { ok: false, msg: '还没配置模型 Key，请先到「设置」里填写' }

  const rows = db.dmListMsgs(convId, 14)
  const history = rows.map((m) => `${m.direction === 'in' ? '对方' : '我'}：${m.text}`).join('\n')
  const user = `对方昵称：${conv.name || ''}\n最近对话：\n${history || '（暂无）'}\n\n请只输出一条可直接发送的回复正文。`

  try {
    const text = await live.chatComplete(
      [
        { role: 'system', content: AGENT.system_prompt },
        { role: 'user', content: user },
      ],
      { max_tokens: 300, temperature: AGENT.temperature },
    )
    const clean = (text || '').replace(/^["'“”]+|["'“”]+$/g, '').trim()
    if (!clean) return { ok: false, msg: '模型返回为空' }
    return { ok: true, text: clean }
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e).slice(0, 200) }
  }
}

// 选择本地图片/视频，通过 CDP 塞进私信页的文件输入框，由页面原生上传
export async function attachFiles() {
  if (!started) return { ok: false, msg: '私信还没启动' }
  const w = ensureWindow()
  const picked = await dialog.showOpenDialog({
    title: '选择要发送的图片或视频',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片或视频', extensions: ['jpg', 'jpeg', 'png', 'gif', 'mp4'] }],
  })
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true, msg: '已取消' }

  const dbg = w.webContents.debugger
  try {
    dbg.attach('1.3')
  } catch {
    /* 已附着 */
  }
  try {
    await dbg.sendCommand('DOM.enable')
    const { result } = await dbg.sendCommand('Runtime.evaluate', {
      expression: `document.querySelector('[data-e2e="msg-input"] input[type=file]')`,
    })
    if (!result || !result.objectId) return { ok: false, msg: '私信窗口里没找到文件输入框' }
    await dbg.sendCommand('DOM.setFileInputFiles', {
      files: picked.filePaths,
      objectId: result.objectId,
    })
    await sleep(1500)
    try {
      ingest(await evalJs(w, IM_SCAN_JS))
    } catch {
      /* 上传后刷新失败不影响结果 */
    }
    return { ok: true, count: picked.filePaths.length }
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e).slice(0, 200) }
  }
}

// 串行发送：一个窗口同一时刻只能在一个会话里输入
export async function send(convId, text) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, msg: '内容不能为空' }
  if (DM.sending) return { ok: false, msg: '正在发送上一条，请稍等' }
  if (!started) return { ok: false, msg: '私信还没启动' }
  if (!convId) return { ok: false, msg: '缺少会话 id' }

  // 会话下标只在内存里，应用重启后需要先扫一次
  if (!IDX.has(convId)) {
    try {
      ingest(await evalJs(ensureWindow(), IM_SCAN_JS))
    } catch {
      /* 扫描失败时下面的下标检查会给出提示 */
    }
  }

  DM.sending = true
  sendStat(true)
  try {
    const idx = IDX.get(convId)
    if (idx === undefined) return { ok: false, msg: '会话不在当前列表里，请先刷一次私信' }

    const w = ensureWindow()
    const opened = await evalJs(w, IM_OPEN_JS, idx)
    if (!opened || !opened.ok) return { ok: false, msg: (opened && opened.msg) || '打开会话失败' }
    await sleep(700)

    const res = await evalJs(w, IM_SEND_JS, body)
    if (!res || !res.ok) return { ok: false, msg: (res && res.msg) || '发送失败，可在私信窗口手动发送' }

    // 发送成功后直接按页面回显入库：用的 key 与轮询扫描完全一致，
    // 避免「本地造一条 + 扫描再插一条」导致同一条消息入库两次。
    try {
      const data = await evalJs(w, IM_SCAN_JS)
      if (data && data.ok) ingest(data)
    } catch {
      /* 扫描失败时下一轮轮询会补上 */
    }
    const conv = db.dmGetConv(convId)
    if (conv) {
      db.dmUpsertConv({ ...conv, preview: body, last_ts: Date.now() / 1000, last_time: stamp(), unread: 0 })
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e).slice(0, 200) }
  } finally {
    DM.sending = false
    sendStat(true)
  }
}

export function getAgent() {
  return { ...AGENT }
}

export function setAgent(conf) {
  const prompt = conf && typeof conf.system_prompt === 'string' ? conf.system_prompt.trim() : ''
  if (!prompt) return { ok: false, msg: '回复风格提示词不能为空' }
  const temperature = Math.min(1.2, Math.max(0, Number(conf.temperature) || 0.6))
  AGENT = { system_prompt: prompt, temperature }
  try {
    fs.writeFileSync(agentFile, JSON.stringify(AGENT, null, 2))
  } catch (e) {
    return { ok: false, msg: String(e.message || e) }
  }
  return { ok: true, config: { ...AGENT } }
}

export function shutdown() {
  shuttingDown = true
  started = false
  clearTimeout(timer)
  timer = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
