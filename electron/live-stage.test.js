import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLiveStage } from './live-stage.js'

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-stage-'))
  const events = []
  const chat = overrides.chat || (async () => '你好呀，今天也要开心！')
  const stage = createLiveStage({
    file: path.join(dir, 'stage.json'),
    broadcast: event => events.push(event),
    readiness: () => ({ ai: true, voice: true }),
    synthesize: async () => ({ url: '/dm/voice/audio/example.mp3' }),
    ...overrides,
    chat: async (...args) => {
      const result = await chat(...args)
      return typeof result === 'string' ? { text: result } : result
    },
  })
  t.after(() => { stage.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { stage, events }
}

const flush = () => new Promise(resolve => setImmediate(resolve))
// 等一拍定时器：调度走 setTimeout，setImmediate 抢在它前面。
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

test('观众消息生成回复及 TTS，摘要不触发主播回复，重复消息只处理一次', async t => {
  let calls = 0
  const { stage, events } = fixture(t, { chat: async messages => {
    calls++
    assert.match(messages[0].content, /小鲸/)
    assert.equal(JSON.parse(messages.at(-1).content).message, '你好')
    return '你好呀！'
  } })
  stage.configure({ enabled: true })
  stage.observe({ type: 'ai', summary: '摘要' })
  const message = { type: 'r2', id: 1, user: '海盐', text: '你好' }
  stage.observe(message)
  await flush()
  stage.observe(message)
  assert.equal(calls, 1)
  assert.equal(events.filter(event => event.type === 'stage_reply').length, 1)
  assert.equal(stage.snapshot().last_reply.audio_url, '/dm/voice/audio/example.mp3')
})

test('暂停或切换房间丢弃尚未完成的旧回复，恢复后仍串行生成', async t => {
  let finish
  let calls = 0
  const { stage, events } = fixture(t, { chat: () => { calls++; return new Promise(resolve => { finish = resolve }) } })
  stage.configure({ enabled: true, voice_enabled: false })
  stage.observe({ type: 'r2', id: 1, user: '观众', text: '旧房间' })
  stage.configure({ enabled: false })
  stage.configure({ enabled: true })
  // 旧任务还没结束：新消息只进未读信箱，不会再起一个并行请求。
  stage.observe({ type: 'r2', id: 2, user: '观众', text: '新房间' })
  assert.equal(calls, 1)
  assert.equal(stage.snapshot().inbox.unread, 1)
  finish('旧回复')
  await flush()
  await tick()
  // 旧回复属于已被重置的 epoch，不会播出；空闲后新消息才串行生成。
  assert.equal(stage.snapshot().last_reply, null)
  assert.equal(calls, 2)
  finish('新回复')
  await flush()
  stage.observe({ type: 'stat', room_id: 'new-room' })
  assert.equal(stage.snapshot().last_reply, null)
})

test('TTS 失败保留文字回复并显示错误；文字模式不调用语音', async t => {
  let calls = 0
  const { stage } = fixture(t, { synthesize: async () => { calls++; throw new Error('音色未就绪') } })
  const reply = await stage.test({ text: '测试' })
  assert.equal(reply.audio_url, '')
  assert.match(reply.audio_error, /音色未就绪/)
  assert.ok(reply.text)
  stage.configure({ voice_enabled: false })
  await stage.test({ text: '只要文字' })
  assert.equal(calls, 1)
})

test('配置校验与模型失败明确返回；缺少配置不能开启自动互动', async t => {
  const { stage } = fixture(t, { readiness: () => ({ ai: false, voice: false }) })
  assert.throws(() => stage.configure({ enabled: true }), /AI/)
  assert.throws(() => stage.configure({ cooldown: 0 }), /间隔/)
  await assert.rejects(stage.test({ text: '' }), /测试消息/)
  await assert.rejects(stage.test({ text: '你好' }), /AI/)
  assert.equal(stage.snapshot().status, 'error')
})

test('主播和系统消息不触发回复，DOM 重建或重新开启互动不重复回复旧弹幕', async t => {
  let calls = 0
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  const { stage } = fixture(t, { chat: async () => { calls++; return '你好' } })
  stage.configure({ enabled: true, voice_enabled: false })
  stage.observe({ type: 'r1', id: 'host:1', user: '主播', text: 'hello' })
  stage.observe({ type: 'r2', id: 1, user: '', text: '平台公告' })
  stage.observe({ type: 'r2', id: 2, user: '观众', text: '你好' })
  await flush()
  assert.equal(calls, 1)
  stage.configure({ enabled: false })
  stage.configure({ enabled: true })
  stage.observe({ type: 'r2', id: 3, user: '观众', text: '你好' })
  await flush()
  assert.equal(calls, 1)
  now += 31000
  stage.observe({ type: 'r2', id: 4, user: '观众', text: '你好' })
  await flush()
  assert.equal(calls, 2)
})

test('token 使用模型返回的用量累计，暂停不清零，缺失用量不估算', async t => {
  let calls = 0
  const { stage } = fixture(t, { chat: async () => ++calls === 1
    ? { text: '你好', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
    : { text: '欢迎' } })
  stage.configure({ voice_enabled: false })
  await stage.test({ text: '测试' })
  stage.configure({ enabled: false })
  await stage.test({ text: '再测试' })
  assert.deepEqual(stage.snapshot().usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, requests: 2, unreported: 1 })
})

test('迟到回复的 token 仍计入消耗，但不会播出', async t => {
  let finish
  const { stage } = fixture(t, { chat: () => new Promise(resolve => { finish = resolve }) })
  stage.configure({ enabled: true, voice_enabled: false })
  stage.observe({ type: 'r2', id: 1, user: '观众', text: '你好' })
  stage.configure({ enabled: false })
  finish({ text: '你好', usage: { prompt_tokens: 10, completion_tokens: 5 } })
  await flush()
  assert.equal(stage.snapshot().usage.total_tokens, 15)
  assert.equal(stage.snapshot().last_reply, null)
})

test('进房与关注独立去重计数，分别触发欢迎回复；暂停保留，切换房间清零', async t => {
  const modes = []
  const { stage } = fixture(t, { chat: async () => { return '欢迎新朋友！' } })
  stage.configure({ enabled: true, voice_enabled: false, welcome_enabled: true })
  stage.observe({ type: 'stat', room_id: '1234' })
  const event = { type: 'room_event', id: 'a', kind: 'join', user: '海盐', time: '10:00:00', text: '海盐 进入了直播间' }
  stage.observe(event)
  stage.observe(event)
  await flush()
  modes.push(stage.snapshot().last_reply?.mode)
  stage.observe({ ...event, id: 'b', kind: 'follow', user: '小鹿', text: '小鹿 关注了主播' })
  await flush()
  modes.push(stage.snapshot().last_reply?.mode)
  stage.observe({ ...event, id: 'c', kind: 'unknown' })
  stage.observe({ ...event, id: 'd', user: '' })
  stage.configure({ enabled: false })
  const activity = stage.snapshot().activity
  assert.equal(activity.joins, 1)
  assert.equal(activity.follows, 1)
  assert.equal(activity.events.length, 2)
  assert.deepEqual(modes, ['welcome', 'follow'])
  // 关闭欢迎后，进房事件只计数不触发回复。
  const before = stage.snapshot().activity.joins
  stage.configure({ enabled: true, welcome_enabled: false })
  stage.observe({ ...event, id: 'e', kind: 'join', user: '路过的', text: '路过的 进入了直播间' })
  await flush()
  assert.equal(stage.snapshot().last_reply, null)
  assert.equal(stage.snapshot().activity.joins, before + 1)
  stage.observe({ type: 'stat', room_id: '5678' })
  assert.deepEqual(stage.snapshot().activity, { joins: 0, follows: 0, gifts: 0, gift_value: 0, events: [] })
})

test('直播连接中的进房事件可使用带标点的昵称，并与页面提示去重', t => {
  const { stage } = fixture(t)
  stage.observe({ type: 'stat', room_id: '1234' })
  stage.observe({ type: 'room_event', id: 'ws:1', source: 'webcast', kind: 'join', user: '小鹿，来了！', text: '小鹿，来了！ 进入了直播间' })
  stage.observe({ type: 'room_event', id: 'ws:1', source: 'webcast', kind: 'join', user: '小鹿，来了！', text: '小鹿，来了！ 进入了直播间' })
  assert.equal(stage.snapshot().activity.joins, 1)
  assert.equal(stage.snapshot().activity.events[0].user, '小鹿，来了！')
  stage.observe({ type: 'room_event', id: 'ws:2', source: 'webcast', kind: 'join', user: '小鹿', text: '小鹿 进入了直播间' })
  stage.observe({ type: 'room_event', id: 'dom:1', kind: 'join', user: '小鹿', text: '小鹿 进入了直播间' })
  assert.equal(stage.snapshot().activity.joins, 2)
  stage.observe({ type: 'room_event', id: 'ws:3', source: 'webcast', kind: 'join', user: '小鹿', text: '小鹿 进入了直播间' })
  assert.equal(stage.snapshot().activity.joins, 3, '不同的直播消息 id 是不同的进房事件')
  stage.observe({ type: 'stat', room_id: '5678' })
  stage.observe({ type: 'room_event', id: 'dom:2', kind: 'join', user: '小鹿', text: '小鹿 进入了直播间' })
  assert.equal(stage.snapshot().activity.joins, 1, '切换房间后不受上一个房间的去重记录影响')
})

test('直播连接中的关注事件计数并与页面提示去重', t => {
  const { stage } = fixture(t)
  stage.observe({ type: 'stat', room_id: '1234' })
  const event = { type: 'room_event', kind: 'follow', user: '新粉丝！', text: '新粉丝！ 关注了主播' }
  stage.observe({ ...event, id: 'ws:1', source: 'webcast' })
  stage.observe({ ...event, id: 'ws:1', source: 'webcast' })
  assert.equal(stage.snapshot().activity.follows, 1)
  stage.observe({ ...event, id: 'ws:2', source: 'webcast', user: '小鹿', text: '小鹿 关注了主播' })
  stage.observe({ ...event, id: 'dom:1', user: '小鹿', text: '小鹿 关注了主播' })
  assert.equal(stage.snapshot().activity.follows, 2)
  assert.equal(stage.snapshot().activity.events.filter(item => item.kind === 'follow').length, 2)
})

test('密集进房全部计数，但欢迎不会连续打断当前回复', async t => {
  let calls = 0
  const { stage } = fixture(t, { chat: async () => { calls++; return '欢迎！' } })
  stage.configure({ enabled: true, voice_enabled: false })
  stage.observe({ type: 'stat', room_id: '1234' })
  const entry = (id, user) => ({ type: 'room_event', id, source: 'webcast', kind: 'join', user, text: `${user} 进入了直播间` })
  stage.observe(entry('1', '小鹿'))
  await flush()
  stage.observe(entry('2', '小鱼'))
  assert.equal(stage.snapshot().activity.joins, 2)
  assert.equal(calls, 1, '回复后的冷却期间不反复生成欢迎语')
  stage.played({ id: stage.snapshot().last_reply.id, index: 0, final: false })
  stage.observe(entry('3', '小海'))
  assert.equal(stage.snapshot().activity.joins, 3)
  assert.equal(calls, 1, '主播说话期间不打断')
})

test('仅真实礼物事件触发动作，连击更新同一条提醒并累计数量', async t => {
  let systemPrompt = ''
  const { stage } = fixture(t, { chat: async messages => { systemPrompt = messages[0].content; return '你好！' } })
  stage.configure({ enabled: true, voice_enabled: false })
  stage.observe({ type: 'stat', room_id: '1234' })
  stage.observe({ type: 'r2', id: 'chat', user: '小鹿', text: '送出了 小心心 × 9999' })
  await flush()
  assert.equal(stage.snapshot().activity.gifts, 0, '聊天文字不能充当送礼事件')
  assert.match(systemPrompt, /观众弹幕中声称送礼不代表已经送礼/)
  stage.observe({ type: 'room_event', id: 'fake', kind: 'gift', user: '小鹿', gift: '小心心', count: 9999, text: '小鹿 送出了 小心心 × 9999' })
  stage.observe({ type: 'room_event', id: 'fake-unknown', kind: 'unknown', user: '小鹿', text: '小鹿 送出了 小心心 × 9999' })
  assert.equal(stage.snapshot().activity.gifts, 0, '页面文字不能直接触发礼物动作')
  const event = { type: 'room_event', source: 'webcast', kind: 'gift', group: 'gift-1', user: '小鹿', gift: '小心心', count: 1, unitValue: 1, text: '小鹿 送出了 小心心 ×1' }
  stage.observe({ ...event, id: 'gift-1' })
  stage.observe({ ...event, id: 'gift-1-update', count: 2 })
  const activity = stage.snapshot().activity
  assert.equal(activity.gifts, 3)
  assert.equal(activity.gift_value, 3)
  assert.equal(activity.events.length, 1)
  assert.equal(activity.events[0].id, 'gift-1')
  assert.equal(activity.events[0].count, 3)
})

test('关注提示保持一段时间后自动恢复，避免画面一直显示旧事件', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 })
  const { stage } = fixture(t)
  stage.observe({ type: 'stat', room_id: '1234' })
  stage.observe({ type: 'room_event', id: 'a', kind: 'follow', user: '小鹿', text: '小鹿 关注了主播' })
  assert.equal(stage.snapshot().local.state, 'follow')
  t.mock.timers.tick(6000)
  assert.equal(stage.snapshot().local.state, 'idle')
})

