import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { gzipSync } from 'node:zlib'
import protobuf from 'protobufjs'
import { decodeLiveEvents, observeLiveEvents } from './live-events.js'

const field = (number, wire) => number * 8 + wire
const encode = writer => Buffer.from(writer.finish())
const wrap = (name, bytes, id = '7681626144000791846') => encode(protobuf.Writer.create()
  .uint32(field(1, 2)).string(name).uint32(field(2, 2)).bytes(bytes).uint32(field(3, 0)).int64(id))
const member = ({ user = '小鹿', action = 1, created = 0 } = {}) => {
  const userBytes = encode(protobuf.Writer.create().uint32(field(3, 2)).string(user))
  const commonBytes = encode(protobuf.Writer.create().uint32(field(4, 0)).uint64(created))
  return encode(protobuf.Writer.create().uint32(field(1, 2)).bytes(commonBytes)
    .uint32(field(2, 2)).bytes(userBytes).uint32(field(10, 0)).uint64(action))
}
const social = ({ user = '小鹿', action = 1, created = 0 } = {}) => {
  const userBytes = encode(protobuf.Writer.create().uint32(field(3, 2)).string(user))
  const commonBytes = encode(protobuf.Writer.create().uint32(field(4, 0)).uint64(created))
  return encode(protobuf.Writer.create().uint32(field(1, 2)).bytes(commonBytes)
    .uint32(field(2, 2)).bytes(userBytes).uint32(field(4, 0)).uint64(action))
}
const gift = ({ user = '小鹿', name = '玫瑰', count = 1, group = '123', end = 0, created = 0 } = {}) => {
  const userBytes = encode(protobuf.Writer.create().uint32(field(1, 0)).uint64('123456789').uint32(field(3, 2)).string(user))
  const commonBytes = encode(protobuf.Writer.create().uint32(field(4, 0)).uint64(created))
  const giftBytes = encode(protobuf.Writer.create().uint32(field(12, 0)).uint32(1).uint32(field(16, 2)).string(name))
  return encode(protobuf.Writer.create().uint32(field(1, 2)).bytes(commonBytes).uint32(field(2, 0)).uint64(42)
    .uint32(field(5, 0)).uint64(count).uint32(field(7, 2)).bytes(userBytes).uint32(field(9, 0)).uint32(end)
    .uint32(field(11, 0)).uint64(group).uint32(field(15, 2)).bytes(giftBytes))
}
const makeFrame = (messages, { gzip = true, type = 'msg' } = {}) => {
  const response = protobuf.Writer.create()
  for (const message of messages) response.uint32(field(1, 2)).bytes(message)
  const payload = encode(response)
  const frame = protobuf.Writer.create().uint32(field(7, 2)).string(type)
    .uint32(field(8, 2)).bytes(gzip ? gzipSync(payload) : payload)
  return encode(frame).toString('base64')
}

test('解析直播连接中的进房消息，过滤历史消息和非进房动作', () => {
  const now = 1800000000000
  const data = makeFrame([
    wrap('WebcastChatMessage', member()),
    wrap('WebcastMemberMessage', member({ user: '路过的朋友', created: now / 1000 })),
    wrap('WebcastMemberMessage', member({ user: '旧观众', created: now / 1000 - 30 })),
    wrap('WebcastMemberMessage', member({ user: '非进房动作', action: 3, created: now / 1000 })),
    wrap('WebcastMemberMessage', Buffer.from([0xff])),
  ])
  assert.deepEqual(decodeLiveEvents(data, now), [{ kind: 'join', user: '路过的朋友', id: '7681626144000791846', timestamp: now }])
  assert.equal(decodeLiveEvents(makeFrame([wrap('WebcastMemberMessage', member())], { gzip: false })).length, 1)
  assert.deepEqual(decodeLiveEvents(makeFrame([], { type: 'hb' })), [])
  assert.deepEqual(decodeLiveEvents('not-a-protobuf-frame'), [])
})

test('只有结构化礼物消息会识别送礼，普通聊天文字不会触发', () => {
  const now = 1800000000000
  const data = makeFrame([
    wrap('WebcastChatMessage', gift({ name: '小心心', count: 9999 })),
    wrap('WebcastGiftMessage', gift({ name: '玫瑰', count: 2, created: now / 1000 })),
  ])
  const [event] = decodeLiveEvents(data, now)
  assert.equal(event.kind, 'gift')
  assert.equal(event.user, '小鹿')
  assert.equal(event.gift, '玫瑰')
  assert.equal(event.count, 2)
  assert.equal(event.unitValue, 1)
  assert.ok(event.group)
  assert.equal(decodeLiveEvents(data, now).length, 1)
})

