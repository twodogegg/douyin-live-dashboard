import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmedOutgoing } from './dm-delivery.js'

const message = patch => ({ source_id: 'new', client_id: 'new-client', direction: 'out', server_confirmed: true, text: '相同回复', ts: 100, ...patch })
const scan = messages => ({ ok: true, active_id: 'a', messages })

test('历史同文、对方复读、临时消息和其它会话不能被当作发送成功', () => {
  const before = scan([message({ source_id: 'old', client_id: 'old-client', ts: 90 })])
  assert.equal(confirmedOutgoing(before, before, '相同回复', 100000), null)
  assert.equal(confirmedOutgoing(before, scan([message({ direction: 'in' })]), '相同回复', 100000), null)
  assert.equal(confirmedOutgoing(before, scan([message({ server_confirmed: false })]), '相同回复', 100000), null)
  assert.equal(confirmedOutgoing(before, scan([message({ ts: 1 })]), '相同回复', 100000), null)
  assert.equal(confirmedOutgoing(before, { ...scan([message()]), active_id: 'b' }, '相同回复', 100000), null)
  assert.equal(confirmedOutgoing(before, scan([message({ client_id: 'old-client' })]), '相同回复', 100000), null)
})

test('相同文字的新服务端消息可以确认，新的消息 ID 不按文本合并', () => {
  const before = scan([message({ source_id: 'old', client_id: 'old-client', ts: 90 })])
  const current = message()
  assert.equal(confirmedOutgoing(before, scan([current]), '相同回复', 100000), current)
})

test('原生只发出首段时自动确认实际回执，并明确区分部分发送', () => {
  const receipt = confirmedOutgoing(scan([]), scan([message({ text: '第一段' })]), '第一段\n\n第二段', 100000)
  assert.equal(receipt.source_id, 'new')
  assert.equal(receipt.partial, true)
  assert.equal(confirmedOutgoing(scan([]), scan([message({ text: '第一' })]), '第一段\n\n第二段', 100000), null)
})
