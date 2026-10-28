export type AudioResult = { url: string; error: string }
type QueuedAudio = { controller: AbortController; objectUrl: string; promise: Promise<AudioResult> }

export function createStageAudioQueue({
  fetchAudio = fetch,
  createUrl = (blob: Blob) => URL.createObjectURL(blob),
  revokeUrl = (url: string) => URL.revokeObjectURL(url),
}: { fetchAudio?: typeof fetch; createUrl?: (blob: Blob) => string; revokeUrl?: (url: string) => void } = {}) {
  const items = new Map<string, QueuedAudio>()
  const discard = (id: string) => {
    const item = items.get(id)
    if (!item) return
    items.delete(id)
    item.controller.abort()
    if (item.objectUrl) revokeUrl(item.objectUrl)
  }
  return {
    get: (id: string) => items.get(id)?.promise,
    discard,
    clear: () => { for (const id of items.keys()) discard(id) },
    preload(id: string, url: string) {
      if (!url || items.has(id)) return
      const controller = new AbortController()
      const item: QueuedAudio = { controller, objectUrl: '', promise: Promise.resolve({ url: '', error: '' }) }
      items.set(id, item)
      item.promise = (async () => {
        try {
          const response = await fetchAudio(url, { signal: controller.signal })
          if (!response.ok) return { url: '', error: response.status === 410 ? '待播语音已过期，已跳过这条回复。' : '待播语音加载失败，已跳过这条回复。' }
          const blob = await response.blob()
          if (!blob.size || controller.signal.aborted) return { url: '', error: '待播语音为空，已跳过这条回复。' }
          item.objectUrl = createUrl(blob)
          return { url: item.objectUrl, error: '' }
        } catch {
          return { url: '', error: controller.signal.aborted ? '' : '待播语音加载失败，已跳过这条回复。' }
        }
      })()
    },
  }
}
