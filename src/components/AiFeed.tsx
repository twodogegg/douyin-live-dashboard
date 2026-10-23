import { Sparkles } from 'lucide-react'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from './ui/empty'
import { Skeleton } from './ui/skeleton'
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
        <Empty><EmptyHeader><EmptyMedia variant="icon"><Sparkles /></EmptyMedia><EmptyTitle>把热闹，变成洞察</EmptyTitle><EmptyDescription>连接直播间后，AI 会按时间窗口整理互动重点。</EmptyDescription></EmptyHeader></Empty>
      )}
      {cards.map((c) => (
        <div className={`ai-card${c.pending ? ' pending' : ''}`} key={`${c.time}-${c.count}`}>
          <div className="meta">
            <span>
              {c.time} · 本时段 {c.count} 条{c.model ? ` · ${c.model}` : ''}
            </span>
          </div>
          <div className="body">{c.pending ? <div className="flex flex-col gap-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" /><span>正在整理本时段的对话…</span></div> : c.summary}</div>
        </div>
      ))}
    </div>
  )
}
