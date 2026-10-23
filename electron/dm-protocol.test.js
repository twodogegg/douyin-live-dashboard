import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { gzipSync } from 'node:zlib'
import { decodePush, fields, ProtocolReceiver } from './dm-protocol.js'

const varint = value => {
  let n = BigInt(value)
  const bytes = []
  do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; bytes.push(b) } while (n)
  return Buffer.from(bytes)
}
const field = (id, value) => typeof value === 'number' || typeof value === 'bigint'
  ? Buffer.concat([varint(id * 8), varint(value)])
  : Buffer.concat([varint(id * 8 + 2), varint(Buffer.byteLength(value)), Buffer.from(value)])
const packet = ({ id = 9007199254740993123n, sender = 9007199254740993456n, type = 7, content = { text: '相同内容' }, gzip = false } = {}) => {
  const msg = Buffer.concat([field(1, 'conversation'), field(2, 1), field(3, id), field(6, type), field(7, sender), field(8, JSON.stringify(content)), field(10, 100)])
  const response = field(6, field(500, field(5, msg)))
  return Buffer.concat([field(6, gzip ? 'gzip' : ''), field(7, 'pb'), field(8, gzip ? gzipSync(response) : response)])
}

test('64 位消息与发送者 ID 不丢精度，重复文字保留不同消息身份', () => {
  const a = decodePush(packet(), '100', 100000)
  const b = decodePush(packet({ id: 9007199254740993124n }), '100', 100000)
  assert.equal(a.source_id, '9007199254740993123')
  assert.equal(a.sender_id, '9007199254740993456')
  assert.equal(a.direction, 'in')
  assert.notEqual(a.key, b.key)
  assert.equal(a.text, b.text)
  assert.equal(decodePush(packet(), ''), null)
  assert.equal(decodePush(packet(), a.sender_id).direction, 'out')
})

test('gzip 与媒体消息可解析，协议 CDN 引用不冒充已解密原图', () => {
  assert.equal(decodePush(packet({ gzip: true }), '100').text, '相同内容')
  const image = decodePush(packet({ type: 27, content: { resource_url: { origin_url_list: ['https://encrypted.example/image'] } } }), '100')
  assert.equal(image.kind, 'image')
  assert.equal(image.media_url, undefined)
  assert.equal(image.images, undefined)
  assert.match(image.media_ref, /encrypted/)
  assert.equal(decodePush(packet({ type: 50001 }), '100'), null)
})

test('截断帧、非法 wire type 与越界字段明确失败', () => {
  for (const bad of [[10, 100, 1], [15], [0], [128]]) assert.throws(() => fields(Buffer.from(bad)))
  assert.equal(decodePush(field(7, 'text/json'), '100'), null)
})

test('仅订阅私信 socket；鉴权与 URL 不进入状态事件，停止后不继续订阅', async () => {
  const debug = new EventEmitter()
  debug.isAttached = () => true
  debug.sendCommand = async method => method === 'Network.getResponseBody' ? { body: '{"user_uid":"100"}' } : {}
  const states = [], messages = [], accounts = []
  let reconnected = 0
  const receiver = new ProtocolReceiver({ onMessage: m => messages.push(m), onState: s => states.push(s), onAccount: a => accounts.push(a), onReconnect: () => reconnected++ })
  receiver.attach({ debugger: debug, isDestroyed: () => false })
  receiver.setMode('compare')
  await receiver.handle('Network.webSocketCreated', { requestId: 'live', url: 'wss://webcast.douyin.com/ws?token=secret' })
  await receiver.handle('Network.webSocketCreated', { requestId: 'dm', url: 'wss://frontier-im.douyin.com/ws/v2?token=secret' })
  await receiver.handle('Network.responseReceived', { requestId: 'account', response: { url: 'https://www.douyin.com/aweme/v1/web/query/user/?aid=6383' } })
  await receiver.handle('Network.loadingFinished', { requestId: 'account' })
  await receiver.handle('Network.webSocketHandshakeResponseReceived', { requestId: 'dm', response: { status: 101 } })
  await receiver.handle('Network.webSocketFrameReceived', { requestId: 'live', response: { opcode: 2, payloadData: packet().toString('base64') } })
  await receiver.handle('Network.webSocketFrameReceived', { requestId: 'dm', response: { opcode: 2, payloadData: packet().toString('base64') } })
  assert.deepEqual(accounts, ['100'])
  assert.equal(messages.length, 1)
  assert.equal(reconnected, 1)
  assert.doesNotMatch(JSON.stringify(states), /secret|token|frontier/)
  receiver.stop()
  assert.equal(debug.listenerCount('message'), 0)
  assert.equal(receiver.sockets.size, 0)
})


test('退出登录后迟到的身份查询不能重新激活旧账号', async () => {
  let respond
  const debug = { sendCommand: () => new Promise(resolve => { respond = resolve }) }
  const accounts = []
  const receiver = new ProtocolReceiver({ onAccount: a => accounts.push(a), onState: () => {}, onMessage: () => {}, onReconnect: () => {} })
  receiver.webContents = { debugger: debug }
  receiver.queries.add('old')
  const pending = receiver.handle('Network.loadingFinished', { requestId: 'old' })
  receiver.invalidateIdentity()
  respond({ body: '{"user_uid":"100"}' })
  await pending
  assert.deepEqual(accounts, [''])
  assert.equal(receiver.account, '')
})

test('query/user 参数错误不会误清空已由原生私信确认的账号', async () => {
  const accounts = []
  const receiver = new ProtocolReceiver({ onAccount: a => accounts.push(a), onState: () => {}, onMessage: () => {}, onReconnect: () => {} })
  receiver.confirmAccount('100')
  receiver.webContents = { debugger: { sendCommand: async () => ({ body: '{"status_code":12,"status_msg":"parameter error"}' }) } }
  receiver.queries.add('bad-query')
  await receiver.handle('Network.loadingFinished', { requestId: 'bad-query' })
  assert.equal(receiver.account, '100')
  assert.deepEqual(accounts, ['100'])
})
