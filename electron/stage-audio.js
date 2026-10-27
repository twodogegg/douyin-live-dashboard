import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// 音频只在当前播出任务内有效，不落盘、不缓存，不允许重复请求触发二次合成。
export function createStageAudio(streamSpeech, { ttl = 30000 } = {}) {
  const tickets = new Map()
  const preparing = new Set()
  const clear = () => {
    for (const controller of preparing) controller.abort()
    for (const ticket of tickets.values()) { clearTimeout(ticket.timer); ticket.controller.abort() }
    tickets.clear()
  }

  return {
    clear,
    async prepare(text) {
      const controller = new AbortController()
      preparing.add(controller)
      try {
        const body = await streamSpeech(text, controller.signal)
        if (controller.signal.aborted) { await body.cancel(); throw new Error('语音任务已取消') }
        if (tickets.size >= 10) throw new Error('待播语音过多，请稍后再试')
        const id = randomUUID()
        const timer = setTimeout(() => { tickets.delete(id); controller.abort() }, ttl)
        timer.unref?.()
        tickets.set(id, { body, controller, timer, claimed: false })
        return { url: `/stage/audio/${id}` }
      } catch (e) { controller.abort(); throw e } finally { preparing.delete(controller) }
    },
    async serve(req, res, id) {
      const ticket = tickets.get(id)
      if (!ticket || ticket.claimed) { res.writeHead(410); return res.end('Audio stream expired') }
      ticket.claimed = true
      clearTimeout(ticket.timer)
      const cancel = () => ticket.controller.abort()
      res.once('close', cancel)
      try {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'X-Accel-Buffering': 'no' })
        let bytes = 0
        const limit = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length
          callback(bytes > 20 * 1024 * 1024 ? new Error('音频超过 20 MB') : null, chunk)
        } })
        await pipeline(Readable.fromWeb(ticket.body), limit, res, { signal: ticket.controller.signal })
      } finally {
        res.off('close', cancel)
        ticket.controller.abort()
        tickets.delete(id)
      }
    },
  }
}
