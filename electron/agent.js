// 分析 Agent 配置：提示词与参数放在 agent_config.json，运行时位于应用数据目录。
import fs from 'node:fs'
import path from 'node:path'
import { CAPABILITY_DEFAULTS, listSkills, normalizeCapabilities, validateCapabilities } from './capabilities.js'

const REQUIRED = [
  'system_prompt', 'temperature', 'max_tokens', 'max_chars',
  'min_messages', 'r1_gap', 'keep_prev_summary', 'merge_repeats',
  'repeat_max_chars', 'repeat_min_count', 'no_change_marker',
  'suppress_no_change', 'region_labels',
]

export function validate(conf) {
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) return '配置必须是 JSON 对象'
  const missing = REQUIRED.filter((k) => !(k in conf))
  if (missing.length) return `缺少字段: ${missing.join(', ')}`
  if (typeof conf.system_prompt !== 'string' || !conf.system_prompt.trim()) return 'system_prompt 不能为空'
  if (conf.system_prompt.length > 20000) return 'system_prompt 不能超过 20000 字符'
  if (!(Number(conf.temperature) >= 0 && Number(conf.temperature) <= 2)) return 'temperature 需要在 0-2 之间'
  if (!(Number(conf.max_tokens) >= 1 && Number(conf.max_tokens) <= 8000)) return 'max_tokens 需要在 1-8000 之间'
  if (!(Number(conf.max_chars) >= 100 && Number(conf.max_chars) <= 50000)) return 'max_chars 需要在 100-50000 之间'
  if (!(Number(conf.min_messages) >= 1 && Number(conf.min_messages) <= 500)) return 'min_messages 需要在 1-500 之间'
  if (!(Number(conf.r1_gap) >= 0 && Number(conf.r1_gap) <= 120)) return 'r1_gap 需要在 0-120 秒之间'
  if (typeof conf.keep_prev_summary !== 'boolean') return 'keep_prev_summary 必须是布尔值'
  if (typeof conf.merge_repeats !== 'boolean') return 'merge_repeats 必须是布尔值'
  if (!(Number(conf.repeat_max_chars) >= 1 && Number(conf.repeat_max_chars) <= 100)) return 'repeat_max_chars 需要在 1-100 之间'
  if (!(Number(conf.repeat_min_count) >= 2 && Number(conf.repeat_min_count) <= 100)) return 'repeat_min_count 需要在 2-100 之间'
  if (typeof conf.no_change_marker !== 'string' || !conf.no_change_marker.trim()) return 'no_change_marker 不能为空'
  if (typeof conf.suppress_no_change !== 'boolean') return 'suppress_no_change 必须是布尔值'
  const capabilityError = validateCapabilities({ ...CAPABILITY_DEFAULTS, ...conf }, new Set(listSkills().map(skill => skill.id)))
  if (capabilityError) return capabilityError
  const labels = conf.region_labels
  if (!labels || typeof labels !== 'object' || !['r1', 'r2'].every((k) => typeof labels[k] === 'string' && labels[k].trim()))
    return 'region_labels 需要包含 r1 和 r2 的非空名称'
  return null
}

export function load(file, defaultFile) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.copyFileSync(defaultFile, file)
  }
  const conf = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const err = validate(conf)
  if (err) throw new Error(`${file}: ${err}`)
  return { ...CAPABILITY_DEFAULTS, ...conf, ...normalizeCapabilities(conf) }
}

export function save(file, conf) {
  const err = validate(conf)
  if (err) throw new Error(err)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, file)
}
