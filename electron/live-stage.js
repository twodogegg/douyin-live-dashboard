import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

const template = JSON.parse(fs.readFileSync(new URL('./default-live-stage.json', import.meta.url), 'utf8'))
const DEFAULTS = template.config

// 直播回复独立于摘要 Agent；所有播出窗口共用同一个串行生成队列。
export function createLiveStage({ file, chat, synthesize, broadcast, readiness, cancelAudio = () => {}, music }) {
  let config = { ...DEFAULTS }
  try { config = { ...config, ...JSON.parse(fs.readFileSync(file, 'utf8')), enabled: false } } catch { /* 首次启动 */ }
  let status = 'idle'
  let error = ''
  let lastReply = null
  let history = []
  let queue = []
  let seen = new Set()
  const recent = new Map()
  let epoch = 0
  let active = false
  let timer = null
  let roomId = ''
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, unreported: 0 }
  let activity = { joins: 0, follows: 0, events: [] }
  const eventIds = new Set()

  const snapshot = () => ({ type: 'stage_status', config: { ...config }, status, error, last_reply: lastReply, usage: { ...usage }, activity: { ...activity, events: [...activity.events] }, music: music?.snapshot() || null })
  const report = () => broadcast(snapshot())
  music?.configure(config.enabled && config.music_enabled)
  const recordUsage = value => {
    usage.requests++
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
    const input = count(value?.prompt_tokens)
    const output = count(value?.completion_tokens)
    const total = count(value?.total_tokens) ?? (input !== null && output !== null ? input + output : null)
    usage.prompt_tokens += input ?? 0
    usage.completion_tokens += output ?? 0
    usage.total_tokens += total ?? 0
    if (total === null) usage.unreported++
    report()
  }
  const reset = () => {
    epoch++
    cancelAudio()
    clearTimeout(timer)
    timer = null
    queue = []
    history = []
    seen = new Set()
    lastReply = null
    status = 'idle'
    error = ''
    // active 直到旧任务真正结束才释放，避免暂停后重启造成并行调用。
    report()
  }

  const generate = async message => {
    const token = epoch
    status = 'thinking'
    error = ''
    report()
    try {
      const available = readiness()
      if (!available.ai) throw new Error('请先在模型与设置中配置 AI 模型和密钥')
      const result = await chat([
        { role: 'system', content: [template.system_message_template.replace('{{name}}', () => config.name).replace('{{system_prompt}}', () => config.system_prompt), music?.context?.()].filter(Boolean).join('\n') },
        ...history,
        { role: 'user', content: JSON.stringify({ viewer: message.user, message: message.text }) },
      ], { temperature: 0.8, max_tokens: 400 })
      recordUsage(result.usage) // 暂停期间完成的请求同样已经消耗 token。
      const text = result.text.trim().slice(0, 180)
      if (token !== epoch) return null
      if (!text) throw new Error('AI 没有返回回复，请重试')
      let audio = null
      let audioError = ''
      if (config.voice_enabled) {
        status = 'synthesizing'
        report()
        try { audio = await synthesize(text) } catch (e) { audioError = `语音合成失败：${e.message || e}` }
      }
      if (token !== epoch) return null
      history = [...history, { role: 'user', content: JSON.stringify({ viewer: message.user, message: message.text }) }, { role: 'assistant', content: text }].slice(-12)
      lastReply = { id: randomUUID(), user: message.user, message: message.text, text, audio_url: audio?.url || '', audio_error: audioError, test: !!message.test }
      status = 'ready'
      error = audioError
      broadcast({ type: 'stage_reply', ...lastReply })
      report()
      return lastReply
    } catch (e) {
      if (token === epoch) {
        status = 'error'
        error = String(e.message || e).slice(0, 500)
        report()
      }
      throw e
    }
  }

  const pump = async () => {
    if (active || timer || !config.enabled || !queue.length) return
    active = true
    const token = epoch
    // 拥挤时回应最新消息，避免长时间追赶过时弹幕。
    const message = queue.at(-1)
    queue = []
    try { await generate(message) } catch { /* 错误通过状态广播 */ } finally {
      active = false
      if (token === epoch && config.enabled) {
        timer = setTimeout(() => { timer = null; void pump() }, config.cooldown * 1000)
      } else void pump()
    }
  }

  return {
    snapshot,
    recordUsage,
    configure(patch) {
      const next = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, patch[key] ?? config[key]]))
      if (typeof next.enabled !== 'boolean' || typeof next.voice_enabled !== 'boolean' || typeof next.music_enabled !== 'boolean') throw new Error('开关配置无效')
      if (typeof next.name !== 'string' || !next.name.trim() || next.name.length > 30) throw new Error('角色名需要在 1–30 字之间')
      if (typeof next.system_prompt !== 'string' || !next.system_prompt.trim() || next.system_prompt.length > 6000) throw new Error('人设需要在 1–6000 字之间')
      if (!Number.isInteger(next.cooldown) || next.cooldown < 3 || next.cooldown > 120) throw new Error('回复间隔需要在 3–120 秒之间')
      if (next.enabled) {
        const available = readiness()
        if (!available.ai) throw new Error('请先配置 AI 模型和密钥')
        if (next.voice_enabled && !available.voice) throw new Error('请先在音色与语音中配置 Fish Audio 密钥并选择音色')
      }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
      config = next
      music?.configure(config.enabled && config.music_enabled)
      reset()
      return snapshot()
    },
    observe(message) {
      if (message.type === 'reset') { music?.reset(); return reset() }
      if (message.type === 'stat') {
        if (message.room_id !== roomId) {
          roomId = message.room_id
          recent.clear()
          eventIds.clear()
          activity = { joins: 0, follows: 0, events: [] }
          music?.reset()
          reset()
        }
        return
      }
      if (message.type === 'room_event') {
        if (!['join', 'follow'].includes(message.kind) || !message.user?.trim() || !message.id || eventIds.has(message.id)) return
        eventIds.add(message.id)
        if (eventIds.size > 1000) eventIds.delete(eventIds.values().next().value)
        activity[message.kind === 'join' ? 'joins' : 'follows']++
        activity.events = [...activity.events, { id: message.id, kind: message.kind, user: message.user, time: message.time }].slice(-20)
        report()
        return
      }
      if (message.type !== 'r2' || !message.user?.trim() || !message.text?.trim()) return
      const key = `${roomId}:${message.id}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 500) seen.delete(seen.values().next().value)
      // DOM 被重建可能给旧弹幕分配新 ID；同一观众的相同内容在 30 秒内只回复一次。
      const signature = JSON.stringify([message.user.trim(), message.text.trim()])
      const now = Date.now()
      const duplicate = recent.has(signature) && now - recent.get(signature) < 30000
      recent.set(signature, now)
      if (recent.size > 500) recent.delete(recent.keys().next().value)
      if (!config.enabled || duplicate) return
      if (config.music_enabled) void music?.request({ user: message.user.slice(0, 80), text: message.text.slice(0, 1000) })
      queue.push({ user: message.user.slice(0, 80), text: message.text.slice(0, 1000) })
      queue = queue.slice(-8)
      void pump()
    },
    async test(message) {
      if (typeof message?.text !== 'string' || !message.text.trim() || message.text.length > 1000) throw new Error('请输入 1–1000 字的测试消息')
      if (active) throw new Error('正在回复中，请稍后再试')
      clearTimeout(timer)
      timer = null
      active = true
      try { return await generate({ user: '试播观众', text: message.text.trim(), test: true }) } finally {
        active = false
        if (config.enabled) timer = setTimeout(() => { timer = null; void pump() }, config.cooldown * 1000)
      }
    },
    close() { config.enabled = false; music?.close(); reset() },
  }
}