test('只把关注动作识别为关注，分享和历史消息不计入', () => {
  const now = 1800000000000
  const data = makeFrame([
    wrap('WebcastSocialMessage', social({ user: '新粉丝', action: 1, created: now / 1000 })),
    wrap('WebcastSocialMessage', social({ user: '分享者', action: 3, created: now / 1000 })),
    wrap('WebcastSocialMessage', social({ user: '其他动作', action: 2, created: now / 1000 })),
    wrap('WebcastSocialMessage', social({ user: '旧关注', action: 1, created: now / 1000 - 30 })),
  ])
  assert.deepEqual(decodeLiveEvents(data, now), [{ kind: 'follow', user: '新粉丝', id: '7681626144000791846', timestamp: now }])
})

test('只观察抖音直播消息连接，关闭后不再分发，不能接管已有调试会话', async () => {
  class Debugger extends EventEmitter {
    attached = false
    isAttached() { return this.attached }
    attach() { this.attached = true }
    detach() { this.attached = false }
    async sendCommand(command) { assert.equal(command, 'Network.enable') }
  }
  const session = new Debugger()
  const captured = []
  const stop = await observeLiveEvents({ debugger: session }, entry => captured.push(entry), 0)
  session.emit('message', {}, 'Network.webSocketCreated', { requestId: 'other', url: 'wss://example.com/webcast/im/push/v2/' })
  session.emit('message', {}, 'Network.webSocketCreated', { requestId: 'live', url: 'wss://webcast.douyin.com/webcast/im/push/v2/' })
  const payload = makeFrame([wrap('WebcastMemberMessage', member())])
  session.emit('message', {}, 'Network.webSocketFrameReceived', { requestId: 'other', response: { opcode: 2, payloadData: payload } })
  session.emit('message', {}, 'Network.webSocketFrameReceived', { requestId: 'live', response: { opcode: 1, payloadData: payload } })
  session.emit('message', {}, 'Network.webSocketFrameReceived', { requestId: 'live', response: { opcode: 2, payloadData: payload } })
  assert.equal(captured.length, 1)
  stop()
  assert.equal(session.isAttached(), false)
  session.emit('message', {}, 'Network.webSocketFrameReceived', { requestId: 'live', response: { opcode: 2, payloadData: payload } })
  assert.equal(captured.length, 1)
  session.attach()
  const stopOther = await observeLiveEvents({ debugger: session }, () => assert.fail('已有调试会话不能接管'))
  stopOther()
  assert.equal(session.isAttached(), true)
  const unavailable = new Debugger()
  unavailable.sendCommand = async () => { throw new Error('页面不可用') }
  const stopUnavailable = await observeLiveEvents({ debugger: unavailable }, () => assert.fail('监听失败不能分发'))
  stopUnavailable()
  assert.equal(unavailable.isAttached(), false, '监听失败时释放自己创建的调试会话')
})

test('同一礼物连击只发送数量增量，重复帧和结束帧不会再次触发', async () => {
  class Debugger extends EventEmitter {
    attached = false
    isAttached() { return this.attached }
    attach() { this.attached = true }
    detach() { this.attached = false }
    async sendCommand() {}
  }
  const session = new Debugger()
  const events = []
  const stop = await observeLiveEvents({ debugger: session }, event => events.push(event), 0)
  session.emit('message', {}, 'Network.webSocketCreated', { requestId: 'live', url: 'wss://webcast.douyin.com/webcast/im/push/v2/' })
  for (const [count, end] of [[1, 0], [2, 0], [2, 1], [3, 1]]) {
    const payloadData = makeFrame([wrap('WebcastGiftMessage', gift({ count, end }))])
    session.emit('message', {}, 'Network.webSocketFrameReceived', { requestId: 'live', response: { opcode: 2, payloadData } })
  }
  assert.deepEqual(events.map(event => event.count), [1, 1, 1])
  assert.equal(new Set(events.map(event => event.group)).size, 1)
  assert.equal(new Set(events.map(event => event.id)).size, 3)
  stop()
})
