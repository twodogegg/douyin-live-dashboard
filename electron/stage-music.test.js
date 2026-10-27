import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStageMusic, matchRequestedSong, isSongRequest } from './stage-music.js'

const songs = [
  { id: 1, name: '晴天', artists: ['周杰伦'] },
  { id: 2, name: '稻香', artists: ['周杰伦'] },
]
const state = (index, position = 0, playing = true) => ({ connected: true, playing, current: index === null ? null : { name: songs[index].name, artist: songs[index].artists[0] }, position, duration: index === null ? 0 : 100 })
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, overrides = {}) {
  let actual = state(null, 0, false)
  let parse = async message => ({ name: message.text.replace('点歌 ', ''), artist: '周杰伦' })
  const calls = []
  const mcp = {
    async call(name, args) {
      calls.push([name, args])
      if (name === 'netease_player_search') return { songs }
      if (name === 'netease_play_song') {
        actual = state(songs.findIndex(s => String(s.id) === args.songId))
        return actual
      }
      if (name === 'netease_player_control') { actual = { ...actual, playing: !actual.playing }; return actual }
      return actual
    },
    close() {},
  }
  const music = createStageMusic({ mcp, parse: message => parse(message), ...overrides })
  t.after(() => music.close())
  music.configure(true)
  return { music, calls, setState: value => { actual = value }, setParse: value => { parse = value } }
}

test('按歌名和歌手匹配，重名和翻唱不盲选', () => {
  assert.equal(matchRequestedSong([...songs, { id: 3, name: '晴天', artists: ['翻唱歌手'] }], { name: '晴天', artist: '周杰伦' }).id, 1)
  assert.throws(() => matchRequestedSong([...songs, { id: 3, name: '晴天', artists: ['翻唱歌手'] }], { name: '晴天', artist: '' }), /多个版本/)
  assert.throws(() => matchRequestedSong(songs, { name: '不存在', artist: '' }), /没有找到/)
  assert.throws(() => matchRequestedSong([{ id: 3, name: '稻香(治愈版)', artists: ['周杰伦.'] }], { name: '稻香', artist: '周杰伦' }), /没有找到/)
  assert.equal(matchRequestedSong([songs[0], { ...songs[0], id: 4 }], { name: '晴天', artist: '周杰伦' }).id, 1)
  assert.ok(isSongRequest('帮我放晴天'))
  assert.equal(isSongRequest('你好'), false)
})

test('所有点歌按顺序处理，歌曲真正播放后才移出队列，结束后自动播放下一首', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { music, calls, setState } = fixture(t)
  await music.connect()
  const first = music.request({ user: '甲', text: '点歌 晴天' })
  const second = music.request({ user: '乙', text: '点歌 稻香' })
  await Promise.all([first, second])
  assert.equal(music.snapshot().current.name, '晴天')
  assert.equal(music.snapshot().current.user, '甲')
  assert.equal(music.snapshot().next.name, '稻香')
  setState(state(0, 99))
  t.mock.timers.tick(1000)
  await flush()
  // 网易云自身切歌或进度归零，也会推进本应用队列。
  setState(state(0, 0))
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(music.snapshot().current.name, '稻香')
  assert.equal(music.snapshot().next, null)
  assert.deepEqual(calls.filter(([name]) => name === 'netease_play_song').map(([, args]) => args.songId), ['1', '2'])
})

test('暂停不会自动跳歌；重复待播歌曲合并；手动下一首使用点歌队列', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { music, setState } = fixture(t)
  await music.connect()
  await music.request({ user: '甲', text: '点歌 晴天' })
  await music.request({ user: '乙', text: '点歌 稻香' })
  await music.request({ user: '丙', text: '点歌 稻香' })
  assert.equal(music.snapshot().queue.length, 1)
  setState(state(0, 20, false))
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(music.snapshot().current.name, '晴天')
  assert.equal(music.snapshot().playing, false)
  await music.control('next')
  assert.equal(music.snapshot().current.name, '稻香')
})

