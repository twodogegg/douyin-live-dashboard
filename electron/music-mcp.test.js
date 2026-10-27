import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMusicMcp } from './music-mcp.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

test('内置工具串行执行，保留参数、结果与错误，不需要外部服务配置', async () => {
  const calls = []
  let active = 0
  const mcp = createMusicMcp({ tools: {
    async netease_player_search(args, { signal }) {
      assert.equal(active++, 0)
      assert.equal(signal.aborted, false)
      calls.push(args.query)
      await flush()
      active--
      if (args.query === '失败') throw new Error('播放器不可用')
      return { songs: [{ name: args.query }] }
    },
  } })
  try {
    assert.deepEqual(await Promise.all([mcp.call('netease_player_search', { query: '晴天' }), mcp.call('netease_player_search', { query: '稻香' })]), [{ songs: [{ name: '晴天' }] }, { songs: [{ name: '稻香' }] }])
    assert.deepEqual(calls, ['晴天', '稻香'])
    await assert.rejects(mcp.call('netease_player_search', { query: '失败' }), /播放器不可用/)
    assert.equal((await mcp.call('netease_player_search', { query: '恢复' })).songs[0].name, '恢复')
    await assert.rejects(mcp.call('__proto__'), /未知的网易云工具/)
  } finally { mcp.close() }
})

test('关闭连接会取消当前操作，后续排队的工具不再执行', async () => {
  const calls = []
  const mcp = createMusicMcp({ tools: {
    netease_player_search(args, { signal }) {
      calls.push(args.query)
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  } })
  const current = mcp.call('netease_player_search', { query: '当前' })
  const next = mcp.call('netease_player_search', { query: '下一个' })
  const settled = Promise.allSettled([current, next])
  await flush()
  mcp.close()
  const result = await settled
  assert.ok(result.every(item => item.status === 'rejected' && /已关闭/.test(item.reason.message)))
  assert.deepEqual(calls, ['当前'])
  await assert.rejects(mcp.call('netease_now_playing'), /已关闭/)
})
