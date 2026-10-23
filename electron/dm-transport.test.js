import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import * as db from './db.js'
import { DmMessageGateway, MessageComparison } from './dm-transport.js'
afterEach(() => db.closeDb())

test('统一接入层跨来源仅发布一次新增消息，更新事件保留已有媒体和发送者', () => {
  db.initDb(':memory:')
  db.dmUseAccount('100')
  const events = []
  const gateway = new DmMessageGateway({ save: db.dmSaveMsg, read: db.dmGetMsg, publish: event => events.push(event), account: () => '100' })
  const row = { key: 'douyin:100:a:m:1', conv_id: 'douyin:100:a', source_id: '1', direction: 'in', kind: 'image', text: '[图片]', ts: 100, images: ['https://example.com/original'], sender_name: '甲' }
  gateway.receive(row)
  gateway.receive({ ...row, images: [], sender_name: '', media_ref: 'encrypted-ref' })
  assert.deepEqual(events.map(e => e.type), ['dm_msg', 'dm_msg_update'])
  assert.deepEqual(events[1].msg.images, row.images)
  assert.equal(events[1].msg.sender_name, '甲')
  assert.equal(events[1].msg.account_id, '100')
  assert.throws(() => gateway.receive({ ...row, conv_id: 'douyin:200:a' }))
  assert.throws(() => gateway.receive({ ...row, direction: '' }))
})

test('协议对照只按消息身份计数，两条相同文本不互相合并', () => {
  const comparison = new MessageComparison()
  comparison.observe('a:1', 'protocol')
  comparison.observe('a:1', 'protocol')
  comparison.observe('a:1', 'browser')
  comparison.observe('a:2', 'protocol')
  comparison.observe('b:1', 'browser')
  assert.deepEqual(comparison.status(), { protocol: 2, browser: 2, matched: 1 })
})
