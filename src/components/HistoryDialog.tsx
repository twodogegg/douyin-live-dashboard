import { useEffect, useState } from 'react'
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
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dlg wide">
        <h3>
          历史摘要<span className="hint">点条目展开该时段的原始消息</span>
        </h3>
        <div className="hlist">
          {wins === null && <div className="ai-hint">加载中…</div>}
          {wins !== null && !wins.length && <div className="ai-hint">暂无历史摘要</div>}
          {(wins ?? []).map((w) => (
            <div
              key={w.id}
              className={`hitem${openId === w.id ? ' open' : ''}`}
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
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
