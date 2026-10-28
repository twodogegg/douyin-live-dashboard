import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStageAudioQueue } from '../src/lib/stage-audio-queue.ts'

test('排队时立即读取一次性语音，播放后释放缓存', async () => {
  const requests = []
  const revoked = []
  const queue = createStageAudioQueue({
    fetchAudio: async (url, options) => { requests.push({ url, signal: options.signal }); return new Response('audio') },
    createUrl: () => 'blob:queued-audio',
    revokeUrl: url => revoked.push(url),
  })
  queue.preload('reply-1', '/stage/audio/once')
  queue.preload('reply-1', '/stage/audio/once')
  assert.equal(requests.length, 1)
  assert.deepEqual(await queue.get('reply-1'), { url: 'blob:queued-audio', error: '' })
  queue.discard('reply-1')
  assert.equal(queue.get('reply-1'), undefined)
  assert.equal(requests[0].signal.aborted, true)
  assert.deepEqual(revoked, ['blob:queued-audio'])
})

test('暂停时取消未完成的读取；过期地址提供明确错误', async () => {
  let abort
  const queue = createStageAudioQueue({
    fetchAudio: (url, options) => url === '/expired'
      ? Promise.resolve(new Response('', { status: 410 }))
      : new Promise((resolve, reject) => {
          abort = options.signal
          options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
  })
  queue.preload('pending', '/pending')
  const pending = queue.get('pending')
  queue.clear()
  assert.equal(abort.aborted, true)
  assert.deepEqual(await pending, { url: '', error: '' })
  queue.preload('expired', '/expired')
  assert.match((await queue.get('expired')).error, /过期/)
  queue.clear()
})
