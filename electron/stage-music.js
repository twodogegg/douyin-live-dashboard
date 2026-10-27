import { randomUUID } from 'node:crypto'

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const artistName = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s/g, '')
const sameTrack = (a, b) => !!a && !!b && a.name === b.name && a.artist === b.artist
export const isSongRequest = text => /点|听|放|来一首|来首|\bplay\b/i.test(text)

export function matchRequestedSong(songs, request) {
  const name = normalize(request.name)
  const artist = artistName(request.artist)
  const candidates = songs.filter(song => {
    const title = normalize(song.name)
    return title.includes(name) && (!artist || song.artists.some(value => artistName(value) === artist))
  })
  const exact = candidates.filter(song => normalize(song.name) === name)
  const choices = exact.length ? exact : candidates
  if (!choices.length) throw new Error(`没有找到《${request.name}》${request.artist ? `（${request.artist}）` : ''}，请补充歌名或歌手`)
  if (choices.length > 1 && !(exact.length && new Set(exact.map(song => song.artists.map(artistName).join('|'))).size === 1)) {
    throw Object.assign(new Error(`《${request.name}》有多个版本`), { choices })
  }
  return choices[0]
}

export function createStageMusic({ mcp, parse, select, context, onChange = () => {}, pollMs = 1000 }) {
  let enabled = false
  let connected = false
  let playing = false
  let current = null
  let position = 0
  let duration = 0
  let queue = []
  let pending = 0
  let error = ''
  let notice = ''
  let epoch = 0
  let serial = Promise.resolve()
  let timer = null
  let polling = false
  let starting = false
  let closed = false
  let managed = null
  let lastState = null
  let failures = 0
  let blocked = false
  const snapshot = () => ({ enabled, connected, playing, current, next: queue[0] || null, queue: [...queue], pending, error, notice })
  const report = () => { if (!closed) onChange(snapshot()) }
  const apply = state => {
    connected = !!state.connected
    playing = !!state.playing
    current = state.current ? { ...state.current, ...(sameTrack(state.current, managed) ? { user: managed.user } : {}) } : null
    position = Number(state.position) || 0
    duration = Number(state.duration) || 0
  }
  const startNext = async (retry = false) => {
    if (closed || !enabled || !connected || starting || !queue.length || (blocked && !retry)) return
    starting = true
    const token = epoch
    const song = queue[0]
    try {
      const state = await mcp.call('netease_play_song', { songId: String(song.id), query: song.query })
      if (closed || token !== epoch) return
      if (!state.playing || !state.current || state.current.name !== song.name) throw new Error('网易云未确认歌曲开始播放')
      queue.shift()
      managed = { ...state.current, user: song.user }
      apply(state)
      lastState = { current, position, duration, playing }
      error = ''
      blocked = false
      notice = `正在播放 @${song.user} 点的《${song.name}》`
    } catch (e) {
      if (token === epoch && !closed) { blocked = true; error = String(e.message || e).slice(0, 350); notice = '待播歌曲已保留，可点击「播放下一首」重试' }
    } finally { starting = false; report() }
  }
  const poll = async () => {
    if (closed || polling || starting || !connected) return
    polling = true
    const token = epoch
    try {
      const state = await mcp.call('netease_now_playing')
      if (closed || token !== epoch) return
      const previous = lastState
      apply(state)
      failures = 0
      const ended = previous?.playing && previous.duration > 0 && previous.position >= previous.duration - 3
        && (!sameTrack(previous.current, current) || position < previous.position - 2 || !playing)
      const changed = managed && !sameTrack(managed, current)
      if (changed) managed = null
      lastState = { current, position, duration, playing }
      report()
      if (enabled && queue.length && (ended || changed || !current)) await startNext()
    } catch (e) {
      if (token === epoch && !closed && ++failures >= 3) {
        connected = false
        playing = false
        current = null
        lastState = null
        error = String(e.message || e).slice(0, 350)
        report()
      }
    } finally { polling = false }
  }
  return {
    snapshot,
    context: () => context?.().replace('{{music_status}}', () => JSON.stringify(snapshot())) || '',
    async connect() {
      const state = await mcp.call('netease_player_connect', { restart: true })
      if (closed) return snapshot()
      apply(state)
      failures = 0
      error = ''
      blocked = false
      lastState = { current, position, duration, playing }
      timer ||= setInterval(() => { void poll() }, pollMs)
      timer.unref?.()
      report()
      return snapshot()
    },
    configure(value) {
      if (enabled === value) return
      enabled = value
      epoch++
      queue = []
      managed = null
      pending = 0
      error = ''
      blocked = false
      notice = enabled ? '观众可发送「点歌 歌名 歌手」' : '观众点歌已关闭'
      report()
    },
    reset() {
      epoch++
      queue = []
      pending = 0
      managed = null
      notice = ''
      error = ''
      blocked = false
      report()
    },
    request(message) {
      if (!enabled || closed || !isSongRequest(message.text)) return
      if (!connected) { error = '请先连接网易云，再开启观众点歌'; report(); return }
      if (pending + queue.length >= 20) { error = '点歌队列已满，请稍后再点'; report(); return }
      const token = epoch
      pending++
      report()
      const operation = serial.then(async () => {
        if (closed || token !== epoch) return
        try {
          const request = await parse(message)
          if (closed || token !== epoch || !request) return
          if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 100 || typeof request.artist !== 'string' || request.artist.length > 100) throw new Error('没有识别到明确的歌名，请发送「点歌 歌名 歌手」')
          const query = `${request.name.trim()} ${request.artist.trim()}`.trim()
          const result = await mcp.call('netease_player_search', { query })
          if (closed || token !== epoch) return
          let song
          try { song = matchRequestedSong(result.songs || [], request) } catch (e) {
            if (!e.choices || !select) throw e
            notice = `正在为《${request.name}》自动选择版本`
            report()
            const index = await select({ message, request, candidates: e.choices })
            if (closed || token !== epoch) return
            if (index === -1) throw new Error(`搜索结果中没有符合要求的《${request.name}》版本`)
            if (!Number.isInteger(index) || index < 0 || index >= e.choices.length) throw new Error('歌曲版本自动选择失败，请稍后重试')
            song = e.choices[index]
          }
          if (playing && current?.name === song.name && song.artists.some(artist => current.artist.includes(artist))) { notice = `《${song.name}》正在播放`; return }
          if (queue.some(item => String(item.id) === String(song.id))) { notice = `《${song.name}》已经在队列中`; return }
          queue.push({ ...song, request_id: randomUUID(), user: message.user, query })
          if (!blocked) error = ''
          notice = `@${message.user} 点的《${song.name}》已排队`
          report()
          if (!playing && !managed) await startNext()
        } catch (e) {
          if (token === epoch && !closed) error = `@${message.user}：${String(e.message || e).slice(0, 300)}`
        } finally {
          if (token === epoch) pending--
          report()
        }
      })
      serial = operation.catch(() => {})
      return operation
    },
    async control(action) {
      if (!connected) throw new Error('请先连接网易云')
      if (action === 'next' && queue.length) {
        if (!enabled) throw new Error('请先开启观众点歌')
        await startNext(true)
      } else {
        if (!['next', 'play_pause'].includes(action)) throw new Error('播放操作无效')
        apply(await mcp.call('netease_player_control', { action }))
        lastState = { current, position, duration, playing }
        report()
      }
      return snapshot()
    },
    close() { closed = true; epoch++; clearInterval(timer); mcp.close() },
  }
}
