import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initCapabilities, listSkills, skillInstructions, normalizeCapabilities, validateCapabilities, TOOL_DEFINITIONS } from './capabilities.js'
import { runAgent } from './agent-runtime.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dy-capability-'))
}

test('内置 Skill 首次启动复制到用户目录，目录型和单文件型都能列出并按勾选注入指令', () => {
  const builtin = tempDir()
  const custom = tempDir()
  fs.writeFileSync(path.join(builtin, 'builtin-image-prompt.md'), '---\nname: builtin-image-prompt\ntitle: 生图提示词\ndescription: 内置\n---\n内置正文')
  fs.mkdirSync(path.join(custom, 'my-folder'))
  fs.writeFileSync(path.join(custom, 'my-folder', 'SKILL.md'), '---\nname: my-skill\ntitle: 我的技能\ndescription: 自定义\n---\n自定义正文')

  initCapabilities({ builtinDirectory: builtin, customDirectory: custom })
  const skills = listSkills()
  assert.deepEqual(skills.map(s => s.id).sort(), ['builtin-image-prompt', 'my-skill'])
  assert.equal(skills.find(s => s.id === 'my-skill').scope, 'custom')

  const injected = skillInstructions(['my-skill'])
  assert.match(injected, /我的技能/)
  assert.match(injected, /自定义正文/)
  assert.equal(skillInstructions(['builtin-image-prompt']).includes('内置正文'), true)
  assert.equal(skillInstructions([]), '')
})

test('工具与 Skills 勾选校验拒绝未知 ID，生图参数有默认值且旧配置可无损升级', () => {
  const ids = new Set(['skill-a'])
  assert.equal(validateCapabilities({ tools: ['read_history'], skills: ['skill-a'], image_model: 'gpt-image-1.5', image_size: 'auto', image_quality: 'high' }, ids), null)
  assert.match(validateCapabilities({ tools: ['hack'], skills: [], image_model: 'm', image_size: 'auto', image_quality: 'auto' }, ids), /工具选择无效/)
  assert.match(validateCapabilities({ tools: [], skills: ['missing'], image_model: 'm', image_size: 'auto', image_quality: 'auto' }, ids), /Skills 选择无效/)
  assert.match(validateCapabilities({ tools: [], skills: [], image_model: 'm', image_size: '999x999', image_quality: 'auto' }, ids), /图片尺寸无效/)

  const normalized = normalizeCapabilities({})
  assert.deepEqual(normalized.tools, [])
  assert.equal(normalized.image_model, 'gpt-image-2.5-flare')
  assert.equal(normalized.image_size, '1024x1024')
  assert.equal(normalized.image_quality, 'medium')
})

test('runAgent 只把勾选工具发给模型，逐个执行调用并返回最终正文', async () => {
  const tool = TOOL_DEFINITIONS.find(t => t.id === 'read_history')
  const callsSeen = []
  const result = await runAgent({
    messages: [{ role: 'user', content: '查一下历史' }],
    config: { tools: ['read_history'] },
    agents: ['dm'],
    maxSteps: 2,
    request: async (messages, tools) => {
      callsSeen.push(tools)
      if (messages.length === 1) {
        return { choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_history', arguments: '{"limit":20}' } }] } }] }
      }
      return { choices: [{ message: { content: '这是最终回复' } }] }
    },
    execute: async (name, args) => {
      assert.equal(name, 'read_history')
      assert.equal(args.limit, 20)
      return { ok: true, messages: [] }
    },
  })
  assert.equal(result.text, '这是最终回复')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].name, 'read_history')
  assert.deepEqual(callsSeen[0], [tool.definition])
  assert.equal(callsSeen.length, 2)
  // 工具结果以 tool 消息回填，模型下一轮能看到
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 1)
})

test('未授权工具调用会被拒绝，不会执行', async () => {
  await assert.rejects(runAgent({
    messages: [{ role: 'user', content: 'x' }],
    config: { tools: ['read_history'] },
    agents: ['dm'],
    request: async () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'generate_image', arguments: '{}' } }] } }] }),
    execute: async () => { throw new Error('不应执行') },
  }), /未授权的工具/)
})

test('按 Agent 过滤工具目录：live 只能看到生图，看不到私信专属工具', () => {
  const liveTools = TOOL_DEFINITIONS.filter(t => t.agents.includes('live'))
  assert.deepEqual(liveTools.map(t => t.id), ['generate_image'])
  const dmTools = TOOL_DEFINITIONS.filter(t => t.agents.includes('dm'))
  assert.deepEqual(dmTools.map(t => t.id), ['read_history', 'read_contact', 'generate_image'])
})
