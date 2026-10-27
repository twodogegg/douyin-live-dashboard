import fs from 'node:fs'
import path from 'node:path'

export const TOOL_IDS = ['read_history', 'read_contact', 'generate_image']

export const TOOL_DEFINITIONS = [
  {
    id: 'read_history', name: '读取会话记录', description: '按需读取当前会话更多历史消息，补充回复上下文。', risk: 'read', agents: ['dm'],
    definition: { type: 'function', function: { name: 'read_history', description: '读取当前会话的历史文字消息。仅在现有上下文不足时调用。', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 40, description: '读取条数，默认 20' } }, additionalProperties: false } } },
  },
  {
    id: 'read_contact', name: '读取联系人资料', description: '读取当前联系人关系、沟通偏好和人工确认的表达样例。', risk: 'read', agents: ['dm'],
    definition: { type: 'function', function: { name: 'read_contact', description: '读取当前联系人资料和已确认的回复样例。群聊没有独立联系人资料。', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  },
  {
    id: 'generate_image', name: 'AI 生图', description: '按文字描述生成图片，可选择参考最近一张对方图片。', risk: 'write', agents: ['dm', 'live'],
    definition: { type: 'function', function: { name: 'generate_image', description: '用户明确希望获得、绘制或修改图片时生成图片。普通聊天不要调用。生成后仍需用一句自然的话回应，图片由宿主单独展示和发送。', parameters: { type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000, description: '具体、完整的图片生成描述' }, size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'] }, n: { type: 'integer', minimum: 1, maximum: 4 }, use_latest_image: { type: 'boolean', description: '用户要求基于最近一张对方图片修改时为 true' } }, required: ['prompt'], additionalProperties: false } } },
  },
]

export const IMAGE_DEFAULTS = { image_model: 'gpt-image-2.5-flare', image_size: '1024x1024', image_quality: 'medium' }
export const CAPABILITY_DEFAULTS = { tools: [], skills: [], ...IMAGE_DEFAULTS }

function validIds(value, allowed) {
  return Array.isArray(value) && value.length <= allowed.size && value.every(id => typeof id === 'string' && allowed.has(id))
}

export function validateCapabilities(conf, skillIds) {
  if (!validIds(conf.tools, new Set(TOOL_IDS))) return '工具选择无效，请刷新后重试'
  if (!validIds(conf.skills, skillIds)) return 'Skills 选择无效，请刷新后重试'
  if (typeof conf.image_model !== 'string' || !conf.image_model.trim() || conf.image_model.length > 200) return '生图模型名称无效'
  if (!['auto', '1024x1024', '1536x1024', '1024x1536'].includes(conf.image_size)) return '图片尺寸无效'
  if (!['auto', 'low', 'medium', 'high'].includes(conf.image_quality)) return '图片质量无效'
  return null
}

export function normalizeCapabilities(conf = {}) {
  return {
    tools: Array.isArray(conf.tools) ? [...new Set(conf.tools)].filter(id => TOOL_IDS.includes(id)) : [],
    skills: Array.isArray(conf.skills) ? [...new Set(conf.skills)].filter(id => typeof id === 'string') : [],
    image_model: typeof conf.image_model === 'string' && conf.image_model.trim() ? conf.image_model.trim() : IMAGE_DEFAULTS.image_model,
    image_size: IMAGE_DEFAULTS.image_size === conf.image_size || ['auto', '1536x1024', '1024x1536'].includes(conf.image_size) ? conf.image_size : IMAGE_DEFAULTS.image_size,
    image_quality: ['auto', 'low', 'medium', 'high'].includes(conf.image_quality) ? conf.image_quality : IMAGE_DEFAULTS.image_quality,
  }
}

let customDirectory = ''
const skillFiles = new Map()
export function initCapabilities({ builtinDirectory, customDirectory: custom }) {
  customDirectory = custom
  fs.mkdirSync(customDirectory, { recursive: true })
  for (const name of fs.readdirSync(builtinDirectory)) {
    const source = path.join(builtinDirectory, name)
    if (!fs.statSync(source).isFile()) continue
    const target = path.join(customDirectory, name)
    // 内置版本随应用更新；用户自建目录和同名自定义 Skill 不受影响。
    if (name.startsWith('builtin-')) fs.copyFileSync(source, target)
  }
}

export function listSkills() {
  if (!customDirectory) return []
  skillFiles.clear()
  const result = []
  for (const entry of fs.readdirSync(customDirectory, { withFileTypes: true })) {
    const file = entry.isDirectory() ? path.join(customDirectory, entry.name, 'SKILL.md') : entry.name.endsWith('.md') ? path.join(customDirectory, entry.name) : ''
    if (!file || !fs.existsSync(file)) continue
    const raw = fs.readFileSync(file, 'utf8')
    const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1] || ''
    const id = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || path.basename(file, '.md')
    if (!/^[\w][\w.-]{0,99}$/.test(id)) continue
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || raw.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0].slice(0, 300)
    skillFiles.set(id, file)
    result.push({ id, name: frontmatter.match(/^title:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || id, description, scope: id.startsWith('builtin-') ? 'builtin' : 'custom' })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function skillInstructions(ids) {
  const selected = new Set(ids)
  return listSkills().filter(skill => selected.has(skill.id)).map(skill => {
    const file = skillFiles.get(skill.id)
    if (!file) return ''
    return `# Skill: ${skill.name}\n${fs.readFileSync(file, 'utf8').replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '').trim()}`
  }).filter(Boolean).join('\n\n')
}
