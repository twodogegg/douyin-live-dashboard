import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitSentences, createInbox, formatInbox } from './stage-pipeline.js'

test('句子拆分：按标点断句，过短碎片合并', () => {
  assert.deepEqual(splitSentences('你好呀。今天也要开心！'), ['你好呀。今天也要开心！'])
  assert.deepEqual(
    splitSentences('今天的天气真好呀，我们一起出去走走吧。晚上的风也凉凉的，很适合聊天。'),
    ['今天的天气真好呀，我们一起出去走走吧。', '晚上的风也凉凉的，很适合聊天。'],
  )
  // 只有两个字的短句会跟相邻句合并，避免 TTS 频繁起停。
  assert.deepEqual(splitSentences('嗯。我明白你的意思了。'), ['嗯。我明白你的意思了。'])
  assert.deepEqual(splitSentences(''), [])
  assert.deepEqual(splitSentences('   '), [])
})

test('句子拆分：没有标点的长回复按长度兜底切开', () => {
  const long = '这是一段没有句号的超长内容'.repeat(12)
  const parts = splitSentences(long, { max: 20 })
  assert.ok(parts.length > 1)
  assert.ok(parts.every(part => part.length <= 40))
  assert.ok(parts.length <= 4, '不会碎成太多段')
})

test('未读信箱：同观众合并连发、去重、按上限裁剪', () => {
  const inbox = createInbox({ max: 3 })
  assert.equal(inbox.push({ user: '海盐', text: '你好', now: 1000 }), true)
  assert.equal(inbox.push({ user: '海盐', text: '你好', now: 1100 }), false, '完全相同的内容不重复入箱')
  assert.equal(inbox.push({ user: '海盐', text: '在吗', now: 1200 }), true)
  assert.equal(inbox.size, 1, '同一观众短时间内的连发合并成一条')
  assert.equal(inbox.list()[0].merged, 2)

  inbox.push({ user: '小鹿', text: '一', now: 2000 })
  inbox.push({ user: '阿青', text: '二', now: 3000 })
  inbox.push({ user: '路人', text: '三', now: 4000 })
  assert.equal(inbox.size, 3, '超出上限时丢弃更早的记录')
  assert.deepEqual(inbox.list().map(item => item.user), ['小鹿', '阿青', '路人'])
})

test('未读信箱：drain 返回未过期消息，并统计过期数量', () => {
  const inbox = createInbox()
  inbox.push({ user: '甲', text: '旧的', now: 1000 })
  inbox.push({ user: '乙', text: '新的', now: 50000 })
  const { items, stale } = inbox.drain(50000)
  assert.equal(stale, 1)
  assert.deepEqual(items.map(item => item.user), ['乙'])
  assert.equal(inbox.size, 0, 'drain 之后信箱清空')
})

test('未读信箱：空昵称或空内容不入箱', () => {
  const inbox = createInbox()
  assert.equal(inbox.push({ user: '', text: '内容', now: 1 }), false)
  assert.equal(inbox.push({ user: '观众', text: '   ', now: 1 }), false)
  assert.equal(inbox.size, 0)
})

test('信箱格式化：按观众聚合，保留时间顺序', () => {
  const text = formatInbox([
    { user: '海盐', text: '你好', merged: 1 },
    { user: '小鹿', text: '在吗', merged: 1 },
    { user: '海盐', text: '今天好累', merged: 1 },
  ])
  assert.equal(text, '海盐：你好 / 今天好累\n小鹿：在吗')
  assert.equal(formatInbox([]), '')
})
