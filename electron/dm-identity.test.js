import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { currentAccount } from './dm-identity.js'
import { IM_SCAN_JS } from './im-extract.js'

test('使用实际私信运行时的 curLoginUserInfo.uid，保留字符串 ID 精度', () => {
  assert.equal(currentAccount({ curLoginUserInfo: { uid: '9007199254740993123', secUid: 'unused' } }), '9007199254740993123')
  for (const store of [undefined, {}, { curLoginUserInfo: null }, { curLoginUserInfo: { uid: 123 } }, { curLoginUserInfo: { uid: '0' } }, { curLoginUserInfo: { uid: 'old-account' } }]) assert.equal(currentAccount(store), '')
})

test('真实 DOM 扫描入口携带当前账号，不依赖返回参数错误的 query/user 请求', () => {
  const document = { querySelectorAll: () => [], querySelector: () => null }
  const scan = vm.runInNewContext(`(${IM_SCAN_JS})`, { document, window: { userInfoStore: { curLoginUserInfo: { uid: '100' } } }, location: { href: 'https://www.douyin.com/chat' }, innerWidth: 1200, innerHeight: 800 })
  assert.equal(scan().account_id, '100')
  assert.doesNotMatch(IM_SCAN_JS, /fetch\(/)
})
