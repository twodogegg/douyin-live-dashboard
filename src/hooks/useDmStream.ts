import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { DmConv, DmMemory, DmMsg, DmStat } from '../types'

const INITIAL_STAT: DmStat = {
  status: '未启动',
  running: false,
  conv_count: 0,
  active_id: '',
  unread: 0,
  last_scan: '',
  sending: false,
}

type WsMessage = Record<string, unknown> & { type: string }

/** 私信工作台：会话列表、当前对话消息、后台状态。 */
export function useDmStream() {
  const [stat, setStat] = useState<DmStat>(INITIAL_STAT)
  const [convs, setConvs] = useState<DmConv[]>([])
  const [activeId, setActiveId] = useState('')
  const [msgs, setMsgs] = useState<DmMsg[]>([])
  const [memory, setMemory] = useState<DmMemory | null>(null)
  const [wsDown, setWsDown] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selectionError, setSelectionError] = useState('')
  const activeRef = useRef('')
  const selection = useRef(0)
  const accountEpoch = useRef(0)

  const activateConv = useCallback((id: string) => {
    selection.current++
    activeRef.current = id
    setActiveId(id)
    setSelecting(false)
    setSelectionError('')
  }, [])

  useEffect(() => {
    activeRef.current = activeId
    setMemory(null)
    if (!activeId) {
      setMsgs([])
      return
    }
    let alive = true
    setMsgs([])
    api.dmMsgs(activeId).then((r) => {
      if (alive && r) setMsgs(prev => [...new Map([...r.messages, ...prev.filter(m => m.conv_id === activeId)].map(m => [m.key, m])).values()].sort((a, b) => a.ts - b.ts))
    })
    api.dmMemory(activeId).then(r => { if (alive && r) setMemory(r) })
    setConvs((prev) => prev.map((c) => (c.id === activeId ? { ...c, unread: 0 } : c)))
    return () => {
      alive = false
    }
  }, [activeId])

  const refreshConvs = useCallback(async () => {
    const epoch = accountEpoch.current
    const r = await api.dmConvs()
    if (r && epoch === accountEpoch.current) setConvs(r.conversations)
  }, [])

  // 选中会话时同步在私信窗口里打开它，后续发送才对得上
  const openConv = useCallback(async (id: string) => {
    const version = ++selection.current
    setSelecting(true)
    setSelectionError('')
    const r = await api.dmSelect(id)
    if (version !== selection.current) return
    setSelecting(false)
    if (!r?.ok) {
      setSelectionError(r?.msg || '切换会话失败')
      return
    }
    activeRef.current = id
    setActiveId(id)
  }, [])

  // 首次进入：拉一次状态与已有会话
  useEffect(() => {
    api.dmStatus().then((s) => s && setStat(s))
    refreshConvs()
  }, [refreshConvs])

  useEffect(() => {
    let ws: WebSocket | null = null
    let timer: number | undefined
    let closed = false

    const upsert = (conv: DmConv) =>
      setConvs((prev) => {
        const next = prev.filter((c) => c.id !== conv.id && c.id !== conv.legacy_id)
        next.push(conv)
        return next.sort((a, b) => b.last_ts - a.last_ts)
      })

    const handle = (m: WsMessage) => {
      switch (m.type) {
        case 'dm_account':
          accountEpoch.current++
          activateConv('')
          setConvs([])
          refreshConvs()
          break
        case 'dm_stat':
          setStat({ ...INITIAL_STAT, ...(m as unknown as Partial<DmStat>) })
          break
        case 'dm_conv':
          if (m.conv) upsert(m.conv as DmConv)
          break
        case 'dm_policy':
          setConvs(prev => prev.map(c => c.id === m.conv_id ? { ...c, auto_reply_blocked: Number(m.blocked) } : c))
          break
        case 'dm_memory':
          if (m.conv_id === activeRef.current) setMemory(m.memory as DmMemory)
          break
        case 'dm_selected':
          activateConv(String(m.conv_id))
          refreshConvs()
          break
        case 'dm_msg_update': {
          const msg = m.msg as DmMsg
          if (msg?.conv_id === activeRef.current) {
            setMsgs(prev => [...prev.filter(x => x.key !== msg.key && x.key !== m.old_key), msg].sort((a, b) => a.ts - b.ts))
          }
          break
        }
        case 'dm_msg': {
          const msg = m.msg as DmMsg
          if (!msg) break
          if (msg.conv_id === activeRef.current) {
            setMsgs((prev) => (prev.some((x) => x.key === msg.key) ? prev : [...prev, msg]))
          }
          setConvs((prev) =>
            prev.map((c) =>
              c.id === msg.conv_id
                ? {
                    ...c,
                    preview: msg.text,
                    last_ts: msg.ts,
                    last_time: msg.time,
                    unread: msg.conv_id === activeRef.current || msg.direction === 'out' ? 0 : c.unread + 1,
                  }
                : c,
            ),
          )
          break
        }
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
  }, [refreshConvs, activateConv])

  return { stat, convs, activeId, msgs, memory, wsDown, selecting, selectionError, openConv, activateConv, refreshConvs }
}
