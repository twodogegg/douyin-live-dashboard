// 私信：独立内置窗口读取抖音私信、生成回复草稿、串行发送。
// 首期只做「草稿 + 人工点发送」，不做任何自动发包。
import { BrowserWindow, dialog } from 'electron'
import fs from 'node:fs'
import * as db from './db.js'
import * as live from './live.js'
import {
  IM_SCAN_JS, IM_OPEN_JS, IM_SEND_JS, IM_DUMP_JS, IM_OPEN_INFO_JS, IM_GROUP_JS, IM_OPEN_MEDIA_JS, IM_FIND_MEDIA_JS,
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
let working = false
let operations = Promise.resolve()
const MEMBERS = new Map()
const PROFILES = new Map()

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
  win.webContents.setAudioMuted(true)
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

export function syncOnce() {
  return withWindow(async () => {
    if (!started) return { ok: false, msg: '私信还没启动' }
    ingest(await evalJs(ensureWindow(), IM_SCAN_JS))
    return { ok: true, ...dmStat() }
  })
}

export async function dumpPage() {
  const w = ensureWindow()
  if (!started) await start()
  return evalJs(w, IM_DUMP_JS)
}


// 所有会改变当前会话的操作排队执行，避免发送、切换与读取群成员互相干扰。
function withWindow(task) {
  const result = operations.then(async () => {
    working = true
    try { return await task() } finally { working = false }
  })
  operations = result.catch(() => {})
  return result
}

export function groupInfo(convId) {
  return withWindow(async () => {
    const selected = await selectConversation(convId)
    if (!selected.ok) return selected
    const w = ensureWindow()
    const opened = await evalJs(w, IM_OPEN_INFO_JS)
    if (!opened?.ok) return opened || { ok: false, msg: '打开群信息失败' }
    if (!opened.already) await sleep(300)
    const group = await evalJs(w, IM_GROUP_JS)
    if (group?.ok) MEMBERS.set(convId, new Map(group.members.map(m => [m.id, m])))
    return group
  })
}

const PROFILE_BUTTON = `(pattern) => {
  const button = [...document.querySelectorAll('button')].find(b => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && new RegExp(pattern).test((b.innerText || '').trim());
  });
  if (!button) return null;
  const r = button.getBoundingClientRect();
  return { text: button.innerText.trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}`

async function profileFor(convId, memberId) {
  const member = MEMBERS.get(convId)?.get(memberId)
  if (!member || !/^MS4[\w.-]+$/.test(member.sec_uid)) throw new Error('成员信息已失效，请重新读取群成员')
  let profile = PROFILES.get(member.sec_uid)
  const url = 'https://www.douyin.com/user/' + member.sec_uid
  if (profile && !profile.isDestroyed() && profile.webContents.getURL().split('?')[0] !== url) profile.destroy()
  if (!profile || profile.isDestroyed()) {
    profile = new BrowserWindow({
      width: 1100, height: 800, show: false, title: member.name,
      webPreferences: { partition: PARTITION, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    profile.webContents.setAudioMuted(true)
    wireChild(profile)
    PROFILES.set(member.sec_uid, profile)
    profile.loadURL(url).catch(() => {})
  }
  return { member, profile }
}

async function waitButton(profile, pattern) {
  for (let n = 0; n < 40; n++) {
    if (profile.isDestroyed()) break
    const button = await evalJs(profile, PROFILE_BUTTON, pattern).catch(() => null)
    if (button) return button
    await sleep(250)
  }
  return null
}

function clickButton(profile, button, member) {
  if (new URL(profile.webContents.getURL()).pathname !== '/user/' + member.sec_uid) throw new Error('成员页面已切换，请重试')
  profile.showInactive()
  profile.webContents.sendInputEvent({ type: 'mouseDown', x: button.x, y: button.y, button: 'left', clickCount: 1 })
  profile.webContents.sendInputEvent({ type: 'mouseUp', x: button.x, y: button.y, button: 'left', clickCount: 1 })
}

export function followMember(convId, memberId) {
  return withWindow(async () => {
    if (!started) return { ok: false, msg: '私信还没启动' }
    const { profile, member } = await profileFor(convId, memberId)
    const pattern = '^(关注|回关|已关注|相互关注|互相关注)$'
    const before = await waitButton(profile, pattern)
    if (!before) return { ok: false, msg: '没有找到该成员的关注按钮，请在抖音窗口查看' }
    if (/已关注|相互关注|互相关注/.test(before.text)) return { ok: true, already: true, after: before.text }
    clickButton(profile, before, member)
    for (let n = 0; n < 20; n++) {
      await sleep(250)
      const after = await evalJs(profile, PROFILE_BUTTON, pattern).catch(() => null)
      if (after && /已关注|相互关注|互相关注/.test(after.text)) {
        profile.hide()
        return { ok: true, after: after.text }
      }
    }
    return { ok: false, msg: '关注状态未变化，请在抖音窗口查看是否需要验证' }
  })
}

export function memberChat(convId, memberId) {
  return withWindow(async () => {
    if (!started) return { ok: false, msg: '私信还没启动' }
    const member = MEMBERS.get(convId)?.get(memberId)
    if (!member) return { ok: false, msg: '成员信息已失效，请重新读取群成员' }
    let target = [...CONV.values()].find(c => c.peer_sec_uid === member.sec_uid)
    if (!target) {
      const { profile } = await profileFor(convId, memberId)
      const button = await waitButton(profile, '^私信$')
      if (!button) return { ok: false, msg: '该成员没有可用的私信入口' }
      clickButton(profile, button, member)
      // 抖音原生入口创建会话后，同账号的私信页会同步该会话。
      for (let n = 0; n < 32; n++) {
        await sleep(250)
        const data = await evalJs(ensureWindow(), IM_SCAN_JS)
        ingest(data)
        target = data.conversations?.find(c => c.peer_sec_uid === member.sec_uid)
        if (target) break
        if (n === 15) ensureWindow().reload()
      }
      if (!target) return { ok: false, msg: '未同步到目标私聊，请在抖音窗口检查私信权限' }
      profile.hide()
    }
    const selected = await selectConversation(target.id)
    if (!selected.ok) return selected
    const limited = await evalJs(ensureWindow(), `() => /只能发送一条文字消息/.test(document.querySelector('.messageMessageListlist')?.innerText || '')`)
    live.broadcast({ type: 'dm_selected', conv_id: target.id })
    return { ok: true, chatting: true, active_id: target.id, limited }
  })
}

export function select(convId) {
  return withWindow(() => selectConversation(convId))
}

export async function mediaMessage(key) {
  let message = db.dmGetMsg(key)
  if (!message || !['video', 'image', 'note'].includes(message.kind)) throw new Error('媒体消息不存在')
  if (message.aweme_id || message.images?.length || /^https?:\/\//.test(message.media_url || '')) return message
  let media = db.dmFindMedia(message)
  if (!media) {
    media = await withWindow(async () => {
      const selected = await selectConversation(message.conv_id)
      if (!selected.ok) throw new Error(selected.msg)
      const found = await evalJs(ensureWindow(), IM_FIND_MEDIA_JS, message)
      if (!found) throw new Error('尚未在原会话找到这条历史消息，请点击“在抖音打开”加载历史后重试')
      ingest(found.data)
      return found.media
    })
  }
  message = db.dmGetMsg(key) || message
  const updated = { ...message, kind: media.kind, text: media.text, author: media.author || '',
    aweme_id: media.aweme_id || '', video_url: media.video_url || '', media_url: media.media_url || '', images: media.images || [] }
  const saved = db.dmSaveMsg(updated)
  if (saved) live.broadcast({ type: 'dm_msg_update', old_key: message.key, msg: updated })
  return updated
}

export function imageData(message) {
  return withWindow(async () => {
    const selected = await selectConversation(message.conv_id)
    if (!selected.ok) throw new Error(selected.msg)
    const found = await evalJs(ensureWindow(), IM_FIND_MEDIA_JS, message, true)
    if (!found?.inline) throw new Error('没有找到原图片，请在抖音打开原消息后重试')
    ingest(found.data)
    return found.inline
  })
}

export async function openMedia(key) {
  let message
  try { message = await mediaMessage(key) } catch { message = db.dmGetMsg(key) }
  return withWindow(async () => {
    if (!message) return { ok: false, msg: '媒体消息不存在' }
    if (/^\d+$/.test(message.aweme_id || '')) {
      const player = new BrowserWindow({
        width: 1100, height: 800,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
      })
      wireChild(player)
      player.loadURL('https://www.douyin.com/' + (message.kind === 'note' ? 'note/' : 'video/') + message.aweme_id).catch(() => {})
      return { ok: true }
    }
    const selected = await selectConversation(message.conv_id)
    if (!selected.ok) return selected
    if (!message.source_id) {
      ensureWindow().show()
      return { ok: true }
    }
    const opened = await evalJs(ensureWindow(), IM_OPEN_MEDIA_JS, message.source_id)
    if (opened.ok) ensureWindow().show()
    return opened
  })
}

async function selectConversation(convId) {
  if (!started) return { ok: false, msg: '私信还没启动' }
  if (!convId) return { ok: false, msg: '缺少会话 ID' }
  const w = ensureWindow()
  const opened = await evalJs(w, IM_OPEN_JS, convId)
  if (!opened?.ok) return opened || { ok: false, msg: '打开会话失败' }
  for (let n = 0; n < 20; n++) {
    await sleep(150)
    const data = await evalJs(w, IM_SCAN_JS)
    if (data.active_id === convId) {
      ingest(data)
      return { ok: true, active_id: convId }
    }
  }
  return { ok: false, msg: '尚未切换到目标会话，请重试' }
}

function schedule() {
  clearTimeout(timer)
  if (!started) return
  timer = setTimeout(() => tick(), 1000)
}

async function tick() {
  if (!started) return
  if (scanning || working || DM.sending) {
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
    db.dmMigrateConv(c.legacy_id, c.id)
    const prev = CONV.get(c.id)
    const changed = !prev || prev.name !== c.name || prev.avatar !== c.avatar || prev.preview !== c.preview
    // 列表本身按最新排序；首次扫描按下标递减，既保留顺序又不伪造真实时间
    const lastTs = changed ? now - c.idx * 0.001 : prev.last_ts || now
    CONV.set(c.id, { ...c, last_ts: lastTs })
    db.dmUpsertConv({
      id: c.id,
      name: c.name,
      avatar: c.avatar,
      preview: c.preview,
      last_ts: lastTs,
      last_time: c.time_text,
      unread: c.unread,
      is_group: c.is_group,
      peer_sec_uid: c.peer_sec_uid,
    })
    if (changed) {
      live.broadcast({
        type: 'dm_conv',
        conv: {
          id: c.id,
          legacy_id: c.legacy_id,
          name: c.name,
          avatar: c.avatar,
          preview: c.preview,
          last_ts: lastTs,
          last_time: c.time_text,
          unread: c.unread,
          is_group: c.is_group,
          peer_sec_uid: c.peer_sec_uid,
        },
      })
    }
  })

  DM.conv_count = convs.length
  DM.unread = convs.reduce((n, c) => n + (c.unread || 0), 0)

  DM.active_id = data.active_id || DM.active_id

  const activeId = data.active_id || ''
  if (activeId) {
    const msgs = data.messages || []
    const fallback = new Set(pickNew(activeId, msgs).map(m => m.key))
    for (const m of msgs) {
      if (!m.source_id && !fallback.has(m.key)) continue
      const ts = m.ts || now
      const row = {
        key: `${activeId}:${m.key}`, conv_id: activeId, direction: m.direction,
        kind: m.kind || 'text', text: m.text, thumb: m.thumb || '', author: m.author || '',
        source_id: m.source_id || '', sender_id: m.sender_id || '',
        sender_name: m.sender_name || (m.direction === 'out' ? '我' : ''),
        sender_avatar: m.sender_avatar || '', sender_sec_uid: m.sender_sec_uid || '',
        aweme_id: m.aweme_id || '', video_url: m.video_url || '', media_url: m.media_url || '', images: m.images || [],
        ts, time: new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }),
      }
      const saved = db.dmSaveMsg(row, m.legacy_key || '')
      if (saved) live.broadcast({ type: saved.inserted ? 'dm_msg' : 'dm_msg_update', old_key: saved.old_key, conv_id: activeId, msg: row })
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
  const history = rows.map((m) => `${m.direction === 'out' ? '我' : m.sender_name || '对方'}：${m.text}`).join('\n')
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
export function attachFiles(convId) {
  return withWindow(async () => {
    const selected = await selectConversation(convId)
    if (!selected.ok) return selected
    return attachToConversation()
  })
}

async function attachToConversation() {
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
export function send(convId, text) {
  return withWindow(() => sendMessage(convId, text))
}

async function sendMessage(convId, text) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, msg: '内容不能为空' }
  if (DM.sending) return { ok: false, msg: '正在发送上一条，请稍等' }
  if (!started) return { ok: false, msg: '私信还没启动' }
  if (!convId) return { ok: false, msg: '缺少会话 id' }

  DM.sending = true
  sendStat(true)
  try {
    const opened = await selectConversation(convId)
    if (!opened.ok) return opened
    const w = ensureWindow()

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
  for (const child of CHILDREN) if (!child.isDestroyed()) child.destroy()
  PROFILES.clear()
}
