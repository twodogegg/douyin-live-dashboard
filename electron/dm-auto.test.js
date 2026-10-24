import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DmAutoReply } from './dm-auto.js'

function setup() {
  let now = 100000
  const conf = { enabled: true, reply_delay: 5, reply_interval: 30, global_interval: 3 }
  const states = new Map()
  const sent = []
  const read = []
  const summarized = []
  const memory = id => {
    if (!states.has(id)) states.set(id, { blocked: 0, last_reply_at: 0 })
    return states.get(id)
  }
  const io = {
    now: () => now, config: () => conf, running: () => true, hasKey: () => true,
    conv: id => ({ id, is_group: id === 'group' }), memory,
    read: async id => read.push(id), error: message => assert.fail(message),
    summarize: async id => { summarized.push(id); return false },
    reply: async (id, valid) => {
      if (!valid()) return
      sent.push(id)
      memory(id).last_reply_at = now
      auto.lastSend = now
    },
  }
  const auto = new DmAutoReply(io)
  const scan = (id = 'a', text = '新消息', direction = 'in', inserted = true, kind = 'text') => {
    const m = { key: `${id}:${text}`, conv_id: id, ts: now / 1000, text, direction, kind }
    auto.observe({ active_id: id, conversations: [], messages: [m] }, inserted ? [m] : [])
  }
  return { auto, io, conf, sent, read, summarized, memory, scan, advance: ms => { now += ms } }
}

test('启动只建基线，不回复历史；新消息合并等待且重复扫描不延长等待', async () => {
  const s = setup()
  s.scan('a', '历史')
  s.advance(5000)
  await s.auto.tick()
  assert.deepEqual(s.sent, [])
  s.scan('a', '你好')
  s.advance(4000)
  s.scan('a', '再问一件事')
  s.advance(4000)
  s.scan('a', '再问一件事', 'in', false)
  await s.auto.tick()
  assert.deepEqual(s.sent, [])
  s.advance(1000)
  await s.auto.tick()
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a'])
})

test('同一会话冷却期间保留新消息，不影响其它会话；全局发送间隔生效', async () => {
  const s = setup()
  s.scan('a', '历史')
  s.scan('b', '历史')
  s.scan('a', '问题1')
  s.scan('b', '问题1')
  s.advance(5000)
  await s.auto.tick()
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a'])
  s.scan('a', '问题2')
  s.advance(3000)
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a', 'b'])
  s.advance(26999)
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a', 'b'])
  s.advance(1)
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a', 'b', 'a'])
})

test('名单与群聊不自动回复；非当前会话的新未读消息仍读取以保存记忆', async () => {
  const s = setup()
  s.auto.observe({ conversations: [], messages: [] }, [])
  s.memory('blocked').blocked = 1
  s.auto.observe({ conversations: [
    { id: 'blocked', unread: 1, preview: '消息' },
    { id: 'group', unread: 1, preview: '消息' },
    { id: 'normal', unread: 1, preview: '消息' },
  ] }, [])
  s.advance(5000)
  await s.auto.tick()
  assert.deepEqual(s.sent, ['normal'])
  await s.auto.tick()
  assert.ok(s.read.includes('blocked'))
})

test('排队后加入名单或人工回复会取消发送，移出名单不补发旧任务', async () => {
  const s = setup()
  s.scan('a', '历史')
  s.scan('a', '问题')
  s.memory('a').blocked = 1
  s.advance(5000)
  await s.auto.tick()
  s.memory('a').blocked = 0
  await s.auto.tick()
  assert.deepEqual(s.sent, [])
  s.scan('a', '新问题')
  s.scan('a', '我已回复', 'out')
  s.advance(5000)
  await s.auto.tick()
  assert.deepEqual(s.sent, [])
})

test('生成期间关闭开关、人工接管或新消息均使旧任务失效；新消息任务保留', async () => {
  for (const change of ['disable', 'manual', 'new']) {
    const s = setup()
    s.scan('a', '历史')
    s.scan('a', '问题')
    s.io.reply = async (_id, valid) => {
      assert.equal(valid(), true)
      if (change === 'disable') s.conf.enabled = false
      if (change === 'manual') s.auto.cancel('a')
      if (change === 'new') s.scan('a', '补充问题')
      assert.equal(valid(), false)
    }
    s.advance(5000)
    await s.auto.tick()
    assert.equal(s.auto.pending.has('a'), change === 'new')
  }
})

test('自动回复关闭时仍按会话更新记忆，失败后退避重试', async () => {
  const s = setup()
  s.conf.enabled = false
  s.scan('a', '历史')
  s.scan('b', '历史')
  let calls = 0
  s.io.error = () => {}
  s.io.summarize = async id => {
    if (id === 'a' && calls++ === 0) throw new Error('暂时不可用')
    s.summarized.push(id)
    return false
  }
  s.advance(5000)
  await s.auto.tick()
  await s.auto.tick()
  assert.deepEqual(s.summarized, ['b'])
  s.advance(60000)
  await s.auto.tick()
  assert.deepEqual(s.summarized, ['b', 'a'])
  assert.deepEqual(s.sent, [])
})

