import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createStageAudio } from './stage-audio.js'

async function fixture(t, streamSpeech) {
  const audio = createStageAudio(streamSpeech)
  const server = http.createServer((req, res) => {
    audio.serve(req, res, req.url.slice(1)).catch(() => res.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { audio.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { audio, url: `http://127.0.0.1:${server.address().port}` }
}

test('首段音频在上游结束前到达客户端，单次票据不重复生成或重播', async t => {
  let source
  let calls = 0
  const { audio, url } = await fixture(t, async () => {
    calls++
    return new ReadableStream({ start(controller) { source = controller; controller.enqueue(Buffer.from('first')) } })
  })
  const ticket = await audio.prepare('测试')
  const id = ticket.url.split('/').at(-1)
  const response = await fetch(`${url}/${id}`)
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('transfer-encoding'), 'chunked')
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
  const replay = await fetch(`${url}/${id}`)
  assert.equal(replay.status, 410)
  source.enqueue(Buffer.from('last'))
  source.close()
  let rest = ''
  for (;;) { const item = await reader.read(); if (item.done) break; rest += new TextDecoder().decode(item.value) }
  assert.equal(rest, 'last')
  assert.equal(calls, 1)
})

test('停止播放或断开请求会取消上游合成，暂停使尚未领取的票据失效', async t => {
  let sourceSignal
  let cancelled
  const aborted = new Promise(resolve => { cancelled = resolve })
  const { audio, url } = await fixture(t, async (text, signal) => {
    sourceSignal = signal
    signal.addEventListener('abort', cancelled, { once: true })
    return new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('first')) } })
  })
  const ticket = await audio.prepare('测试')
  const response = await fetch(`${url}/${ticket.url.split('/').at(-1)}`)
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  await aborted
  assert.equal(sourceSignal.aborted, true)
  const pending = await audio.prepare('尚未播放')
  audio.clear()
  assert.equal((await fetch(`${url}/${pending.url.split('/').at(-1)}`)).status, 410)
})

test('合成准备期间暂停，不把迟到的流变成可播放票据', async t => {
  let finish
  const { audio } = await fixture(t, () => new Promise(resolve => { finish = resolve }))
  const pending = audio.prepare('测试')
  audio.clear()
  finish(new ReadableStream({ start(controller) { controller.close() } }))
  await assert.rejects(pending, /取消/)
})