test('关闭点歌或切房时，迟到搜索不再入队或播放', async t => {
  let finish
  const { music, calls, setParse } = fixture(t)
  await music.connect()
  setParse(() => new Promise(resolve => { finish = resolve }))
  const work = music.request({ user: '甲', text: '点歌 晴天' })
  await flush()
  music.reset()
  finish({ name: '晴天', artist: '周杰伦' })
  await work
  assert.equal(music.snapshot().pending, 0)
  assert.equal(music.snapshot().queue.length, 0)
  assert.equal(calls.some(([name]) => name === 'netease_play_song'), false)
  music.configure(false)
  assert.equal(music.request({ user: '甲', text: '点歌 稻香' }), undefined)
})

test('播放失败保留待播歌曲，连续断线后不显示陈旧在播状态', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let failStatus = false
  const { music } = fixture(t, { mcp: {
    async call(name) {
      if (name === 'netease_player_connect') return state(null, 0, false)
      if (name === 'netease_player_search') return { songs }
      if (name === 'netease_play_song') throw new Error('歌曲不可播放')
      if (failStatus) throw new Error('客户端已关闭')
      return state(null, 0, false)
    },
    close() {},
  } })
  await music.connect()
  await music.request({ user: '甲', text: '点歌 晴天' })
  assert.match(music.snapshot().error, /不可播放/)
  assert.equal(music.snapshot().next.name, '晴天')
  assert.equal(music.snapshot().current, null)
  failStatus = true
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await flush() }
  assert.equal(music.snapshot().connected, false)
  assert.match(music.snapshot().error, /客户端已关闭/)
})

test('重名版本由模型自动选择，并使用候选中的真实歌曲加入队列', async t => {
  let context
  const candidates = [songs[0], { id: 3, name: '晴天', artists: ['翻唱歌手'], album: '翻唱专辑' }]
  const { music, calls, setParse } = fixture(t, { select: async value => { context = value; return 1 } })
  setParse(async () => ({ name: '晴天', artist: '' }))
  await music.connect()
  // 复用 fixture 的 MCP，并增加一个重名候选。
  songs.push(candidates[1])
  t.after(() => songs.pop())
  await music.request({ user: '观众', text: '点歌 晴天' })
  assert.equal(context.message.user, '观众')
  assert.equal(context.candidates[1].album, '翻唱专辑')
  assert.equal(music.snapshot().current.artist, '翻唱歌手')
  assert.equal(music.snapshot().error, '')
  assert.equal(calls.find(([name]) => name === 'netease_play_song')[1].songId, '3')
})

test('指定歌手优先，不交给模型覆盖；模型非法选择或拒绝时不播放', async t => {
  let selected = 0
  const { music } = fixture(t, { select: async () => { selected++; return 0 } })
  await music.connect()
  await music.request({ user: '观众', text: '点歌 晴天' })
  assert.equal(selected, 0)
  assert.equal(music.snapshot().current.artist, '周杰伦')

  for (const index of [-1, 99, '0', null]) {
    const { music: invalid, calls, setParse } = fixture(t, { select: async () => index })
    setParse(async () => ({ name: '', artist: '' }))
    // 「天」可同时匹配「晴天」和下面的另一个候选。
    setParse(async () => ({ name: '晴', artist: '' }))
    songs.push({ id: 4, name: '晴朗', artists: ['其他歌手'] })
    try {
      await invalid.connect()
      await invalid.request({ user: '观众', text: '点歌 晴' })
      assert.match(invalid.snapshot().error, index === -1 ? /没有符合要求/ : /自动选择失败/)
      assert.equal(calls.some(([name]) => name === 'netease_play_song'), false)
    } finally { songs.pop() }
  }
})

test('模型选版本期间切换房间，迟到的选择结果不再入队', async t => {
  let finish
  const { music, calls, setParse } = fixture(t, { select: () => new Promise(resolve => { finish = resolve }) })
  setParse(async () => ({ name: '晴', artist: '' }))
  songs.push({ id: 4, name: '晴朗', artists: ['其他歌手'] })
  t.after(() => songs.pop())
  await music.connect()
  const work = music.request({ user: '观众', text: '点歌 晴' })
  await flush()
  music.reset()
  finish(1)
  await work
  assert.equal(music.snapshot().pending, 0)
  assert.equal(music.snapshot().next, null)
  assert.equal(calls.some(([name]) => name === 'netease_play_song'), false)
})