test('每隔一两秒发来的消息以最后一条为起点，安静五秒后只回复一次', async () => {
  const s = setup()
  s.scan('a', '历史')
  for (let i = 0; i < 6; i++) {
    s.scan('a', `连续消息${i}`)
    s.advance(i % 2 ? 2000 : 1000)
    await s.auto.tick()
    assert.deepEqual(s.sent, [])
  }
  s.advance(2999)
  await s.auto.tick()
  assert.deepEqual(s.sent, [])
  s.advance(1)
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a'])
})

test('发送前图片暂未加载时保留任务，退避重试后仅发送一次', async () => {
  const s = setup()
  s.scan('a', '历史')
  s.scan('a', '新图片')
  let attempts = 0
  const reply = s.io.reply
  s.io.reply = async (id, valid) => {
    if (++attempts < 3) return { retry: true }
    return reply(id, valid)
  }
  s.advance(5000)
  await s.auto.tick()
  assert.equal(s.auto.pending.has('a'), true)
  s.advance(4999)
  await s.auto.tick()
  assert.equal(attempts, 1)
  s.advance(1)
  await s.auto.tick()
  s.advance(10000)
  await s.auto.tick()
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a'])
  assert.equal(attempts, 3)
})

test('最多重试三次，人工接管和新消息仍可替换失败任务', async () => {
  const s = setup()
  s.scan('a', '历史')
  s.scan('a', '图片')
  const errors = []
  let attempts = 0
  s.io.error = message => errors.push(message)
  s.io.reply = async () => { attempts++; return { retry: true, msg: '图片未加载' } }
  for (let i=0; i<5; i++) { s.advance(20000); await s.auto.tick() }
  assert.equal(attempts, 4)
  assert.equal(s.auto.pending.has('a'), false)
  assert.match(errors[0], /重试 3 次/)
  s.scan('a', '新图片')
  assert.equal(s.auto.pending.get('a').retries, undefined)
  s.auto.cancel('a')
  s.advance(20000)
  await s.auto.tick()
  assert.equal(attempts, 4)
})

test('协议作为触发链路时浏览器仅补偿历史，不能产生第二个自动回复任务', async () => {
  const s = setup()
  s.auto.observe({ conversations: [], messages: [] }, [], false)
  const m = { key: 'a:m:1', conv_id: 'a', direction: 'in', ts: 100, text: '你好' }
  s.auto.observe({ active_id: 'a', conversations: [{ id: 'other', unread: 1, preview: '历史补偿' }], messages: [m] }, [m], false)
  s.advance(10000)
  await s.auto.tick()
  assert.deepEqual(s.sent, [])
  assert.ok(s.read.includes('other'))
  s.auto.enqueue('a', 110000)
  s.advance(5000)
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a'])
})

test('结果不确定的发送不会因重试或重新开启自动回复而重复执行', async () => {
  const s = setup()
  s.scan('a', '历史')
  s.scan('a', '新问题')
  s.memory('a').send_outcome = 'unknown'
  s.advance(10000)
  await s.auto.tick()
  s.auto.reset()
  s.scan('a', '新问题')
  s.scan('a', '另一条新问题')
  s.advance(10000)
  await s.auto.tick()
  assert.deepEqual(s.sent, [])
})


test('正在等待回执时的新消息仍替换任务，结果不确定才暂停后续发送', async () => {
  const s = setup()
  s.scan('a', '历史')
  s.scan('a', '第一轮')
  s.memory('a').send_outcome = 'pending'
  s.scan('a', '发送期间的新消息')
  s.memory('a').send_outcome = 'confirmed'
  s.advance(5000)
  await s.auto.tick()
  assert.deepEqual(s.sent, ['a'])
})

test('视频和分享卡片不触发回复，也不会清掉前面待回的文本', async () => {
  const s = setup()
  s.scan('a', '启动基线')
  s.advance(6000)
  await s.auto.tick()
  s.scan('a', '在吗', 'in', true, 'text')
  s.advance(1000)
  // 文本之后紧接着来一条视频和一张卡片
  s.scan('a', '[视频]', 'in', true, 'video')
  s.advance(1000)
  s.scan('a', '[卡片]', 'in', true, 'note')
  s.advance(6000)
  await s.auto.tick()
  // 仍然只回复一次，且是那条文本触发的
  assert.equal(s.sent.filter(id => id === 'a').length, 1)
  // 视频本身不会再排一个任务
  s.advance(6000)
  await s.auto.tick()
  assert.equal(s.sent.filter(id => id === 'a').length, 1)
})