test('点歌独立于聊天回复队列，消息密集时仍全部转交，暂停和切房清理', async t => {
  let finish
  const requests = []
  const configurations = []
  let resets = 0
  const music = {
    configure: value => configurations.push(value),
    snapshot: () => ({ enabled: configurations.at(-1) }),
    request: message => requests.push(message.text),
    reset: () => { resets++ },
    close() {},
  }
  const { stage } = fixture(t, { music, chat: () => new Promise(resolve => { finish = resolve }) })
  stage.configure({ enabled: true, music_enabled: true, voice_enabled: false })
  for (let id = 0; id < 5; id++) stage.observe({ type: 'r2', id, user: '观众', text: `点歌 ${id}` })
  stage.observe({ type: 'r2', id: 3, user: '观众', text: '点歌 3' })
  assert.equal(requests.length, 5)
  stage.configure({ enabled: false })
  assert.equal(configurations.at(-1), false)
  stage.observe({ type: 'stat', room_id: 'new-room' })
  assert.equal(resets, 1)
  finish('晚到的回复')
  await flush()
})

test('说话窗口内提前生成下一批：当前句播完，下一条回复已经就绪', async t => {
  const batches = []
  let release = null
  const { stage } = fixture(t, { chat: async messages => {
    // 批次可能带一条提示语，取最后一条真正的观众消息。
    const last = JSON.parse([...messages].reverse().find(m => m.role === 'user').content)
    batches.push(last)
    // 第一条立刻返回；第二条挂起，证明它确实是在「说话期间」就被发起的。
    if (batches.length === 1) return '第一句在这里。第二句也在这里。'
    return new Promise(resolve => { release = () => resolve('下一条回复已经准备好了。') })
  } })
  stage.configure({ enabled: true, voice_enabled: false })

  stage.observe({ type: 'r2', id: 1, user: '海盐', text: '你好呀' })
  await tick(20)
  const first = stage.snapshot().last_reply
  assert.equal(first.text, '第一句在这里。第二句也在这里。')
  assert.equal(first.sentences.length, 2)

  // 主播开始说话，观众继续发消息：这些只进未读信箱，不会另起一条回复。
  stage.observe({ type: 'r2', id: 2, user: '小鹿', text: '鲸鲸在吗' })
  stage.observe({ type: 'r2', id: 3, user: '海盐', text: '今天好累' })
  assert.equal(stage.snapshot().inbox.unread, 2)
  assert.equal(batches.length, 1)

  // 第一句播完（还没到最后一句）：说话窗口打开，下一批立刻开始生成。
  stage.played({ id: first.id, index: 0, final: false })
  await tick(20)
  assert.equal(batches.length, 2, '说话期间就已经发出了下一批的生成请求')
  // 第二批的观众消息在说话期间就收集好了：两位观众都在里面。
  assert.deepEqual(batches[1], { viewer: '海盐', message: '今天好累' })

  // 预取结果就绪后，整条播完即可直接接管，不需要再等 cooldown。
  release()
  await tick(20)
  stage.played({ id: first.id, index: 1, final: true })
  await tick(20)
  assert.equal(stage.snapshot().last_reply.text, '下一条回复已经准备好了。')
})

