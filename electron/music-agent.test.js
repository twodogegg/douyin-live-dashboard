import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMusicAgent } from './music-agent.js'

function configFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-agent-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'music_agent.json')
}

test('提示词和工具说明从独立配置读取，修改即时生效且重建不会覆盖', async t => {
  const file = configFile(t)
  const calls = []
  const usage = []
  const chat = async (messages, options) => {
    calls.push({ messages, options })
    const name = options.tools[0].function.name
    return { usage: { total_tokens: 12 }, choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(name === 'request_song' ? { name: '稻香', artist: '' } : { index: 1 }) } }] } }] }
  }
  const agent = createMusicAgent({ file, chat, onUsage: value => usage.push(value) })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  config.recognize.system_prompt = '测试识别规则'
  config.recognize.tool_description = '测试工具说明'
  config.select.system_prompt = '测试选曲规则'
  config.select.temperature = 0.2
  config.host_context = '测试主播上下文 {{music_status}}'
  fs.writeFileSync(file, JSON.stringify(config))
  assert.deepEqual(await agent.parse({ text: '点歌 稻香' }), { name: '稻香', artist: '' })
  assert.equal(calls[0].messages[0].content, '测试识别规则')
  assert.equal(calls[0].options.tools[0].function.description, '测试工具说明')
  const candidates = [{ id: 11, name: '稻香', artists: ['甲'], album: '原版' }, { id: 12, name: '稻香', artists: ['乙'], album: '翻唱' }]
  assert.equal(await agent.select({ message: { text: '点歌 稻香' }, request: { name: '稻香', artist: '' }, candidates }), 1)
  assert.equal(calls[1].messages[0].content, '测试选曲规则')
  assert.equal(calls[1].options.temperature, 0.2)
  assert.equal(calls[1].options.tools[0].function.parameters.properties.index.maximum, 1)
  assert.equal(JSON.parse(calls[1].messages[1].content).candidates[1].album, '翻唱')
  assert.equal(usage.length, 2)
  assert.equal(createMusicAgent({ file, chat }).context(), config.host_context)
})

test('配置损坏或提示词为空时明确报错，不使用代码内置提示词兜底', async t => {
  const file = configFile(t)
  let calls = 0
  const agent = createMusicAgent({ file, chat: async () => { calls++ } })
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  config.select.system_prompt = ''
  fs.writeFileSync(file, JSON.stringify(config))
  await assert.rejects(agent.parse({ text: '点歌 稻香' }), /提示词不能为空/)
  fs.writeFileSync(file, '{')
  await assert.rejects(agent.parse({ text: '点歌 稻香' }), SyntaxError)
  assert.equal(calls, 0)
})
