import { useLayoutEffect, useRef } from 'react'
import type { AiCard } from '../types'

export function AiFeed({ cards }: { cards: AiCard[] }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [cards])

  return (
    <div className="feed ai" ref={ref}>
      {!cards.length && (
        <div className="ai-hint">点右上角「设置」填入 API Key 后，将按时间窗自动生成摘要</div>
      )}
      {cards.map((c) => (
        <div className={`ai-card${c.pending ? ' pending' : ''}`} key={`${c.time}-${c.count}`}>
          <div className="meta">
            <span>
              {c.time} · 本时段 {c.count} 条{c.model ? ` · ${c.model}` : ''}
            </span>
          </div>
          <div className="body">{c.pending ? '分析中…' : c.summary}</div>
        </div>
      ))}
    </div>
  )
}