test('未读信箱按观众合并连发，过旧的消息不再回应', async t => {
  let now = 1000000
  t.mock.method(Date, 'now', () => now)
  const { stage } = fixture(t, { chat: async () => '收到' })
  // 先不进房，避免自动回顶把信箱提前抽干。
  stage.configure({ enabled: false, voice_enabled: false })
  stage.observe({ type: 'stat', room_id: '9' })

  // 同一位观众连发两句：合并进同一条信箱记录。
  stage.observe({ type: 'r2', id: 1, user: '海盐', text: '第一句' })
  now += 1000
  stage.observe({ type: 'r2', id: 2, user: '海盐', text: '第二句' })
  assert.equal(stage.snapshot().inbox.unread, 1)

  // 隔了 40 秒再来一条：上一批已过期，不再被当作待回应内容。
  now += 40000
  stage.observe({ type: 'r2', id: 3, user: '小鹿', text: '刚进来的' })
  assert.equal(stage.snapshot().inbox.unread, 2)

  // 开启互动后，只有未过期的 小鹿 那条会被回应。
  let seenText = ''
  const other = fixture(t, { chat: async messages => {
    seenText = JSON.parse([...messages].reverse().find(m => m.role === 'user').content).message
    return '收到'
  } })
  other.stage.configure({ enabled: false, voice_enabled: false })
  other.stage.observe({ type: 'stat', room_id: '9' })
  other.stage.observe({ type: 'r2', id: 1, user: '海盐', text: '很久以前' })
  other.stage.configure({ enabled: true, voice_enabled: false })
  await tick(20)
  assert.equal(seenText, '')
})

