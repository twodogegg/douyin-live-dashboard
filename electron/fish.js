import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const BASE = 'https://api.fish.audio'
const MAX_AUDIO = 20 * 1024 * 1024
const DEFAULTS = { key: '', tts_model: 'drama-3', asr_model: 'transcribe-1-pro', reference_id: '', voice_name: '', speed: 1, emotion: '自然、亲切，像日常聊天，避免夸张表演' }
let config = { ...DEFAULTS }
let configFile = ''
let audioDir = ''
const pending = new Map()

export function init(file, dir) {
  configFile = file
  audioDir = dir
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { config = { ...DEFAULTS } }
  if (process.env.FISH_API_KEY) config.key = process.env.FISH_API_KEY
}

export function getConfig() {
  const { key, ...safe } = config
  return { ...safe, has_key: !!key }
}

export function setConfig(patch) {
  const next = { ...config }
  for (const k of Object.keys(DEFAULTS)) if (k in patch && !(k === 'key' && patch[k] === '')) next[k] = patch[k]
  for (const k of ['key', 'reference_id', 'voice_name', 'emotion']) {
    if (typeof next[k] !== 'string') throw new Error('音色配置格式无效')
    next[k] = next[k].trim()
  }
  if (!['drama-3', 's2.1-pro', 's2.1-pro-free'].includes(next.tts_model) || next.asr_model !== 'transcribe-1-pro') throw new Error('不支持的语音模型')
  if (next.reference_id && !/^[a-f\d]{32}$/i.test(next.reference_id)) throw new Error('音色 ID 必须是 32 位字符')
  if (!Number.isFinite(next.speed) || next.speed < 0.5 || next.speed > 2) throw new Error('语速需要在 0.5–2 之间')
  if (next.emotion.length > 500 || next.voice_name.length > 200) throw new Error('音色描述过长')
  fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(`${configFile}.tmp`, configFile)
  config = next
  return getConfig()
}

async function request(endpoint, { model, ...options } = {}) {
  if (!config.key) throw new Error('请先配置 Fish Audio API Key')
  const response = await fetch(`${BASE}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.key}`, ...(model ? { model } : {}), ...options.headers },
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
  })
  if (!response.ok) {
    let reason = ''
    try { reason = (await response.json()).message || '' } catch { /* 部分网关不返回 JSON */ }
    const error = new Error(`Fish Audio HTTP ${response.status}${reason ? `：${String(reason).replaceAll(config.key, '[隐藏]').slice(0, 250)}` : ''}`)
    error.httpStatus = response.status
    throw error
  }
  return response
}

const hash = data => createHash('sha256').update(data).digest('hex')
function saveAudio(buffer, ext) {
  if (!buffer.length || buffer.length > MAX_AUDIO) throw new Error('音频为空或超过 20 MB')
  const id = `${hash(buffer)}.${ext}`
  const file = path.join(audioDir, id)
  fs.writeFileSync(file, buffer, { mode: 0o600 })
  return { id, url: `/dm/voice/audio/${id}` }
}

export function audioFile(id) {
  if (!/^[a-f\d]{64}\.(mp3|wav)$/.test(id)) throw new Error('音频 ID 无效')
  const file = path.join(audioDir, id)
  if (!fs.existsSync(file)) throw new Error('音频不存在，请重新生成')
  return file
}

function ttsBody(text, referenceId, emotion) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('语音文字需要在 1–2000 字之间')
  if (!referenceId || !/^[a-f\d]{32}$/i.test(referenceId)) throw new Error('请先选择音色')
  if (typeof emotion !== 'string' || emotion.length > 500) throw new Error('情绪描述过长')
  return { text: `${emotion ? `[${emotion.replace(/[\[\]]/g, '')}] ` : ''}${text.trim()}`, reference_id: referenceId,
    format: 'mp3', prosody: { speed: config.speed, volume: 0 }, normalize: true }
}

