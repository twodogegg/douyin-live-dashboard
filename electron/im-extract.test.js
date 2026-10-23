import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { IM_FIND_MEDIA_JS, IM_SCAN_JS } from './im-extract.js'

test('图片滚入视野后虚拟列表替换节点，读取新节点而非等待已移除的旧图片', async () => {
  const image = { complete: true, naturalWidth: 576, src: 'https://example.com/image.png', loading: 'lazy' }
  const newBox = { querySelector: () => image }
  const newRow = { __reactFiber$test: { memoizedProps: { message: { serverId: 'img' } } }, querySelector: () => newBox }
  const oldBox = {
    querySelector: () => ({ complete: false, naturalWidth: 0, src: '' }),
    scrollIntoView: () => { currentRow = newRow },
  }
  let currentRow = { __reactFiber$test: { memoizedProps: { message: { serverId: 'img' } } }, querySelector: () => oldBox }
  const list = { scrollTop: 41, querySelectorAll: () => [currentRow] }
  const source = IM_FIND_MEDIA_JS.replace(`const scan = (${IM_SCAN_JS});`, 'const scan = () => ({ messages: [{ source_id: "img", kind: "image" }] });')
  assert.notEqual(source, IM_FIND_MEDIA_JS)
  const read = runInNewContext(`(${source})`, {
    document: { querySelector: () => list }, getComputedStyle: () => ({ flexDirection: 'column-reverse' }),
    setTimeout: callback => callback(), URL,
  })
  const result = await read({ source_id: 'img' }, true)
  assert.equal(result.inline, image.src)
  assert.equal(image.loading, 'eager')
  assert.equal(list.scrollTop, 41)
})

test('原生组件解密语音后读取 blob，结束时还原播放方法和滚动位置', async () => {
  const originalPlay = () => Promise.resolve()
  class MediaElement { play = originalPlay }
  MediaElement.prototype.play = originalPlay
  const player = Object.assign(new MediaElement(), { tagName: 'AUDIO', src: 'blob:decrypted', pause: () => { paused = true } })
  delete player.play
  let clicks = 0, paused = false
  const box = { scrollIntoView() {}, click() { if (++clicks === 1) player.play() } }
  const row = { __reactFiber$test: { memoizedProps: { message: { serverId: 'voice' } } }, querySelector: () => box }
  const list = { scrollTop: 41, querySelectorAll: () => [row] }
  const source = IM_FIND_MEDIA_JS.replace(`const scan = (${IM_SCAN_JS});`, 'const scan = () => ({ messages: [{ source_id: "voice", kind: "audio" }] });')
  const read = runInNewContext(`(${source})`, {
    document: { querySelector: () => list }, getComputedStyle: () => ({ flexDirection: 'column-reverse' }),
    HTMLMediaElement: MediaElement, URL,
    setTimeout: (callback, ms) => ms === 15000 ? setTimeout(callback, ms) : (callback(), 0), clearTimeout,
    fetch: async url => { assert.equal(url, 'blob:decrypted'); return { blob: async () => new Blob(['audio']) } },
    FileReader: class { readAsDataURL() { this.result = 'data:audio/mpeg;base64,YXVkaW8='; this.onload() } },
  })
  const result = await read({ source_id: 'voice' }, 'audio')
  assert.equal(result.inline, 'data:audio/mpeg;base64,YXVkaW8=')
  assert.equal(MediaElement.prototype.play, originalPlay)
  assert.equal(list.scrollTop, 41)
  assert.equal(clicks, 2)
  assert.equal(paused, true)
})

test('语音没有解密后的 blob 时明确失败，仍清理播放拦截', async () => {
  const originalPlay = () => Promise.resolve()
  class MediaElement {}
  MediaElement.prototype.play = originalPlay
  const player = Object.assign(new MediaElement(), { tagName: 'AUDIO', src: 'https://encrypted.example/audio', pause() {} })
  let clicks = 0
  const box = { scrollIntoView() {}, click() { if (++clicks === 1) player.play() } }
  const row = { __reactFiber$test: { memoizedProps: { message: { serverId: 'voice' } } }, querySelector: () => box }
  const list = { scrollTop: 41, querySelectorAll: () => [row] }
  const source = IM_FIND_MEDIA_JS.replace(`const scan = (${IM_SCAN_JS});`, 'const scan = () => ({ messages: [{ source_id: "voice", kind: "audio" }] });')
  const read = runInNewContext(`(${source})`, {
    document: { querySelector: () => list }, getComputedStyle: () => ({ flexDirection: 'column-reverse' }),
    HTMLMediaElement: MediaElement, URL,
    setTimeout: (callback, ms) => ms === 15000 ? setTimeout(callback, ms) : (callback(), 0), clearTimeout,
  })
  await assert.rejects(read({ source_id: 'voice' }, 'audio'), /解密/)
  assert.equal(MediaElement.prototype.play, originalPlay)
  assert.equal(list.scrollTop, 41)
  assert.equal(clicks, 2)
})
