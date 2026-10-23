// 独立实现最小 Protobuf 读取器；复用抖音页面的鉴权、心跳和连接，不记录凭证。
import { gunzipSync } from 'node:zlib'

export function fields(buffer) {
  const bytes = Buffer.from(buffer)
  const result = new Map()
  let offset = 0
  const number = () => {
    let value = 0n
    for (let shift = 0n; shift < 70n && offset < bytes.length; shift += 7n) {
      const byte = bytes[offset++]
      value |= BigInt(byte & 127) << shift
      if (!(byte & 128)) return value
    }
    throw new Error('无效 Protobuf varint')
  }
  while (offset < bytes.length) {
    const tag = Number(number())
    const wire = tag & 7
    const field = tag >>> 3
    if (!field) throw new Error('无效 Protobuf 字段')
    let value
    if (wire === 0) value = number().toString()
    else if (wire === 2) {
      const size = Number(number())
      if (size > bytes.length - offset) throw new Error('Protobuf 数据不完整')
      value = bytes.subarray(offset, offset + size)
      offset += size
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4
      if (offset > bytes.length) throw new Error('Protobuf 数据不完整')
      continue
    } else throw new Error('不支持的 Protobuf 编码')
    if (!result.has(field)) result.set(field, [])
    result.get(field).push(value)
  }
  return result
}

const first = (map, id) => map.get(id)?.[0]
const str = (map, id) => String(first(map, id) || '')

export function decodePush(buffer, account, now = Date.now()) {
  if (!account) return null // 未确认自身身份时不推断方向。
  const frame = fields(buffer)
  if (str(frame, 7) !== 'pb' || !first(frame, 8)) return null
  const payload = str(frame, 6) === 'gzip' ? gunzipSync(first(frame, 8), { maxOutputLength: 4 * 1024 * 1024 }) : first(frame, 8)
  const response = fields(payload)
  const body = first(response, 6)
  if (!body) return null
  const notify = first(fields(body), 500)
  if (!notify) return null
  const raw = first(fields(notify), 5)
  if (!raw) return null
  const m = fields(raw)
  const id = str(m, 3)
  const conv = str(m, 1)
  const sender = str(m, 7)
  if (!id || id === '0' || !conv || !sender || sender === '0') return null
  const type = Number(str(m, 6))
  if (type === 50001) return null
  let content
  try { content = JSON.parse(str(m, 8)) } catch { content = { text: str(m, 8) } }
  const kind = ({ 7: 'text', 5: 'image', 27: 'image', 17: 'audio', 8: 'video' })[type] || 'unsupported'
  // 协议图片可能加密：只保留引用，原图仍走浏览器解密读取。
  const created = Number(str(m, 10))
  const ts = created > 1e12 ? created / 1000 : created || now / 1000
  return {
    platform: 'douyin', account_id: account, conv_id: conv, source_id: id,
    key: `${conv}:m:${id}`, direction: sender === account ? 'out' : 'in', sender_id: sender,
    kind, text: kind === 'text' ? String(content.text || '') : ({ image: '[图片]', audio: '[语音]', video: '[分享视频]' })[kind] || `[暂不支持的消息 ${type}]`,
    media_ref: JSON.stringify(content), aweme_id: String(content.itemId || ''),
    timestamp_known: Number.isFinite(created) && created > 0,
    ts, time: new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }),
    is_group: str(m, 2) === '2',
  }
}

export class ProtocolReceiver {
  constructor({ onMessage, onState, onAccount, onReconnect }) {
    Object.assign(this, { onMessage, onState, onAccount, onReconnect })
    this.mode = 'browser'
    this.account = ''
    this.identityRevision = 0
    this.sockets = new Set()
    this.queries = new Set()
    this.listener = (_event, method, params) => { void this.handle(method, params).catch(() => this.state('error', '协议解析失败，浏览器接收仍可使用')) }
  }

  attach(webContents) {
    this.webContents = webContents
    const debug = webContents.debugger
    try {
      if (!debug.isAttached()) debug.attach('1.3')
      debug.on('message', this.listener)
      this.attached = true
      void debug.sendCommand('Network.enable').catch(() => { this.attached = false; this.state('error', '无法监听协议，请使用浏览器接收') })
    } catch { this.attached = false; this.state('error', '无法监听协议，请使用浏览器接收') }
  }

  setMode(mode) {
    if (!['browser', 'compare', 'protocol'].includes(mode)) throw new Error('接收模式无效')
    this.mode = mode
    if (mode !== 'browser' && this.attached === false) this.state('error', '协议监听不可用，请切回浏览器接收')
    else this.state(mode === 'browser' ? 'disabled' : this.sockets.size ? 'connected' : 'waiting')
  }

  state(status, error = '') {
    this.onState({ status, error, mode: this.mode, account_id: this.account })
  }

  invalidateIdentity() {
    this.identityRevision++
    this.account = ''
    this.queries.clear()
    this.onAccount('')
  }

  confirmAccount(account) {
    if (!/^\d+$/.test(account) || account === '0' || account === this.account) return
    this.identityRevision++
    this.account = account
    this.onAccount(account)
    this.state(this.sockets.size ? 'connected' : 'waiting')
  }

  async handle(method, p) {
    if (method === 'Network.responseReceived' && /^https:\/\/www\.douyin\.com\/aweme\/v1\/web\/query\/user\/?\?/.test(p.response?.url || '')) this.queries.add(p.requestId)
    if (method === 'Network.loadingFinished' && this.queries.delete(p.requestId)) {
      const revision = this.identityRevision
      const r = await this.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: p.requestId })
      if (revision !== this.identityRevision) return
      const data = JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body)
      const account = String(data.user_uid || data.user?.uid || '')
      this.confirmAccount(account)
    }
    if (method === 'Network.webSocketCreated' && /^wss:\/\/frontier-im\.douyin\.com\//.test(p.url || '')) this.sockets.add(p.requestId)
    if (method === 'Network.webSocketHandshakeResponseReceived' && this.sockets.has(p.requestId)) {
      clearTimeout(this.retryTimer)
      this.retries = 0
      this.state(p.response?.status === 101 ? 'connected' : 'auth_required')
      this.onReconnect()
    }
    if ((method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') && this.sockets.delete(p.requestId)) {
      if (this.sockets.size || this.mode === 'browser') return
      this.state('reconnecting')
      clearTimeout(this.retryTimer)
      const delay = Math.min(60000, 2000 * 2 ** Math.min(this.retries || 0, 5))
      this.retries = (this.retries || 0) + 1
      this.retryTimer = setTimeout(() => {
        if (!this.webContents?.isDestroyed() && this.mode !== 'browser') this.webContents.reload()
      }, delay)
    }
    if (method === 'Network.webSocketFrameReceived' && this.sockets.has(p.requestId) && this.mode !== 'browser' && p.response?.opcode === 2) {
      const bytes = Buffer.from(p.response.payloadData, 'base64')
      if (bytes.length > 4 * 1024 * 1024) throw new Error('协议帧过大')
      const message = decodePush(bytes, this.account)
      if (message) this.onMessage(message, this.mode)
    }
  }

  stop() {
    clearTimeout(this.retryTimer)
    this.sockets.clear()
    this.queries.clear()
    if (this.webContents && !this.webContents.isDestroyed()) this.webContents.debugger.off('message', this.listener)
    this.webContents = null
  }
}
