import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSongDetails, parseSongDetails } from './netease/song-details.js'
import { desktopStatus, desktopSearch } from './netease/player.js'
import { createMusicMcp } from './music-mcp.js'

const payload = { songs: [{ id: 1, name: '歌曲', ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 1000, private_field: '不应返回' }] }

test('本仓库内置歌曲接口映射元数据，不读取账号凭证或转发额外字段', async () => {
  let requested = false
  const result = await getSongDetails(['1'], { fetch: async (url, options) => {
    requested = true
    assert.equal(url.origin, 'https://music.163.com')
    assert.equal(url.pathname, '/api/song/detail/')
    assert.equal(url.searchParams.get('ids'), '[1]')
    assert.equal(Object.keys(options.headers).some(key => /cookie|authorization/i.test(key)), false)
    return Response.json(payload)
  } })
  assert.equal(requested, true)
  assert.deepEqual(result, { songs: [{ id: 1, name: '歌曲', artists: ['歌手'], album: '专辑', durationMs: 1000 }] })
  assert.deepEqual(parseSongDetails({}), { songs: [] })
})

test('歌曲标识校验、网络错误和取消会明确失败', async () => {
  for (const ids of [[], ['not-an-id'], ['9007199254740993'], Array(21).fill('1')]) await assert.rejects(getSongDetails(ids), /标识无效/)
  await assert.rejects(getSongDetails(['1'], { fetch: async () => new Response('', { status: 503 }) }), /HTTP 503/)
  await assert.rejects(getSongDetails(['1'], { fetch: async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) }), /非 JSON/)
  const signal = AbortSignal.abort(new Error('测试取消'))
  await assert.rejects(desktopStatus({ signal }), /测试取消/)
  await assert.rejects(desktopSearch('晴天', { signal }), /测试取消/)
})

test('默认内置工具可从本仓库直接加载，不依赖外部注册文件', async t => {
  const mcp = createMusicMcp()
  t.after(() => mcp.close())
  await assert.rejects(mcp.call('netease_player_search', { query: '' }), /请输入/)
  await assert.rejects(mcp.call('netease_play_song', { songId: 'invalid', query: '晴天' }), /标识无效/)
})
