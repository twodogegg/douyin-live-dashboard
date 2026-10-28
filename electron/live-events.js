// 参考 DyHub 的浏览器采集方式：读取直播页已有的 WebSocket，不另建连接或处理签名。
import protobuf from 'protobufjs'
import { gunzipSync } from 'node:zlib'

const root = protobuf.parse(`
  syntax = "proto3";
  message Header { string key = 1; string value = 2; }
  message PushFrame {
    repeated Header headers = 5;
    string payload_type = 7;
    bytes payload = 8;
  }
  message Response { repeated Message messages = 1; }
  message Message { string method = 1; bytes payload = 2; int64 msg_id = 3; }
  message Common { uint64 create_time = 4; }
  message User { uint64 id = 1; string nick_name = 3; }
  message Member { Common common = 1; User user = 2; uint64 action = 10; }
  message Social { Common common = 1; User user = 2; uint64 action = 4; }
  message GiftInfo { uint32 diamond_count = 12; string name = 16; }
  message Gift {
    Common common = 1;
    uint64 gift_id = 2;
    uint64 group_count = 4;
    uint64 repeat_count = 5;
    uint64 combo_count = 6;
    User user = 7;
    uint32 repeat_end = 9;
    uint64 group_id = 11;
    GiftInfo gift = 15;
  }
`).root
const frameType = root.lookupType('PushFrame')
const responseType = root.lookupType('Response')
const memberType = root.lookupType('Member')
const socialType = root.lookupType('Social')
const giftType = root.lookupType('Gift')

export function decodeLiveEvents(data, since = 0) {
  try {
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) return []
    const frame = frameType.decode(bytes)
    if (!['msg', 'push'].includes(frame.payloadType)) return []
    const compressed = frame.headers.some(header => header.key === 'compress_type' && header.value === 'gzip')
      || (frame.payload[0] === 0x1f && frame.payload[1] === 0x8b)
    const payload = compressed ? gunzipSync(frame.payload, { maxOutputLength: 16 * 1024 * 1024 }) : frame.payload
    const events = []
    for (const message of responseType.decode(payload).messages) {
      const kind = message.method === 'WebcastMemberMessage' ? 'join' : message.method === 'WebcastGiftMessage' ? 'gift' : message.method === 'WebcastSocialMessage' ? 'follow' : ''
      if (!kind) continue
      try {
        const body = (kind === 'join' ? memberType : kind === 'gift' ? giftType : socialType).decode(message.payload)
        const user = String(body.user?.nickName || '').trim().slice(0, 80)
        const created = Number(body.common?.createTime || 0)
        const timestamp = created && (created < 1e12 ? created * 1000 : created)
        if (!user || (kind === 'join' && Number(body.action) && Number(body.action) !== 1)
          || (kind === 'follow' && Number(body.action) !== 1) || (timestamp && timestamp < since - 5000)) continue
        const msgId = String(message.msgId || '')
        const event = { kind, user, id: msgId === '0' ? '' : msgId, timestamp: timestamp || Date.now() }
        if (kind === 'gift') {
          const gift = String(body.gift?.name || '礼物').trim().slice(0, 40) || '礼物'
          const count = Number(body.repeatCount) || Number(body.comboCount) || Number(body.groupCount) || 1
          if (!Number.isSafeInteger(count) || count < 1) continue
          const groupId = String(body.groupId || '')
          const giftId = String(body.giftId || '')
          const userId = String(body.user?.id || '')
          Object.assign(event, {
            gift, count, unitValue: Number(body.gift?.diamondCount || 0),
            group: groupId && groupId !== '0' ? JSON.stringify([userId && userId !== '0' ? userId : user, giftId && giftId !== '0' ? giftId : gift, groupId]) : '',
          })
        }
        events.push(event)
      } catch { /* 单条消息异常不影响其他事件 */ }
    }
    return events
  } catch {
    return []
  }
}

export async function observeLiveEvents(contents, onEvent, since = Date.now()) {
  const debuggerSession = contents.debugger
  if (debuggerSession.isAttached()) return () => {}
  const sockets = new Set()
  const giftGroups = new Map()
  let active = true
  let attached = false
  let timer
  const onMessage = (_event, method, params) => {
    if (!active) return
    if (method === 'Network.webSocketCreated') {
      try {
        const url = new URL(params.url)
        if (url.hostname.endsWith('.douyin.com') && url.pathname.startsWith('/webcast/im/push/')) sockets.add(params.requestId)
      } catch { /* 非法地址不参与采集 */ }
    } else if (method === 'Network.webSocketClosed') {
      sockets.delete(params.requestId)
    } else if (method === 'Network.webSocketFrameReceived' && sockets.has(params.requestId) && params.response?.opcode === 2) {
      for (const event of decodeLiveEvents(params.response.payloadData, since)) {
        if (event.kind === 'gift' && event.group) {
          const previous = giftGroups.get(event.group) || 0
          if (event.count <= previous) continue
          giftGroups.set(event.group, event.count)
          if (giftGroups.size > 1000) giftGroups.delete(giftGroups.keys().next().value)
          if (previous && event.id) event.id += `:${event.count}`
          event.count -= previous
        }
        onEvent(event)
      }
    }
  }
  try {
    debuggerSession.attach('1.3')
    attached = true
    debuggerSession.on('message', onMessage)
    await Promise.race([
      debuggerSession.sendCommand('Network.enable'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('直播事件监听超时')), 3000) }),
    ])
  } catch {
    active = false
    debuggerSession.removeListener('message', onMessage)
    try { if (attached && debuggerSession.isAttached()) debuggerSession.detach() } catch { /* 页面已经关闭 */ }
    return () => {}
  } finally {
    clearTimeout(timer)
  }
  return () => {
    active = false
    debuggerSession.removeListener('message', onMessage)
    try { if (debuggerSession.isAttached()) debuggerSession.detach() } catch { /* 页面已经关闭 */ }
  }
}
