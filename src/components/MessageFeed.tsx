import { MessageSquare } from 'lucide-react'
import { norm } from '../lib/norm'
import type { MsgItem } from '../types'
import { Avatar as UserAvatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { Message, MessageAvatar, MessageContent, MessageHeader, MessageFooter } from './ui/message'
import { Bubble, BubbleContent } from './ui/bubble'
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton } from './ui/message-scroller'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from './ui/empty'

export function Avatar({ name, avatars }: { name: string; avatars: Record<string, string> }) {
  return <UserAvatar><AvatarImage src={avatars[norm(name)]} alt={name} referrerPolicy="no-referrer" /><AvatarFallback>{Array.from((name || '?').trim())[0] || '?'}</AvatarFallback></UserAvatar>
}

export function MessageFeed({ items, avatars, fallbackName, region }: { items: MsgItem[]; avatars: Record<string, string>; fallbackName: string; region: 'r1' | 'r2' }) {
  return <MessageScrollerProvider autoScroll><MessageScroller><MessageScrollerViewport><MessageScrollerContent className="p-4">
    {!items.length && <MessageScrollerItem messageId={`empty-${region}`}><Empty><EmptyHeader><EmptyMedia variant="icon"><MessageSquare /></EmptyMedia><EmptyTitle>等待新的声音</EmptyTitle><EmptyDescription>{region === 'r1' ? '主播侧的公屏消息会实时显示在这里。' : '观众的每一条互动，都会在这里汇集。'}</EmptyDescription></EmptyHeader></Empty></MessageScrollerItem>}
    {items.map(it => <MessageScrollerItem key={it.id} messageId={String(it.id)}><Message><MessageAvatar><Avatar name={it.user} avatars={avatars} /></MessageAvatar><MessageContent><MessageHeader>{it.user || fallbackName}</MessageHeader><Bubble variant="muted"><BubbleContent><span className="dm-text">{it.text}</span></BubbleContent></Bubble><MessageFooter>{it.time}</MessageFooter></MessageContent></Message></MessageScrollerItem>)}
  </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton aria-label="跳到最新消息" /></MessageScroller></MessageScrollerProvider>
}
