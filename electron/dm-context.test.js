import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanReply, conversationMessages, DEFAULT_AGENT_RULES, replyPrompt, timeContext, parseMemory } from './dm-context.js'

test('文字和图片按原始顺序组成独立消息，原图直接传入同一次对话', async () => {
  const loaded = []
  const messages = await conversationMessages([
    { direction: 'out', kind: 'text', text: '发来看看' },
    { key: 'a', direction: 'in', kind: 'image', image_description: '不应使用旧的识图描述' },
    { direction: 'in', kind: 'text', text: '你觉得怎么样' },
    { key: 'b', direction: 'in', kind: 'image' },
  ], async message => { loaded.push(message.key); return `data:image/png;base64,${message.key}` })
  assert.deepEqual(messages, [
    { role: 'assistant', content: '发来看看' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,a' } }] },
    { role: 'user', content: '你觉得怎么样' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,b' } }] },
  ])
  assert.deepEqual(loaded, ['a', 'b'])
})

test('只有一张图片时，也是一条完整的 user 图片消息', async () => {
  const messages = await conversationMessages([{ key: 'a', direction: 'in', kind: 'image' }], async () => 'data:image/jpeg;base64,abc')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content[0].type, 'image_url')
})

test('读取失败或缺少原图时明确失败，不能用图片占位符代替原图', async () => {
  const rows = [{ direction: 'in', kind: 'image' }]
  await assert.rejects(conversationMessages(rows, async () => { throw new Error('原图未加载') }), /原图未加载/)
  await assert.rejects(conversationMessages(rows, async () => ''), /没有可读取的原图/)
})

test('内部处理信息不能作为回复正文发送，自然聊天内容可正常输出', () => {
  assert.ok(replyPrompt('你是小禾').includes('你是小禾'))
  for (const text of ['已收到图片，内容：动漫人物', '图片识别结果是一个女孩', '图片参考资料：猫']) assert.throws(() => cleanReply(text), /取消发送/)
  assert.equal(cleanReply('“橙色头发的动漫女孩呀，这张好有动感！”'), '橙色头发的动漫女孩呀，这张好有动感！')
})

test('角色设定与功能规则分别传入，兼容只提供角色的旧配置', () => {
  const legacy = replyPrompt('你是小禾，说话简短')
  assert.ok(legacy.includes(DEFAULT_AGENT_RULES))
  assert.ok(legacy.includes('# 角色设定\n你是小禾，说话简短'))
  const edited = replyPrompt('你是小禾，说话简短', '只回答当前会话的问题')
  assert.ok(edited.includes('# Agent 功能规则\n只回答当前会话的问题'))
  assert.ok(edited.includes('# 角色设定\n你是小禾，说话简短'))
  assert.ok(!edited.includes(DEFAULT_AGENT_RULES))
})

test('语音转写复用缓存，识别失败不得用占位符继续聊天', async () => {
  let calls = 0
  const messages = await conversationMessages([
    { kind: 'audio', direction: 'in', transcript: '昨天说过了' },
    { kind: 'text', direction: 'out', text: '记得的' },
    { kind: 'audio', direction: 'in' },
  ], null, async () => { calls++; return '[高兴] 明天见' })
  assert.equal(calls, 1)
  assert.ok(messages[0].content.includes('昨天说过了'))
  assert.ok(messages[2].content.includes('[高兴] 明天见'))
  await assert.rejects(conversationMessages([{ kind: 'audio' }], null), /尚未识别/)
})

test('跨日时间固定北京时间并关联原消息，画像必须保留依据且校验失败不吞错', () => {
  const context = timeContext([{ ts: Date.parse('2026-10-22T15:50:00Z') / 1000, direction: 'in' }], new Date('2026-10-22T16:05:00Z'))
  assert.ok(context.includes('2026年10月23日'))
  assert.ok(context.includes('2026年10月22日'))
  assert.ok(context.includes('00:05:00'))
  assert.ok(context.includes('23:50:00'))
  const profile = { facts: [], preferences: [{ text: '喜欢温柔的人', evidence: '我喜欢温柔的', updated_at: '2026-10-22' }], inferences: [] }
  assert.deepEqual(JSON.parse(parseMemory(JSON.stringify({ summary: '聊了相处方式', profile })).profile), profile)
  assert.throws(() => parseMemory('{"summary":"不完整"}'), /不完整/)
  assert.throws(() => parseMemory('{"summary":"摘要","profile":{"facts":[{}],"preferences":[],"inferences":[]}}'), /依据/)
})


test('人工样例只注入确认后的改写，AI 原稿不作为说话示范', async () => {
  const { contactContext } = await import('./dm-context.js')
  const context = contactContext({ relationship: '朋友', examples: [{ source_key: '1', original: 'AI未确认原稿', reply: '本人改写确认的回复' }] }, () => ({ text: '对方的问题' }))
  assert.match(context, /本人改写确认的回复/)
  assert.match(context, /对方的问题/)
  assert.doesNotMatch(context, /AI未确认原稿|original/)
})