test('说话窗口被礼物感谢占用时，空闲后仍会补上预取', async t => {
  const batches = []
  let releaseGift = null
  const { stage } = fixture(t, { chat: async messages => {
    const last = JSON.parse([...messages].reverse().find(m => m.role === 'user').content)
    if (last.event?.kind === 'gift') {
      batches.push({ kind: 'gift' })
      return new Promise(resolve => { releaseGift = () => resolve('谢谢你的礼物，太破费啦。这是第二句。') })
    }
    batches.push({ kind: last.viewer ? 'chat' : 'other' })
    return '这是第一条回复。它有两句话。'
  } })
  stage.configure({ enabled: true, voice_enabled: false })

  stage.observe({ type: 'r2', id: 1, user: '海盐', text: '你好呀' })
  await tick(20)
  const first = stage.snapshot().last_reply
  assert.equal(first.sentences.length, 2)

  // 观众送礼物：感谢开始生成，此时任务槽被占用。
  stage.observe({ type: 'room_event', id: 'g1', source: 'webcast', kind: 'gift', user: '小鹿', gift: '小心心', count: 1, text: '小鹿 送出了 小心心 ×1' })
  await tick(20)

  // 第一句播完，说话窗口打开：因为礼物任务在跑，预取先排队。
  stage.observe({ type: 'r2', id: 2, user: '阿青', text: '那我也来一句' })
  stage.played({ id: first.id, index: 0, final: false })
  await tick(20)
  assert.equal(stage.snapshot().inbox.prefetched, false, '任务槽被礼物占用时不能并行预取')

  // 礼物感谢生成完，说话窗口还在：应当立刻补上下一批的预取。
  releaseGift()
  await tick(20)
  assert.equal(stage.snapshot().inbox.unread, 0, '预取把积压的消息取走了')
})

test('同一观众连刷同一种礼物合并成一次感谢，数量累加', async t => {
  let calls = 0
  let hint = ''
  const { stage } = fixture(t, { chat: async messages => {
    calls++
    const system = [...messages].reverse().find(m => m.role === 'system')
    hint = system?.content || ''
    return '谢谢你！'
  } })
  stage.configure({ enabled: true, voice_enabled: false })
  stage.observe({ type: 'stat', room_id: '1' })
  for (const [i, count] of [[1, 1], [2, 1], [3, 2]]) {
    stage.observe({ type: 'room_event', id: `g${i}`, source: 'webcast', kind: 'gift', user: '海盐', gift: '小心心', count, text: `海盐 送出了 小心心 ×${count}` })
  }
  await tick(20)
  assert.equal(calls, 1, '连刷只触发一次感谢')
  assert.match(hint, /小心心/)
  assert.equal(stage.snapshot().activity.gift_value, 4, '四次礼物的价值仍然累计')
})
