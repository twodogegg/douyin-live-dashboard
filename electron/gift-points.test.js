import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoomEvent, eventPriority, mergeGift, giftValue } from './gift-points.js'

test('礼物：识别送出与数量', () => {
  const event = parseRoomEvent('海盐汽水 送出了 小心心 ×5')
  assert.equal(event.kind, 'gift')
  assert.equal(event.user, '海盐汽水')
  assert.equal(event.gift, '小心心')
  assert.equal(event.count, 5)
  assert.equal(event.value, 5)

  const single = parseRoomEvent('小鹿 送给主播 嘉年华')
  assert.equal(single.gift, '嘉年华')
  assert.equal(single.count, 1)
  assert.equal(single.value, 30000)
})

test('礼物：页面单独取到昵称时优先使用', () => {
  // 页面上昵称是独立节点时，文案里可能只剩事件短语。
  const event = parseRoomEvent('阿青 送出了 玫瑰', { user: '阿青' })
  assert.equal(event.user, '阿青')
  assert.equal(event.gift, '玫瑰')
})

test('关注与进房：不会被普通聊天误判', () => {
  assert.equal(parseRoomEvent('小鹿 关注了主播')?.kind, 'follow')
  assert.equal(parseRoomEvent('海盐 进入了直播间')?.kind, 'join')
  // 普通聊天里提到「关注了主播」不算事件：必须以昵称开头。
  assert.equal(parseRoomEvent('我觉得她刚才关注了主播吧'), null)
  assert.equal(parseRoomEvent(''), null)
  assert.equal(parseRoomEvent('今天天气不错'), null)
})

test('价值档位决定优先级：大礼物可以打断普通聊天', () => {
  // 小心心(1) < 热气球(520) < 火箭(3000)，三档优先级递增。
  const heart = parseRoomEvent('甲 送出了 小心心 ×1')
  const planet = parseRoomEvent('乙 送出了 热气球 ×1')
  const rocket = parseRoomEvent('丙 送出了 火箭 ×1')
  assert.equal(eventPriority(heart), 20)
  assert.equal(eventPriority(planet), 30)
  assert.equal(eventPriority(rocket), 40)
  assert.equal(eventPriority(null), 0)
  assert.ok(eventPriority({ kind: 'join' }) < eventPriority({ kind: 'follow' }))
})

test('未知礼物按 1 计算，仍然感谢但不触发聚光', () => {
  const event = parseRoomEvent('路人 送出了 某个新礼物 ×3')
  assert.equal(event.gift, '某个新礼物')
  assert.equal(event.count, 3)
  assert.equal(event.value, 3)
  assert.ok(eventPriority(event) < 30)
  assert.equal(giftValue('嘉年华'), 30000)
})

test('连刷合并：同一观众同一礼物在时间窗内累加', () => {
  const first = { kind: 'gift', user: '海盐', gift: '小心心', count: 1, value: 1, last_ts: 1000 }
  const merged = mergeGift(first, { kind: 'gift', user: '海盐', gift: '小心心', count: 2, value: 2 }, 2000)
  assert.equal(merged.count, 3)
  assert.equal(merged.value, 3)
  assert.equal(mergeGift(first, { kind: 'gift', user: '海盐', gift: '小心心', count: 1 }, 9000), null, '超出时间窗不合并')
  assert.equal(mergeGift(first, { kind: 'gift', user: '小鹿', gift: '小心心', count: 1 }, 1500), null, '不同观众不合并')
  assert.equal(mergeGift(first, { kind: 'gift', user: '海盐', gift: '玫瑰', count: 1 }, 1500), null, '不同礼物不合并')
})
