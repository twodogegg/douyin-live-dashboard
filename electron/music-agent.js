import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_FILE = new URL('./default-music-agent.json', import.meta.url)

export function createMusicAgent({ file, defaultFile = DEFAULT_FILE, chat, onUsage = () => {} }) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.copyFileSync(defaultFile, file)
    fs.chmodSync(file, 0o600)
  }
  // 每次调用读取运行时配置，调整提示词无需修改代码或重启。
  const load = () => {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const key of ['recognize', 'select']) {
      const rule = config[key]
      if (!rule || !['system_prompt', 'tool_description'].every(field => typeof rule[field] === 'string' && rule[field].trim() && rule[field].length <= 20000)) throw new Error(`点歌配置 ${key} 的提示词不能为空或超过 20000 字符`)
      if (typeof rule.temperature !== 'number' || rule.temperature < 0 || rule.temperature > 2 || !Number.isInteger(rule.max_tokens) || rule.max_tokens < 1 || rule.max_tokens > 8000) throw new Error(`点歌配置 ${key} 的模型参数无效`)
    }
    if (typeof config.host_context !== 'string' || !config.host_context.trim() || config.host_context.length > 20000) throw new Error('点歌配置 host_context 无效')
    return config
  }
  load()
  const invoke = async (key, name, input, parameters) => {
    const rule = load()[key]
    const data = await chat([
      { role: 'system', content: rule.system_prompt },
      { role: 'user', content: JSON.stringify(input) },
    ], { temperature: rule.temperature, max_tokens: rule.max_tokens, tools: [{ type: 'function', function: { name, description: rule.tool_description, parameters } }] })
    onUsage(data.usage)
    const call = data.choices?.[0]?.message?.tool_calls?.find(call => call.function?.name === name)
    return call ? JSON.parse(call.function.arguments) : null
  }
  return {
    context: () => load().host_context,
    parse: message => invoke('recognize', 'request_song', message, {
      type: 'object', properties: { name: { type: 'string' }, artist: { type: 'string' } }, required: ['name', 'artist'], additionalProperties: false,
    }),
    async select({ message, request, candidates }) {
      const result = await invoke('select', 'select_song', { message, request, candidates: candidates.map((song, index) => ({ index, name: song.name, artists: song.artists, album: song.album || '' })) }, {
        type: 'object', properties: { index: { type: 'integer', minimum: -1, maximum: candidates.length - 1 } }, required: ['index'], additionalProperties: false,
      })
      return result?.index ?? null
    },
  }
}
