import { useEffect, useState } from 'react'
import { norm } from '../lib/norm'
import type { AiCard, MsgItem, Stat } from '../types'

const MAX_KEEP = 300

export const INITIAL_STAT: Stat = {
  status: '待机',
  room: '',
  room_id: '',
  r1_count: 0,
  r2_count: 0,
  ai_count: 0,
  last_ai: '',
  logged_in: false,
}

type WsMessage = Record<string, unknown> & { type: string }

/**
 * WebSocket /ws 的实时推送：区域1 流式上屏（同一行就地更新）、区域2 弹幕（逐条追加）、
 * AI 摘要卡片、状态与头像池。协议与旧看板保持一致。
 */
export function useLiveStream() {
  const [r1, setR1] = useState<MsgItem[]>([])
  const [r2, setR2] = useState<MsgItem[]>([])
  const [ai, setAi] = useState<AiCard[]>([])
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [stat, setStat] = useState<Stat>(INITIAL_STAT)
  const [wsDown, setWsDown] = useState(false)

  useEffect(() => {
    let ws: WebSocket | null = null
    let timer: number | undefined
    let closed = false

    // 有真实头像就存进池子（后端较晚才学到的用户名也能回填到已有气泡）
    const learnAvatar = (user: string, avatar?: string) => {
      if (!avatar) return
      const key = norm(user)
      setAvatars((prev) => (prev[key] ? prev : { ...prev, [key]: avatar }))
    }

    const handle = (m: WsMessage) => {
      switch (m.type) {
        case 'r1':
          learnAvatar(m.user as string, m.avatar as string | undefined)
          setR1((prev) => {
            const i = prev.findIndex((x) => x.id === m.id)
            if (i >= 0) {
              const next = prev.slice()
              next[i] = { ...next[i], text: m.text as string }
              return next
            }
            return [
              ...prev,
              { id: m.id as string, user: m.user as string, text: m.text as string, time: m.time as string },
            ].slice(-MAX_KEEP)
          })
          break
        case 'r2':
          learnAvatar(m.user as string, m.avatar as string | undefined)
          setR2((prev) =>
            [
              ...prev,
              { id: m.id as number, user: m.user as string, text: m.text as string, time: m.time as string },
            ].slice(-MAX_KEEP),
          )
          break
        case 'reset':
          setR1([])
          setR2([])
          setAi([])
          break
        case 'avatars':
          setAvatars((prev) => ({ ...prev, ...((m.map as Record<string, string>) || {}) }))
          break
        case 'ai_pending':
          setAi((prev) =>
            [...prev, { time: m.time as string, count: m.count as number, pending: true }].slice(-MAX_KEEP),
          )
          break
        case 'ai_drop':
          setAi((prev) => prev.filter((x) => !(x.pending && x.time === m.time)))
          break
        case 'ai': {
          const card: AiCard = {
            time: m.time as string,
            count: m.count as number,
            summary: m.summary as string,
            model: m.model as string,
          }
          setAi((prev) => {
            const i = prev.findIndex((x) => x.pending && x.time === card.time)
            if (i >= 0) {
              const next = prev.slice()
              next[i] = card
              return next
            }
            return [...prev, card].slice(-MAX_KEEP)
          })
          break
        }
        case 'stat':
          setStat({ ...INITIAL_STAT, ...(m as unknown as Partial<Stat>) })
          break
      }
    }

    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws`)
      ws.onopen = () => setWsDown(false)
      ws.onmessage = (e) => {
        try {
          handle(JSON.parse(e.data) as WsMessage)
        } catch {
          /* 忽略异常帧 */
        }
      }
      ws.onclose = () => {
        setWsDown(true)
        if (!closed) timer = window.setTimeout(connect, 3000)
      }
    }
    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [])

  return { r1, r2, ai, avatars, stat, wsDown }
}
