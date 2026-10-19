import { useLayoutEffect, useRef } from 'react'
import { hashColor, norm } from '../lib/norm'
import type { MsgItem } from '../types'

export function Avatar({ name, avatars }: { name: string; avatars: Record<string, string> }) {
  const url = avatars[norm(name)]
  return (
    <span className="av">
      {url ? (
        <img src={url} referrerPolicy="no-referrer" loading="lazy" alt="" />
      ) : (
        <i style={{ background: hashColor(name) }}>
          {Array.from((name || '?').trim())[0] || '?'}
        </i>
      )}
    </span>
  )
}

/** 消息流：区域1 就地更新同一条，区域2 逐条追加。 */
export function MessageFeed({
  items,
  avatars,
  fallbackName,
  region,
}: {
  items: MsgItem[]
  avatars: Record<string, string>
  fallbackName: string
  region: 'r1' | 'r2'
}) {
  const ref = useRef<HTMLDivElement>(null)

  // 只在用户本来就贴近底部时自动跟随，避免打断向上翻看
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [items])

  return (
    <div className={`feed ${region}`} ref={ref}>
      {items.map((it) => (
        <div className="msg" key={it.id}>
          <Avatar name={it.user} avatars={avatars} />
          <div className="mbody">
            <span className="u">{it.user || fallbackName}</span>
            <span className="t">{it.time}</span>
            <br />
            <span className="b">{it.text}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
