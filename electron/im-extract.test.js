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
