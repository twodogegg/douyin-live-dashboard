import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from './ui/empty'
import { Skeleton } from './ui/skeleton'
import { cn } from '../lib/utils'
import { api, type HistoryMessage, type HistoryWindow } from '../api'

export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const [wins, setWins] = useState<HistoryWindow[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [msgs, setMsgs] = useState<Record<number, HistoryMessage[]>>({})

  useEffect(() => {
    api.history().then((d) => setWins(d?.windows ?? []))
  }, [])

  const toggle = async (id: number) => {
    if (openId === id) {
      setOpenId(null)
      return
    }
    setOpenId(id)
    if (!msgs[id]) {
      const r = await api.historyWindow(id)
      setMsgs((prev) => ({ ...prev, [id]: r?.messages ?? [] }))
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="settings-content sm:max-w-3xl"><DialogHeader><DialogTitle>历史摘要</DialogTitle><DialogDescription>展开任一时段，回看摘要和对应的原始消息。</DialogDescription></DialogHeader>
        <div className="hlist">
          {wins === null && <Skeleton className="h-24 w-full" />}
          {wins !== null && !wins.length && <Empty><EmptyHeader><EmptyMedia variant="icon"><History /></EmptyMedia><EmptyTitle>还没有历史摘要</EmptyTitle><EmptyDescription>开始分析直播互动后，摘要会保存在这里。</EmptyDescription></EmptyHeader></Empty>}
          {(wins ?? []).map((w) => (
            <div
              key={w.id}
              className={cn('hitem', openId === w.id && 'open')}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(w.id) } }}
              onClick={() => toggle(w.id)}
            >
              <div className="hm">
                <span>
                  {w.time} · 本时段 {w.n} 条{w.model ? ` · ${w.model}` : ''}
                </span>
                <span>#{w.id}</span>
              </div>
              <div className="hs">{w.summary || '（分析中…）'}</div>
              {openId === w.id && (
                <div className="hl">
                  {msgs[w.id] === undefined ? (
                    <div className="r2" style={{ color: 'var(--dim)' }}>
                      加载中…
                    </div>
                  ) : msgs[w.id].length ? (
                    msgs[w.id].map((m, i) => (
                      <div className="r2" key={i}>
                        <span className="rg">{m.region === 'r1' ? '主播' : '观众'}</span>
                        <span className="nm">{m.user || '—'}</span> {m.text}
                      </div>
                    ))
                  ) : (
                    <div className="r2" style={{ color: 'var(--dim)' }}>
                      无原始消息
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="row">
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </div>
    </DialogContent></Dialog>
  )
}
