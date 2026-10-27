import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as fish from './fish.js'

const originalFetch = globalThis.fetch
let dir
const voiceId = 'a'.repeat(32)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-fish-'))
  fish.init(path.join(dir, 'config.json'), path.join(dir, 'audio'))
  fish.setConfig({ key: 'test-secret', reference_id: voiceId })
})
afterEach(() => { globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }) })

test('只向后端保存密钥，公开配置不返回密钥，留空保留旧值', async () => {
  assert.equal('key' in fish.getConfig(), false)
  fish.setConfig({ key: '', speed: 1.2 })
  assert.equal(fish.getConfig().has_key, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).key, 'test-secret')
  assert.throws(() => fish.setConfig({ tts_model: 'drama3' }), /模型/)
  assert.throws(() => fish.audioFile('../config.json'), /无效/)
})

test('使用最新 TTS 模型和自然语言情绪，相同生成合并且缓存音频', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, 'https://api.fish.audio/v1/tts')
    assert.equal(options.headers.model, 'drama-3')
    assert.equal(options.headers.Authorization, 'Bearer test-secret')
    const body = JSON.parse(options.body)
    assert.equal(body.text, '[温柔、放慢语速] 你好')
    assert.equal(body.reference_id, voiceId)
    return new Response('test-audio', { headers: { 'Content-Type': 'audio/mpeg' } })
  }
  const [a, b] = await Promise.all([fish.synthesize('你好', voiceId, '温柔、放慢语速'), fish.synthesize('你好', voiceId, '温柔、放慢语速')])
  assert.deepEqual(a, b)
  assert.deepEqual(await fish.synthesize('你好', voiceId, '温柔、放慢语速'), a)
  assert.equal(calls, 1)
  assert.equal(fs.readFileSync(fish.audioFile(a.id), 'utf8'), 'test-audio')
})

test('ASR 用 multipart 文件和精确模型头，保留情绪线索但去掉说话人标记', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.fish.audio/v1/asr')
    assert.equal(options.headers.model, 'transcribe-1-pro')
    assert.equal(options.headers['Content-Type'], undefined)
    assert.equal(await options.body.get('audio').text(), 'audio-bytes')
    assert.equal(options.body.get('tag_audio_events'), 'true')
    return Response.json({ text: '<|speaker:0|>[高兴] 今天挺好的', duration: 3 })
  }
  assert.deepEqual(await fish.transcribe(Buffer.from('audio-bytes')), { text: '[高兴] 今天挺好的', duration: 3 })
})

test('直播 TTS 直接返回音频流，首块可先读取，取消传播到供应商请求', async () => {
  let bodyController
  let signal
  globalThis.fetch = async (url, options) => {
    signal = options.signal
    const body = JSON.parse(options.body)
    assert.equal(body.latency, 'balanced')
    assert.equal(body.chunk_length, 100)
    assert.equal(body.format, 'mp3')
    return new Response(new ReadableStream({ start(controller) {
      bodyController = controller
      controller.enqueue(new TextEncoder().encode('first-audio'))
    } }), { headers: { 'Content-Type': 'audio/mpeg' } })
  }
  const controller = new AbortController()
  const stream = await fish.streamSpeech('你好，测试流式语音', controller.signal)
  const reader = stream.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first-audio')
  controller.abort()
  assert.equal(signal.aborted, true)
  bodyController.close()
  await reader.cancel()
})

test('失败请求不生成成功缓存；空转写不冒充成功', async () => {
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ message: 'Invalid test-secret' }, { status: 401 }) }
  await assert.rejects(fish.synthesize('你好'), e => !e.message.includes('test-secret') && e.httpStatus === 401)
  await assert.rejects(fish.synthesize('你好'), /401/)
  assert.equal(calls, 2)
  globalThis.fetch = async () => Response.json({ text: ' ' })
  await assert.rejects(fish.transcribe(Buffer.from('audio')), /未识别/)
})

test('复刻仅在确认授权后创建私有音色，设计候选可以保存为私有音色', async () => {
  await assert.rejects(fish.createVoice({ name: '测试', audio: 'YQ==' }), /授权/)
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('voice-design')) {
      assert.equal(options.headers.model, 'voice-design-1')
      assert.equal(JSON.parse(options.body).n, 4)
      return Response.json({ candidates: [{ audio_base64: 'YQ==', text: '你好', signature: 'signature' }] })
    }
    assert.equal(options.body.get('visibility'), 'private')
    assert.equal(options.body.get('voices').size, 1)
    assert.equal(options.body.get('voice_design_signatures'), 'signature')
    return Response.json({ _id: voiceId, title: '我的音色', state: 'trained' })
  }
  const design = await fish.designVoice({ instruction: '温柔自然', text: '你好' })
  assert.ok(design.candidates[0].url.endsWith('.wav'))
  assert.equal((await fish.createVoice({ name: '我的音色', candidate_id: design.candidates[0].id })).id, voiceId)
})