export async function streamSpeech(text, signal) {
  const body = { ...ttsBody(text, config.reference_id, config.emotion), latency: 'balanced', chunk_length: 100 }
  const response = await request('/v1/tts', { method: 'POST', model: config.tts_model, signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!/audio|octet-stream/.test(response.headers.get('content-type') || '') || !response.body) {
    await response.body?.cancel()
    throw new Error('Fish Audio 未返回音频流')
  }
  return response.body
}

export async function synthesize(text, referenceId = config.reference_id, emotion = config.emotion) {
  const body = ttsBody(text, referenceId, emotion)
  const cacheKey = hash(JSON.stringify({ model: config.tts_model, ...body }))
  const indexFile = path.join(audioDir, `${cacheKey}.json`)
  try {
    const cached = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    audioFile(cached.id)
    return cached
  } catch { /* 缓存缺失时生成 */ }
  if (pending.has(cacheKey)) return pending.get(cacheKey)
  const task = (async () => {
    const response = await request('/v1/tts', { method: 'POST', model: config.tts_model,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const type = response.headers.get('content-type') || ''
    if (!/audio|octet-stream/.test(type)) throw new Error('Fish Audio 未返回音频')
    const audio = saveAudio(Buffer.from(await response.arrayBuffer()), 'mp3')
    fs.writeFileSync(indexFile, JSON.stringify(audio), { mode: 0o600 })
    return audio
  })()
  pending.set(cacheKey, task)
  try { return await task } finally { pending.delete(cacheKey) }
}

export async function transcribe(buffer, mime = 'application/octet-stream') {
  if (!buffer.length || buffer.length > MAX_AUDIO) throw new Error('音频为空或超过 20 MB')
  const body = new FormData()
  body.append('audio', new Blob([buffer], { type: mime }), 'speech.audio')
  body.append('ignore_timestamps', 'true')
  body.append('tag_audio_events', 'true')
  const result = await (await request('/v1/asr', { method: 'POST', model: config.asr_model, body })).json()
  const text = result.text?.replace(/<\|speaker:\d+\|>/g, '').trim()
  if (!text) throw new Error('未识别到语音内容，请人工查看原消息')
  return { text, duration: result.duration }
}

function voiceItem(item) {
  return { id: item._id, name: item.title, description: item.description || '', state: item.state,
    languages: item.languages || [], visibility: item.visibility, tags: item.tags || [] }
}

export async function listVoices(query) {
  const params = new URLSearchParams({ page_size: '12', page_number: String(Math.max(1, Number(query.page) || 1)), self: query.own === 'true' ? 'true' : 'false' })
  if (query.title) params.set('title', String(query.title).slice(0, 100))
  if (query.language) params.set('language', String(query.language).slice(0, 10))
  const data = await (await request(`/model?${params}`)).json()
  return { items: (data.items || []).map(voiceItem), total: data.total, has_more: !!data.has_more }
}

export async function getVoice(id) {
  if (!/^[a-f\d]{32}$/i.test(id)) throw new Error('音色 ID 无效')
  return voiceItem(await (await request(`/model/${id}`)).json())
}

export async function designVoice({ instruction, text }) {
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 2000) throw new Error('音色描述需要在 1–2000 字之间')
  if (typeof text !== 'string' || !text.trim() || text.length > 150) throw new Error('试听文字需要在 1–150 字之间')
  const data = await (await request('/v1/voice-design', { method: 'POST', model: 'voice-design-1',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, reference_text: text, language: 'zh', n: 4 }) })).json()
  return { candidates: (data.candidates || []).map(c => {
    const audio = saveAudio(Buffer.from(c.audio_base64, 'base64'), 'wav')
    fs.writeFileSync(path.join(audioDir, `${audio.id}.json`), JSON.stringify({ signature: c.signature || c.voice_design_signature, text: c.text || text }), { mode: 0o600 })
    return { ...audio, text: c.text || text, duration_ms: c.duration_ms }
  }) }
}

export async function createVoice({ name, audio, mime, candidate_id, transcript, consent }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('请输入 1–100 字的音色名称')
  let buffer, signature
  if (candidate_id) {
    if (!candidate_id.endsWith('.wav')) throw new Error('请选择音色设计候选')
    buffer = fs.readFileSync(audioFile(candidate_id))
    const metadata = JSON.parse(fs.readFileSync(path.join(audioDir, `${candidate_id}.json`), 'utf8'))
    signature = metadata.signature
    transcript = metadata.text
    mime = 'audio/wav'
  } else {
    if (consent !== true) throw new Error('请确认拥有参考录音的声音使用授权')
    if (typeof audio !== 'string' || !/^[A-Za-z\d+/]+={0,2}$/.test(audio)) throw new Error('参考音频格式无效')
    buffer = Buffer.from(audio, 'base64')
  }
  if (!buffer.length || buffer.length > MAX_AUDIO) throw new Error('参考音频为空或超过 20 MB')
  const body = new FormData()
  for (const [key, value] of Object.entries({ type: 'tts', title: name.trim(), visibility: 'private', train_mode: 'fast', enhance_audio_quality: 'true' })) body.append(key, value)
  body.append('voices', new Blob([buffer], { type: mime || 'audio/wav' }), 'reference.audio')
  if (transcript) body.append('texts', String(transcript).slice(0, 10000))
  if (signature) body.append('voice_design_signatures', signature)
  return voiceItem(await (await request('/model', { method: 'POST', body })).json())
}
