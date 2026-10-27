// Adapted from netease-music-mcp (MIT). See LICENSE and README.md in this directory.
export function parseSongDetails(payload) {
  return {
    songs: (Array.isArray(payload?.songs) ? payload.songs : []).map(song => ({
      id: song.id,
      name: song.name || '',
      artists: (song.artists || song.ar || []).map(artist => artist.name).filter(Boolean),
      album: (song.album || song.al)?.name || '',
      durationMs: song.duration ?? song.dt ?? null,
    })),
  }
}

export async function getSongDetails(songIds, { signal, fetch: request = fetch } = {}) {
  if (!Array.isArray(songIds) || !songIds.length || songIds.length > 20 || songIds.some(id => !/^\d{1,20}$/.test(String(id)) || !Number.isSafeInteger(Number(id)))) throw new Error('歌曲标识无效')
  const url = new URL('https://music.163.com/api/song/detail/')
  url.searchParams.set('ids', JSON.stringify(songIds.map(Number)))
  const timeout = AbortSignal.timeout(12000)
  const response = await request(url, {
    headers: { Accept: 'application/json', Referer: 'https://music.163.com/', 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/136 Safari/537.36' },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`网易云接口返回 HTTP ${response.status}`)
  if (!response.headers.get('content-type')?.toLowerCase().includes('json')) throw new Error('网易云接口返回了非 JSON 内容')
  return parseSongDetails(await response.json())
}
