import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanReply, conversationMessages, DEFAULT_AGENT_RULES, replyPrompt } from './dm-context.js'

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
