import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInbox, formatInbox, splitSentences } from './stage-pipeline.js'
import { createStageState } from './stage-state.js'
import { parseRoomEvent, eventPriority, mergeGift } from './gift-points.js'

const template = JSON.parse(fs.readFileSync(new URL('./default-live-stage.json', import.meta.url), 'utf8'))
const DEFAULTS = template.config

// 一次「回复」的生命周期：
//   thinking     → 模型生成整条文案
//   synthesizing → 合成第一句（其余句子随后补齐）
//   ready        → 播出窗口可以开口
// 播出窗口每播完一句回传 stage_played。第一句开始播时，"说话窗口"打开，
// 这期间收到和攒下的消息会立刻生成下一条回复，所以当前这句播完时下一条已经准备好。
//
// 直播回复独立于摘要 Agent；所有播出窗口共用同一套未读信箱与串行生成。
export function createLiveStage({ file, chat, synthesize, broadcast, readiness, cancelAudio = () => {}, music, record = () => {}, stateNow = () => Date.now() }) {
  let config = { ...DEFAULTS }
  try { config = { ...config, ...JSON.parse(fs.readFileSync(file, 'utf8')), enabled: false } } catch { /* 首次启动 */ }
  let status = 'idle'
  let error = ''
  let lastReply = null
  let history = []
  let seen = new Set()
  const recent = new Map()
  let epoch = 0
  let timer = null
  let stateTimer = null
  let roomId = ''
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, unreported: 0 }
  let activity = { joins: 0, follows: 0, gifts: 0, gift_value: 0, events: [] }
  const eventIds = new Set()
  // 同一观众短时间内重复的进房/关注提示只算一次：页面会为同一次进入给出多条不同 id 的提示。
  const eventRecent = new Map()
  const inbox = createInbox()
  const machine = createStageState({ now: stateNow })

  // 说话窗口：正在播一条回复时打开，期间提前准备下一批。
  let speaking = false
  // 正在生成的批次（同一时刻最多一个，保证串行）。
  let working = false
  // 已经准备就绪、等当前这句播完就接管的下一条回复。
  let prefetched = null
  // 预取时被丢弃的批次（被更高优先级事件打断）。
  let dropped = 0
  // 说话窗口内想预取、但当时有任务在跑：任务结束后补一次。
  let wantPrefetch = false
  // 同一观众 5 秒内连刷同一种礼物：合并成一次感谢，避免「谢谢小心心」三连。
  let lastGift = null
  // 每条回复对应的句子文本，audioFor 用它按需补合成。
  let sentencePlan = []
  const audioCache = new Map()

  const snapshot = () => ({
    type: 'stage_status',
    config: { ...config },
    status,
    error,
    last_reply: lastReply,
    usage: { ...usage },
    activity: { ...activity, events: [...activity.events] },
    local: machine.snapshot(),
    inbox: { unread: inbox.size, speaking, prefetched: !!prefetched, dropped },
    music: music?.snapshot() || null,
  })
  const report = () => broadcast(snapshot())
  music?.configure(config.enabled && config.music_enabled)

  const settleLater = () => {
    clearTimeout(stateTimer)
    const until = machine.snapshot().until
    if (!until) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      machine.settle()
      if (machine.snapshot().until > stateNow()) return settleLater()
      if (working || speaking) machine.markBusy('busy')
      report()
    }, Math.max(0, until - stateNow()))
    stateTimer.unref?.()
  }

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
  const log = (kind, data) => { try { record({ kind, ...data }) } catch { /* 记录失败不影响直播 */ } }

  const reset = () => {
    epoch++
    cancelAudio()
    clearTimeout(timer)
    timer = null
    clearTimeout(stateTimer)
    stateTimer = null
    speaking = false
    prefetched = null
    dropped = 0
    wantPrefetch = false
    lastGift = null
    sentencePlan = []
    audioCache.clear()
    inbox.clear()
    history = []
    seen = new Set()
    lastReply = null
    status = 'idle'
    error = ''
    machine.reset()
    // working 不在这里释放：旧任务真正结束前保持占用，避免暂停后重启造成并行调用。
    report()
  }

  const systemPrompt = () => [template.system_message_template.replace('{{name}}', () => config.name).replace('{{system_prompt}}', () => config.system_prompt), music?.context?.()].filter(Boolean).join('\n')

  // 按需合成第 index 句（0 起）。同一句只合成一次；失败返回空地址并记录错误。
  // 缓存以「回复 id + 句序」为键，避免不同回复里重复出现的句子互相覆盖。
  const ensureAudio = async (index, sentences, replyId = 'live') => {
    if (!config.voice_enabled) return ''
    const text = sentences[index]
    if (!text) return ''
    const key = `${replyId}:${index}`
    if (audioCache.has(key)) return audioCache.get(key)
    try {
      const audio = await synthesize(text)
      audioCache.set(key, audio?.url || '')
      return audio?.url || ''
    } catch (e) {
      audioCache.set(key, '')
      throw e
    }
  }

  // 采用一条已生成的回复：更新台词计划、缓存键与当前回复。
  const adopt = reply => {
    sentencePlan = (reply.sentences || []).map(sentence => sentence.text)
    lastReply = reply
    audioCache.set(`${reply.id}:0`, reply.audio_url || '')
  }

  // 生成一条回复。batch 是信箱里的一批消息，或一条需要专门回应的房间事件。
  // publish 为 false 时只准备不播出：预取的下一批等当前这句播完才上台。
  const generate = async (batch, { publish = true } = {}) => {
    const token = epoch
    const started = stateNow()
    status = 'thinking'
    error = ''
    machine.markBusy('busy')
    report()
    const incoming = batch.items.length
      ? batch.items.map(item => ({ role: 'user', content: JSON.stringify({ viewer: item.user, message: item.text }) }))
      : [{ role: 'user', content: JSON.stringify({ event: batch.event }) }]
    try {
      const available = readiness()
      if (!available.ai) throw new Error('请先在模型与设置中配置 AI 模型和密钥')
      const result = await chat([
        { role: 'system', content: systemPrompt() },
        ...history,
        ...incoming,
        ...(batch.hint ? [{ role: 'system', content: batch.hint }] : []),
      ], { temperature: 0.8, max_tokens: 400 })
      recordUsage(result.usage)
      const text = result.text.trim().slice(0, 180)
      if (token !== epoch) return null
      if (!text) throw new Error('AI 没有返回回复，请重试')
      const sentences = splitSentences(text)
      const replyId = randomUUID()
      let audioUrl = ''
      let audioError = ''
      if (config.voice_enabled) {
        status = 'synthesizing'
        report()
        try { audioUrl = await ensureAudio(0, sentences, replyId) } catch (e) { audioError = `语音合成失败：${e.message || e}` }
      }
      if (token !== epoch) return null
      history = [...history, ...incoming, { role: 'assistant', content: text }].slice(-12)
      const reply = {
        id: replyId,
        user: batch.user,
        message: batch.message,
        text,
        audio_url: audioUrl,
        audio_error: audioError,
        test: !!batch.test,
        mode: batch.kind || 'chat',
        sentences: sentences.map((sentence, index) => ({ index, text: sentence, audio_url: index === 0 ? audioUrl : '' })),
        batch: { users: [...new Set(batch.items.map(item => item.user))], count: batch.items.length },
      }
      log('reply', { user: reply.user, text, mode: reply.mode, latency_ms: stateNow() - started, batch: reply.batch })
      if (!publish) return reply
      adopt(reply)
      status = 'ready'
      error = audioError
      broadcast({ type: 'stage_reply', ...reply })
      report()
      return reply
    } catch (e) {
      if (token === epoch) {
        status = 'error'
        error = String(e.message || e).slice(0, 500)
        log('error', { text: error })
        report()
      }
      throw e
    }
  }

  // 冷启动：没有回复在播时，直接从信箱取一批开始生成。
  const runNext = async ({ forced = null } = {}) => {
    if (working) return false
    // 事件触发的强制回复可以越过冷却；普通消息仍要等冷却结束。
    if (!forced && timer) return false
    const batch = forced || takeBatch()
    if (!batch) return false
    clearTimeout(timer)
    timer = null
    working = true
    const token = epoch
    try {
      await generate(batch)
    } catch { /* 错误已通过状态广播 */ } finally {
      working = false
      if (token !== epoch) {
        // 旧 epoch 的任务在暂停/切房期间才结束：现在才真正空闲，补一次调度。
        if (!speaking && config.enabled) schedule(0)
        return false
      }
      // 说话窗口期间被礼物/关注抢占的预取，在这里补上。
      if (wantPrefetch && speaking) prefetchNow()
      // 生成完但还没有播出窗口开口时，说话窗口尚未打开，靠 cooldown 控制节奏。
      if (!speaking && config.enabled) schedule()
      return true
    }
  }

  const schedule = (delay = config.cooldown * 1000) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (speaking) return
      void runNext()
    }, Math.max(0, delay))
    timer.unref?.()
  }

  // 从信箱取一批消息。
  const takeBatch = () => {
    const { items, stale } = inbox.drain(stateNow())
    if (stale) log('stale', { count: stale })
    if (!items.length) return null
    return {
      kind: 'chat',
      items,
      user: items.at(-1).user,
      message: formatInbox(items),
      hint: items.length > 1
        ? `这一批有 ${items.length} 条观众消息，来自 ${new Set(items.map(item => item.user)).size} 位观众。挑最值得回应的说，其他内容可以一句带过，不要逐条复述。`
        : '',
    }
  }

  // 第一句开口：说话窗口打开，立刻把下一批消息送去生成。
  // 这正是"我说话的时候就在处理下一批消息"的落点。
  const openSpeechWindow = () => {
    if (speaking) return
    speaking = true
    machine.markBusy('busy')
    // 关掉预取时退回"播完再取"的老行为：省 token，方便排查。
    if (!config.prefetch_enabled) { report(); return }
    // 已经预取好的批次不再重复抢跑。
    if (prefetched) { report(); return }
    // 手上还有任务（例如刚被礼物感谢占用）：等它结束后补一次预取，别错过整个说话窗口。
    if (working) { wantPrefetch = true; report(); return }
    prefetchNow()
  }

  // 真正发起一次预取。任务结束时若说话窗口仍在，会再被调用一次。
  const prefetchNow = () => {
    wantPrefetch = false
    if (!speaking || prefetched || working) return
    const batch = takeBatch()
    if (!batch) return
    working = true
    const token = epoch
    void generate(batch, { publish: false })
      .then(reply => { if (reply && token === epoch && speaking) prefetched = reply })
      .catch(() => {})
      .finally(() => {
        working = false
        // 说话窗口内就该提前准备下一批：一次没抢到就在结束后补上。
        if (wantPrefetch && speaking && !prefetched) prefetchNow()
        report()
      })
  }

  // 整条回复播完：有预取结果就直接切过去，否则按 cooldown 继续。
  const closeSpeechWindow = () => {
    speaking = false
    clearTimeout(timer)
    timer = null
    music?.duck?.(false)
    if (prefetched) {
      adopt(prefetched)
      prefetched = null
      status = 'ready'
      broadcast({ type: 'stage_reply', ...lastReply })
      report()
      return
    }
    // 说话期间积攒的消息马上接上，不再额外等 cooldown。
    if (config.enabled && inbox.size) void runNext()
    else if (config.enabled) schedule()
  }

  // 播出窗口每播完一句上报。
  const onPlayed = payload => {
    if (!payload || !lastReply || payload.id !== lastReply.id) return
    log('played', { text: lastReply.text, index: payload.index, total: lastReply.sentences?.length || 1 })
    if (payload.final) closeSpeechWindow()
    else openSpeechWindow()
  }

  const handleRoomEvent = message => {
    const item = parseRoomEvent(message.text, { user: message.user })
    if (!item) {
      if (message.text) log('unknown_event', { text: String(message.text).slice(0, 200) })
      return
    }
    // 同一观众的同类型事件在 15 秒内只认一次，避免重复提示把人数和感谢都放大。
    const signature = `${item.kind}:${item.user}`
    const now = stateNow()
    if (item.kind !== 'gift' && now - (eventRecent.get(signature) || 0) < 15000) return
    eventRecent.set(signature, now)
    // 礼物连刷：5 秒内同一人同一礼物累加数量，而不是各自感谢一次。
    let giftTotal = null
    if (item.kind === 'gift') {
      const merged = mergeGift(lastGift, item, now)
      if (merged) {
        lastGift = merged
        // 只更新计数，不再触发新的感谢：这一次连刷已经在感谢里了。
        activity.gifts += item.count - 1 > 0 ? item.count - 1 : 0
        activity.gift_value += item.value
        activity.events = [...activity.events, {
          id: message.id, kind: 'gift', user: item.user,
          gift: item.gift, count: item.count, value: item.value, time: message.time,
        }].slice(-20)
        log('gift', { user: item.user, gift: item.gift, count: item.count, value: item.value, text: item.text, merged: true })
        report()
        return
      }
      lastGift = { ...item, last_ts: now }
      giftTotal = item
    }
    if (eventRecent.size > 500) eventRecent.delete(eventRecent.keys().next().value)
    activity[item.kind === 'join' ? 'joins' : item.kind === 'follow' ? 'follows' : 'gifts']++
    if (item.kind === 'gift') activity.gift_value += item.value
    activity.events = [...activity.events, {
      id: message.id, kind: item.kind, user: item.user,
      gift: item.gift || '', count: item.count, value: item.value, time: message.time,
    }].slice(-20)
    log(item.kind, { user: item.user, gift: item.gift, count: item.count, value: item.value, text: item.text })
    machine.applyEvent(item)
    settleLater()
    report()
    if (!config.enabled) return
    if (item.kind === 'join' && !config.welcome_enabled) return
    const hint = item.kind === 'gift'
      ? `观众 ${giftTotal.user} 送出了「${giftTotal.gift}」×${giftTotal.count}。用一两句话真诚感谢，不要提价值或价格。`
      : item.kind === 'follow'
        ? `观众 ${item.user} 刚刚关注了你。用一两句话欢迎新粉丝，语气亲近自然。`
        : `观众 ${item.user} 进入了直播间。用一句话轻松地打个招呼。`
    const batch = {
      kind: item.kind === 'join' ? 'welcome' : item.kind,
      items: [], event: item, user: item.user, message: item.text, hint,
    }
    // 高优先级事件抢占已经预取的下一条回复；大礼物可以打断正在说的话由播出窗口决定。
    if (prefetched && eventPriority(item) > 15) { prefetched = null; dropped++ }
    if (timer) { clearTimeout(timer); timer = null }
    void runNext({ forced: batch })
  }

  return {
    snapshot,
    recordUsage,
    played: onPlayed,
    // 播出窗口播到第几句时上报，服务端按需补齐这一句的音频。
    async audioFor(payload) {
      if (!lastReply || !payload || payload.id !== lastReply.id) return null
      const index = Number(payload.index)
      if (!Number.isInteger(index) || index <= 0) return null
      try {
        const url = await ensureAudio(index, sentencePlan, lastReply.id)
        return { id: lastReply.id, index, audio_url: url }
      } catch (e) {
        return { id: lastReply.id, index, audio_url: '', audio_error: String(e.message || e).slice(0, 300) }
      }
    },
    configure(patch) {
      const next = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, patch[key] ?? config[key]]))
      if (typeof next.enabled !== 'boolean' || typeof next.voice_enabled !== 'boolean' || typeof next.music_enabled !== 'boolean'
        || typeof next.welcome_enabled !== 'boolean' || typeof next.prefetch_enabled !== 'boolean') throw new Error('开关配置无效')
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
          activity = { joins: 0, follows: 0, gifts: 0, gift_value: 0, events: [] }
          music?.reset()
          reset()
        }
        return
      }
      if (message.type === 'room_event') {
        if (!['join', 'follow', 'gift', 'unknown'].includes(message.kind) || !message.user?.trim() || !message.id || eventIds.has(message.id)) return
        eventIds.add(message.id)
        if (eventIds.size > 1000) eventIds.delete(eventIds.values().next().value)
        return handleRoomEvent(message)
      }
      if (message.type !== 'r2' || !message.user?.trim() || !message.text?.trim()) return
      const key = `${roomId}:${message.id}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 500) seen.delete(seen.values().next().value)
      const signature = JSON.stringify([message.user.trim(), message.text.trim()])
      const now = stateNow()
      if (recent.has(signature) && now - recent.get(signature) < 30000) return
      recent.set(signature, now)
      if (recent.size > 500) recent.delete(recent.keys().next().value)
      inbox.push({ user: message.user.slice(0, 80), text: message.text.slice(0, 1000), id: message.id, now })
      if (!config.enabled) return
      if (config.music_enabled) void music?.request({ user: message.user.slice(0, 80), text: message.text.slice(0, 1000) })
      log('message', { user: message.user, text: message.text })
      // 说话窗口里只收集不抢跑：这批消息就是下一批回复的原素材。
      // 已经有任务在生成时同样只入箱，等它结束时再按说话窗口/cooldown 决定取舍。
      if (speaking || working) { report(); return }
      void runNext()
    },
    async test(message) {
      if (typeof message?.text !== 'string' || !message.text.trim() || message.text.length > 1000) throw new Error('请输入 1–1000 字的测试消息')
      if (working) throw new Error('正在回复中，请稍后再试')
      clearTimeout(timer)
      timer = null
      working = true
      try {
        return await generate({
          kind: 'chat', items: [{ user: '试播观众', text: message.text.trim(), ts: stateNow(), merged: 1 }],
          user: '试播观众', message: message.text.trim(), test: true,
        })
      } finally {
        working = false
        if (config.enabled) schedule()
      }
    },
    close() { config.enabled = false; music?.close(); reset() },
  }
}
