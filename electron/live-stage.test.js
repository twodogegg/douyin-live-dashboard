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
  stage.observe({ type: 'r2', id: 2, user: '观众', text: '新房间' })
  assert.equal(calls, 1)
  finish('旧回复')
  await flush()
  assert.equal(calls, 2)
  finish('新回复')
  await flush()
  assert.deepEqual(events.filter(event => event.type === 'stage_reply').map(event => event.text), ['新回复'])
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

test('进房与关注独立去重计数，不触发 AI；暂停保留，切换房间清零', async t => {
  let calls = 0
  const { stage } = fixture(t, { chat: async () => { calls++; return '你好' } })
  stage.configure({ enabled: true })
  stage.observe({ type: 'stat', room_id: '1234' })
  const event = { type: 'room_event', id: 'a', kind: 'join', user: '海盐', time: '10:00:00' }
  stage.observe(event)
  stage.observe(event)
  stage.observe({ ...event, id: 'b', kind: 'follow' })
  stage.observe({ ...event, id: 'c', kind: 'unknown' })
  stage.observe({ ...event, id: 'd', user: '' })
  stage.configure({ enabled: false })
  assert.equal(stage.snapshot().activity.joins, 1)
  assert.equal(stage.snapshot().activity.follows, 1)
  assert.equal(stage.snapshot().activity.events.length, 2)
  assert.equal(calls, 0)
  const copy = stage.snapshot()
  copy.activity.events.pop()
  assert.equal(stage.snapshot().activity.events.length, 2)
  stage.observe({ type: 'stat', room_id: '5678' })
  assert.deepEqual(stage.snapshot().activity, { joins: 0, follows: 0, events: [] })
})
