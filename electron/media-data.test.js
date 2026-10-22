import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mediaIdentity, normalizeNote, parseNoteState } from './media-data.js'

test('资源匹配忽略 CDN、签名与尺寸，保留不同资源之间的差异', () => {
  assert.equal(mediaIdentity('https://p3.douyinpic.com/img/tos-cn/photo~thumb.webp?s=1'), mediaIdentity('https://p9.douyinpic.com/obj/tos-cn/photo~large.image?s=2'))
  assert.notEqual(mediaIdentity('https://p3.douyinpic.com/photo-a'), mediaIdentity('https://p3.douyinpic.com/photo-b'))
  assert.equal(mediaIdentity('blob:https://www.douyin.com/transient'), '')
})

test('图文页面提取正文与全部图片，正确处理正文中的括号和转义引号', () => {
  const note = { awemeId: '123', desc: '正文含有 {括号}、"引号" 和换行\n第二行', authorInfo: { nickname: '作者' },
    images: [{ urlList: ['https://p3.douyinpic.com/one'] }, { urlList: ['https://p9.douyinpic.com/two'] }] }
  const state = [[1, JSON.stringify({ detail: { ...note, awemeId: 'other' } })], [1, JSON.stringify({ detail: note, other: '{}' })]]
  const result = parseNoteState(state, '123')
  assert.equal(result.desc, note.desc)
  assert.equal(result.author.nickname, '作者')
  assert.deepEqual(result.images.map(i => i.url_list[0]), ['https://p3.douyinpic.com/one', 'https://p9.douyinpic.com/two'])
  assert.equal(parseNoteState(state, 'missing'), null)
})

test('没有页面初始状态时，组件详情保留完整图片与正文并校验作品 ID', () => {
  const detail = { awemeId: '123', desc: '图文正文', authorInfo: { nickname: '作者' },
    images: [{ urlList: ['https://p3.douyinpic.com/one'] }, { urlList: ['https://p9.douyinpic.com/two'] }] }
  assert.equal(normalizeNote(detail, 'other'), null)
  assert.equal(normalizeNote(null, '123'), null)
  assert.equal(normalizeNote(detail, '123').desc, '图文正文')
  assert.equal(normalizeNote(detail, '123').images.length, 2)
})
