import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { EXTRACT_JS } from './extract.js'
import { parseRoomEvent } from './gift-points.js'

function capture(text, { user = '小鹿', chat = false } = {}) {
  let observer
  const body = { nodeType: 1, closest: () => null, querySelectorAll: () => [] }
  const document = { body, querySelector: () => null, querySelectorAll: () => [] }
  const context = {
    window: {}, document,
    MutationObserver: class {
      constructor(callback) { observer = callback }
      observe() {}
      disconnect() {}
    },
  }
  const extract = vm.runInNewContext(EXTRACT_JS, context)
  extract()
  const item = {
    nodeType: 1, innerText: text, textContent: text,
    closest() { return this },
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === '.cL385mHb') return chat ? { textContent: text } : null
      if (selector.startsWith('.v8LY0gZF')) return { textContent: user }
      return null
    },
  }
  observer([{ target: item, addedNodes: [] }])
  return extract().events
}

test('关注和礼物提示可触发事件，普通聊天中的相同词语不会误触发', () => {
  assert.equal(capture('小鹿 关注了主播')[0]?.kind, 'follow')
  assert.equal(capture('小鹿：我刚关注了主播', { chat: true }).length, 0)
  assert.equal(capture('小鹿 关注了主播真的吗').length, 0)
  const gift = capture('小鹿 送出了 小心心')[0]
  assert.equal(gift?.kind, 'gift')
  assert.equal(gift?.count, 1)
  assert.equal(parseRoomEvent(gift.text, { user: gift.user })?.gift, '小心心')
  const counted = capture('小鹿 送出 小心心 X2')[0]
  assert.equal(counted?.count, 2)
  assert.equal(parseRoomEvent(counted.text, { user: counted.user })?.count, 2)
})
