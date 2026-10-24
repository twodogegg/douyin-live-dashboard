import { ArrowLeft, ArrowUpRight, AudioLines, BookOpen, Bot, CheckCheck, ChevronRight, CirclePause, Inbox, MessageSquare, Paperclip, Play, Radio, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, Users, X } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { Badge } from './ui/badge'
import { Card, CardHeader, CardDescription, CardTitle, CardContent } from './ui/card'
import { Avatar, AvatarImage, AvatarFallback } from './ui/avatar'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'
import { Textarea } from './ui/textarea'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from './ui/empty'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Skeleton } from './ui/skeleton'
import { Message, MessageAvatar, MessageContent, MessageHeader, MessageFooter } from './ui/message'
import { Bubble, BubbleContent } from './ui/bubble'
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton } from './ui/message-scroller'
import { cn } from '../lib/utils'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useDmStream } from '../hooks/useDmStream'
import { DmSettingsDialog } from './DmSettingsDialog'
import { VoiceDialog } from './VoiceDialog'
import { DmMemoryPanel } from './DmMemoryPanel'
import { findEvidence } from '../lib/evidence'
import type { DmGroup, DmGroupMember, DmMedia, DmMsg } from '../types'

function ConvAvatar({ name, url }: { name: string; url: string | null }) {
  return <Avatar size="lg"><AvatarImage src={url || undefined} alt={name} referrerPolicy="no-referrer" /><AvatarFallback>{Array.from((name || '?').trim())[0] || '?'}</AvatarFallback></Avatar>
}

/** 纯文本里的 URL 单独成链接，点击用系统浏览器打开 */
function LinkText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

function AudioMessage({ m }: { m: DmMsg }) {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  return <div className="dm-text">
    <span>语音消息</span>
    {m.transcript || text ? <p>{m.transcript || text}</p> : <button disabled={busy} onClick={async () => {
      setBusy(true)
      setError('')
      const r = await api.voiceTranscribe(m.key)
      setBusy(false)
      if (r?.ok && r.text) setText(r.text)
      else setError(r?.msg || '语音识别失败，请重试')
    }}>{busy ? '识别中…' : '转文字'}</button>}
    {error && <p className="note" role="status">{error}</p>}
  </div>
}

function MsgContent({ m, onMedia }: { m: DmMsg; onMedia: (m: DmMsg) => void }) {
  if (m.kind === 'audio') return <AudioMessage m={m} />
  if (m.kind === 'image') {
    return (
      <button className="dm-media" onClick={() => onMedia(m)} title="查看原图">
        <img src={'/dm/media/' + encodeURIComponent(m.key) + '?image=0'} alt="图片" loading="lazy" />
      </button>
    )
  }
  if (m.kind === 'video' || m.kind === 'note') {
    return (
      <>
        <button className="dm-video" onClick={() => onMedia(m)} title={m.kind === 'note' ? '查看图文' : '播放视频'}>
          {m.thumb ? <img src={m.thumb} alt="" referrerPolicy="no-referrer" /> : <div className="dm-media-missing">{m.kind === 'note' ? '图文' : '视频'}</div>}
          {m.kind === 'video' && <span className="dm-video-play">▶</span>}
          <span className="dm-video-author">{m.kind === 'note' ? '图文 · ' : ''}{m.author || '分享作品'}</span>
        </button>
        {m.kind === 'note' && <div className="dm-caption"><LinkText text={m.text} /></div>}
      </>
    )
  }
  if (m.kind === 'unsupported') return <div className="dm-text dim">{m.text}</div>
  return <div className="dm-text"><LinkText text={m.text} /></div>
}

function MediaDialog({ message, onClose }: { message: DmMsg; onClose: () => void }) {
  const [media, setMedia] = useState<DmMedia | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(false)
  const images = media?.images || []
  const kind = media?.kind || message.kind
  const title = kind === 'note' ? '图文预览' : kind === 'image' ? '图片预览' : '视频播放'

  useEffect(() => {
    let alive = true
    setLoading(true)
    setMedia(null)
    setIndex(0)
    setZoom(false)
    setError('')
    api.dmMedia(message.key, attempt > 0).then(r => {
      if (!alive) return
      setLoading(false)
      if (r?.ok) setMedia(r)
      else setError(r?.msg || '媒体解析失败，请重试')
    })
    return () => { alive = false }
  }, [message.key, attempt])

  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (images.length > 1 && e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1))
      if (images.length > 1 && e.key === 'ArrowRight') setIndex(i => Math.min(images.length - 1, i + 1))
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [onClose, images.length])

  useEffect(() => { setZoom(false); setError('') }, [index])

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="settings-content sm:max-w-3xl"><div className="media-preview"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>查看原始媒体，可在抖音中打开原消息。</DialogDescription></DialogHeader>
        {loading && <Skeleton className="h-64 w-full" />}
        {media?.url && <video src={media.url} poster={message.thumb} controls autoPlay onError={() => setError('视频播放失败，请重试或查看抖音原作品')} />}
        {!!images.length && (
          <>
            <div className="dm-image-view">
              <button className={cn(zoom && 'dm-image-zoom')} onClick={() => setZoom(v => !v)} title={zoom ? '适应窗口' : '放大图片'}>
                <img src={images[index]} alt={`第 ${index + 1} 张图片`} onError={() => setError('图片加载失败，请重试刷新原图地址')} />
              </button>
            </div>
            {images.length > 1 && <div className="dm-image-nav">
              <button disabled={index === 0} onClick={() => setIndex(i => i - 1)}>上一张</button>
              <span>{index + 1} / {images.length}</span>
              <button disabled={index === images.length - 1} onClick={() => setIndex(i => i + 1)}>下一张</button>
            </div>}
          </>
        )}
        {kind === 'note' && media && <div className="dm-note-body">
          {media.author && <div className="note">{media.author}</div>}
          <LinkText text={media.text || ''} />
        </div>}
        {error && <div className="note bad">{error}</div>}
        <div className="row">
          <button onClick={async () => {
            const r = await api.dmMediaOpen(message.key)
            if (!r?.ok) setError(r?.msg || '打开抖音原消息失败')
          }}>在抖音打开</button>
          {error && <button onClick={() => setAttempt(n => n + 1)}>重试</button>}
          <button onClick={onClose}>关闭</button>
        </div>
      </div></DialogContent></Dialog>
  )
}

export function DmPanel() {
  const { stat, convs, activeId, msgs, memory, wsDown, selecting, selectionError, rebuild, openConv, activateConv, refreshConvs } = useDmStream()
  const rebuildLabel = rebuild ? (rebuild.label || (rebuild.total ? `已整理 ${rebuild.done} / ${rebuild.total} 条消息` : `已整理 ${rebuild.done} 条消息`)) : ''
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'' | 'boot' | 'draft' | 'send' | 'sync' | 'attach' | 'group' | 'member'>('')
  const [note, setNote] = useState('')
  const [noteBad, setNoteBad] = useState(false)
  const [group, setGroup] = useState<DmGroup | null>(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [memberNote, setMemberNote] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [media, setMedia] = useState<DmMsg | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [showProfile, setShowProfile] = useState(() => window.innerWidth >= 1280)
  const [exampleVersion, setExampleVersion] = useState(0)
  const [generated, setGenerated] = useState<{ original: string; source: string; latest: string; id: string } | null>(null)
  const context = useRef({ id: activeId, key: msgs.at(-1)?.key })
  context.current = { id: activeId, key: msgs.at(-1)?.key }
  const visibleConvs = convs.filter(c => (!search.trim() || `${c.name} ${c.preview}`.toLowerCase().includes(search.trim().toLowerCase())) && (filter !== 'unread' || c.unread > 0) && (filter !== 'manual' || !!c.auto_reply_blocked))
  const phaseLabels = { receiving: '接收消息', waiting: '等待合并', generating: '生成回复', sending: '正在发送', retrying: '等待重试', paused: '已暂停' }
  const phase = stat.phase || 'paused'
  const receiveLabel = stat.receive_mode === 'protocol' ? '实验协议' : stat.receive_mode === 'compare' ? '协议对照' : '浏览器接收'


  const active = convs.find((c) => c.id === activeId)
  const canSend = memory?.send_outcome !== 'unknown' && stat.running && stat.active_id === activeId && !!activeId && text.trim().length > 0 && !busy && !selecting

  const say = (msg: string, bad = false) => {
    setNote(msg)
    setNoteBad(bad)
  }

  const block = async (id: string, blocked: boolean) => {
    const result = await api.dmBlock(id, blocked)
    if (result?.ok) {
      setGenerated(null)
      setText('')
      await refreshConvs()
      say(blocked ? '已加入过滤名单，仅手动回复' : '已移出过滤名单')
    } else {
      const error = result?.msg || '过滤名单保存失败'
      say(error, true)
      return error
    }
  }

  useEffect(() => {
    if (generated && (generated.id !== activeId || generated.latest !== msgs.at(-1)?.key)) {
      setGenerated(null)
      setText('')
      say('对话已更新，请重新生成草稿')
    }
  }, [activeId, msgs, generated])

  useEffect(() => {
    setText('')
    if (window.innerWidth < 1000) setShowProfile(false)
    setGenerated(null)
    setGroup(null)
    setGroupOpen(false)
    setMemberSearch('')
    setMemberNote('')
    setNote('')
    setMedia(null)
  }, [activeId])

  const start = async () => {
    setBusy('boot')
    say('正在打开私信页…')
    const r = await api.dmStart()
    setBusy('')
    if (r && r.ok) {
      say('已启动，正在读取会话')
      refreshConvs()
    } else {
      say('启动失败，请确认服务正常', true)
    }
  }

  const stop = async () => {
    setBusy('boot')
    await api.dmStop()
    setBusy('')
    say('已停止后台读取')
  }

  const sync = async () => {
    setBusy('sync')
    const r = await api.dmSync()
    await refreshConvs()
    setBusy('')
    if (r && r.ok) say(`已同步 · ${r.conv_count} 个会话`)
    else say((r && (r as { msg?: string }).msg) || '同步失败', true)
  }

  const draft = async () => {
    if (!activeId) return
    setBusy('draft')
    say('正在生成草稿…')
    const requested = { ...context.current }
    const source = [...msgs].reverse().find(m => m.direction === 'in')?.key || ''
    const r = await api.dmDraft(activeId)
    if (context.current.id !== requested.id || context.current.key !== requested.key) { setBusy(''); say('对话已更新，请重新生成草稿'); return }
    setBusy('')
    if (r && r.ok && r.text) {
      setText(r.text)
      setGenerated({ original: r.text, source, latest: requested.key || '', id: activeId })
      say('草稿已生成，确认后点发送')
    } else {
      say((r && r.msg) || '生成失败', true)
    }
  }

  const send = async () => {
    if (!activeId || !text.trim()) return
    setBusy('send')
    say('发送中…')
    const r = await api.dmSend(activeId, text)
    setBusy('')
    if (r && r.ok) {
      setText('')
      setGenerated(null)
      say(r.partial ? '已发送首段，未自动重发其余内容' : '已发送')
    } else {
      say((r && r.msg) || '发送失败，可在私信窗口手动发送', true)
    }
  }

  const attach = async () => {
    if (!activeId) return
    setBusy('attach')
    say('选择要发送的文件…')
    const r = await api.dmAttach(activeId)
    setBusy('')
    if (r && r.ok) say(`已选择 ${r.count} 个文件，正在上传`)
    else if (r && r.canceled) say('')
    else say((r && r.msg) || '选择文件失败', true)
  }

  const loadGroup = async () => {
    if (!activeId) return
    setBusy('group')
    const r = await api.dmGroup(activeId)
    setBusy('')
    if (!r || !r.ok) {
      say((r && r.msg) || '读取群信息失败', true)
      return
    }
    setGroup({ ...r, conv_id: activeId })
    setMemberNote('')
    setGroupOpen(true)
  }

  const chatMember = async (member: DmGroupMember) => {
    if (!group?.conv_id) return
    setBusy('member')
    setMemberNote(`正在打开与 ${member.name} 的私聊…`)
    const r = await api.dmMember(group.conv_id, member.id)
    setBusy('')
    if (!r?.ok) {
      setMemberNote(r?.msg || '打开失败')
      return
    }
    if (r.active_id) activateConv(r.active_id)
    setGroupOpen(false)
    say(`已打开与 ${member.name} 的私聊${r.limited ? '，对方回复或关注前只能发送一条文字消息' : ''}`)
    await refreshConvs()
  }

  const follow = async (member: DmGroupMember) => {
    if (!group?.conv_id) return
    setBusy('member')
    setMemberNote(`正在关注 ${member.name}…`)
    const r = await api.dmFollow(group.conv_id, member.id)
    setBusy('')
    if (r?.ok) {
      setMemberNote(`${member.name}：${r.after || '已关注'}`)
      setGroup(prev => prev && ({ ...prev, members: prev.members.map(m => m.id === member.id ? { ...m, followed: true } : m) }))
    } else {
      setMemberNote(r?.msg || '关注失败')
    }
  }

  const saveExample = async () => {
    if (!generated || !generated.source || text.trim() === generated.original.trim()) return
    const r = await api.dmAddExample(activeId, { source_key: generated.source, original: generated.original, reply: text, confirmed: true })
    if (r?.ok) { setExampleVersion(v => v + 1); say('已收录你的人工改写，仅用于此联系人') }
    else say(r?.msg || '样例收录失败', true)
  }

  return (
    <>
      <div className="workspace dm-workspace">
        <div className="page-heading"><div><div className="eyebrow">CONVERSATION WORKSPACE</div><h1>让每一次对话，更进一步<span className="heading-dot">.</span></h1><p>消息、记忆与你的表达方式，在一个工作台里连接。</p></div><div className="page-actions"><Button variant="outline" onClick={() => setVoiceOpen(true)}><AudioLines data-icon="inline-start" />音色与语音</Button><Button variant="outline" onClick={() => setSettingsOpen(true)}><Settings2 data-icon="inline-start" />回复设置</Button><Button variant={stat.running ? 'outline' : 'default'} onClick={stat.running ? stop : start} disabled={busy === 'boot'}>{stat.running ? <CirclePause data-icon="inline-start" /> : <Play data-icon="inline-start" />}{busy === 'boot' ? '处理中…' : stat.running ? '暂停接收' : '开启私信'}</Button></div></div>
        <div className="overview-grid dm-overview">
          {[
            { title: '全部会话', value: String(convs.length).padStart(2, '0'), detail: '已同步的联系人与群聊', icon: MessageSquare },
            { title: '未读消息', value: String(convs.reduce((n, c) => n + c.unread, 0)).padStart(2, '0'), detail: '值得关注的新对话', icon: Inbox },
            { title: '自动回复', value: stat.auto_enabled ? '已开启' : '已关闭', detail: phaseLabels[phase], icon: Bot },
            { title: '消息连接', value: wsDown ? '服务离线' : stat.receiving ? '接收中' : stat.running ? '连接中' : '待启动', detail: stat.running && !stat.receiving ? stat.status : receiveLabel, icon: Radio },
          ].map(item => <Card key={item.title} className="metric-card"><CardHeader><CardDescription>{item.title}</CardDescription><item.icon /><CardTitle><span className="metric-value">{item.value}</span></CardTitle></CardHeader><CardContent><span className="metric-detail">{item.detail}</span></CardContent></Card>)}
        </div>
        {stat.error && <Alert variant="destructive"><AlertTitle>私信接收需要处理</AlertTitle><AlertDescription>{stat.error}</AlertDescription></Alert>}
        <main className={cn('dm-layout', showProfile && activeId && 'with-profile', activeId && 'has-active')}>
          <section className="conversation-list">
            <div className="section-heading"><h2>消息收件箱<Badge variant="secondary">{convs.length}</Badge></h2><Button variant="ghost" size="icon-sm" aria-label="同步会话" onClick={sync} disabled={!stat.running || !!busy}><RefreshCw /></Button></div>
            <div className="conversation-search"><InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput aria-label="搜索会话" placeholder="搜索联系人或消息…" value={search} onChange={e => setSearch(e.target.value)} /></InputGroup></div>
            <ToggleGroup type="single" size="sm" value={filter} onValueChange={value => { if (value) setFilter(value) }} className="conversation-filters"><ToggleGroupItem value="all">全部</ToggleGroupItem><ToggleGroupItem value="unread">未读</ToggleGroupItem><ToggleGroupItem value="manual">手动回复</ToggleGroupItem></ToggleGroup>
            <div className="conversation-scroll">
              {!visibleConvs.length && <Empty><EmptyHeader><EmptyMedia variant="icon"><Inbox /></EmptyMedia><EmptyTitle>{search || filter !== 'all' ? '没有匹配的会话' : '收件箱准备好了'}</EmptyTitle><EmptyDescription>{search || filter !== 'all' ? '试试其他关键词或筛选条件。' : stat.running ? '正在同步抖音会话，若未登录请打开抖音窗口。' : '开启私信后，你的联系人和消息会出现在这里。'}</EmptyDescription></EmptyHeader>{!stat.running && !search && <EmptyContent><Button variant="outline" size="sm" onClick={start} disabled={!!busy}>开启私信<ChevronRight data-icon="inline-end" /></Button></EmptyContent>}</Empty>}
              {visibleConvs.map(c => <button key={c.id} className={cn('conversation-item', c.id === activeId && 'selected')} onClick={() => openConv(c.id)} disabled={!!busy || selecting} aria-current={c.id === activeId ? 'true' : undefined}>
                <ConvAvatar name={c.name} url={c.avatar} /><span className="conversation-item-body"><span className="conversation-item-top"><strong className="truncate">{c.name || '抖音用户'}</strong><time>{c.last_time?.match(/\d{1,2}:\d{2}/)?.[0] || c.last_time || ''}</time></span><span className="conversation-item-preview"><span className="truncate">{c.preview || '暂无消息'}</span>{c.unread > 0 && <Badge>{c.unread > 99 ? '99+' : c.unread}</Badge>}</span>{!!c.auto_reply_blocked && <span className="manual-label">仅手动回复</span>}</span>
              </button>)}
            </div>
            <div className="inbox-footer"><span className={cn('status-dot', !stat.running && 'idle')} />{stat.receiving ? '持续同步中' : stat.running ? stat.status : '已暂停同步'}<Button variant="ghost" size="icon-xs" aria-label="打开抖音私信窗口" onClick={() => api.dmOpen()}><ArrowUpRight /></Button></div>
          </section>
          <section className="conversation-thread">
            <div className="thread-heading"><Button variant="ghost" size="icon-sm" className="mobile-back" aria-label="返回会话列表" onClick={() => activateConv('')}><ArrowLeft /></Button>{active ? <><ConvAvatar name={active.name} url={active.avatar} /><div className="thread-title"><h2>{active.name}</h2><p>{active.is_group ? '群聊' : active.auto_reply_blocked ? '已由你接管 · 仅手动回复' : stat.auto_enabled ? 'AI 助理已就绪' : '手动回复模式'}</p></div></> : <div className="thread-title"><h2>对话空间</h2><p>专注于眼前的每一次交流</p></div>}
              <div className="thread-heading-actions">{active && !active.is_group && <Button variant="outline" size="sm" onClick={() => block(active.id, !active.auto_reply_blocked)}><ShieldCheck data-icon="inline-start" />{active.auto_reply_blocked ? '恢复自动回复' : '人工接管'}</Button>}{!!active?.is_group && <Button variant="outline" size="sm" onClick={loadGroup} disabled={!stat.running || !!busy || selecting}><Users data-icon="inline-start" />群成员</Button>}{activeId && <Button variant={showProfile ? 'secondary' : 'ghost'} size="icon" aria-label="切换联系人资料" onClick={() => setShowProfile(v => !v)}><BookOpen /></Button>}</div>
            </div>
            {!activeId ? <Empty className="thread-empty"><EmptyHeader><EmptyMedia variant="icon"><MessageSquare /></EmptyMedia><EmptyTitle>好的对话，从这里开始</EmptyTitle><EmptyDescription>选择左侧的会话，查看消息、生成回复，<br />或慢慢建立属于这位联系人的记忆。</EmptyDescription></EmptyHeader><EmptyContent><span className="empty-privacy"><ShieldCheck />会话与记忆仅保存在本机</span></EmptyContent></Empty> : <>
              {selecting && <div className="thread-loading"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-10 w-1/2 self-end" /></div>}
              <MessageScrollerProvider key={activeId} autoScroll defaultScrollPosition="end"><MessageScroller><MessageScrollerViewport><MessageScrollerContent className="p-6">
                {!msgs.length && <MessageScrollerItem messageId="empty"><Empty><EmptyHeader><EmptyMedia variant="icon"><MessageSquare /></EmptyMedia><EmptyTitle>等待对话同步</EmptyTitle><EmptyDescription>读取到的消息会显示在这里。</EmptyDescription></EmptyHeader></Empty></MessageScrollerItem>}
                {msgs.map(m => <MessageScrollerItem key={m.key} messageId={m.key}><Message align={m.direction === 'out' ? 'end' : 'start'}><MessageAvatar><ConvAvatar name={m.direction === 'out' ? '我' : m.sender_name || active?.name || '?'} url={m.sender_avatar || null} /></MessageAvatar><MessageContent><MessageHeader>{m.direction === 'out' ? '我' : m.sender_name || (active?.is_group ? '未记录发送者' : active?.name || '对方')}</MessageHeader><Bubble variant={m.direction === 'out' ? 'default' : 'muted'} align={m.direction === 'out' ? 'end' : 'start'}><BubbleContent><MsgContent m={m} onMedia={setMedia} /></BubbleContent></Bubble><MessageFooter>{m.time}{m.direction === 'out' && <CheckCheck />}</MessageFooter></MessageContent></Message></MessageScrollerItem>)}
              </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton aria-label="跳到最新消息" /></MessageScroller></MessageScrollerProvider>
              <div className="composer">{memory?.send_outcome === 'unknown' && <p className="helper-text" role="status">正在自动核对上一条发送回执…</p>}{memory?.send_partial === 1 && <p className="helper-text" role="status">上一条已确认发送首段，未自动重发其余内容。</p>}<div className="composer-top"><span><Sparkles />{generated ? 'AI 草稿 · 由你确认发送' : '写下你的回复'}</span>{generated && text.trim() !== generated.original.trim() && !active?.is_group && <Button variant="ghost" size="sm" onClick={saveExample}><BookOpen data-icon="inline-start" />收录改写</Button>}<span className="composer-shortcut">⌘ / Ctrl + Enter 发送</span></div><Textarea aria-label="回复内容" value={text} onChange={e => setText(e.target.value)} placeholder={stat.running ? '输入回复，或让 AI 帮你起个头…' : '开启私信后即可回复'} disabled={!stat.running || selecting || stat.active_id !== activeId} rows={3} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) send() }} />
                <div className="composer-actions"><Button variant="ghost" size="icon" aria-label="发送图片或视频" onClick={attach} disabled={!stat.running || !!busy || selecting}><Paperclip /></Button><span className={cn('composer-note', noteBad && 'error-text')} role="status">{selectionError || note}</span><Button variant="outline" onClick={draft} disabled={!stat.running || !!busy || selecting}><Sparkles data-icon="inline-start" />{busy === 'draft' ? '生成中…' : '生成草稿'}</Button><Button onClick={send} disabled={!canSend}><Send data-icon="inline-start" />{busy === 'send' ? '发送中…' : '发送'}</Button></div>
              </div>
            </>}
          </section>
          {activeId && showProfile && <div className="contact-wrapper"><Button variant="ghost" size="icon-sm" className="contact-close" aria-label="关闭联系人资料" onClick={() => setShowProfile(false)}><X /></Button><DmMemoryPanel key={activeId} id={activeId} memory={memory} name={active?.name || ''} isGroup={!!active?.is_group} refreshKey={exampleVersion} progress={rebuildLabel} onInspect={evidence => findEvidence(activeId, evidence)} /></div>}
        </main>
        <div className="workspace-footnote"><span className={cn('status-dot', !stat.running && 'idle')} />{wsDown ? '服务连接断开，正在重连…' : stat.running && !stat.receiving ? stat.status : stat.auto_status || `${receiveLabel} · ${phaseLabels[phase]}`}{stat.receive_mode === 'compare' && stat.protocol?.comparison && <span>协议 {stat.protocol.comparison.protocol} · 已匹配 {stat.protocol.comparison.matched}</span>}{stat.protocol?.error && <span className="error-text">{stat.protocol.error}</span>}<span>最近同步 {stat.last_scan || '—'}</span></div>
      </div>

      {media && <MediaDialog message={media} onClose={() => setMedia(null)} />}
      {settingsOpen && <DmSettingsDialog convs={convs} onClose={() => { setSettingsOpen(false); setGenerated(null); setText('') }} onBlocked={block} />}
      {voiceOpen && <VoiceDialog initialText={text} onClose={() => setVoiceOpen(false)} />}

      {groupOpen && group && (
        <Dialog open onOpenChange={setGroupOpen}><DialogContent className="settings-content sm:max-w-xl"><DialogHeader><DialogTitle>{group.name || '群信息'}</DialogTitle><DialogDescription>查看群成员，或从成员主页开始私聊。</DialogDescription></DialogHeader>
          <div className="group-details">
            {!group.group && <div className="note">这个会话不是群聊。</div>}
            {group.group && (
              <>
                <div className="note">已读取 {group.members.length} 人{group.complete === false ? `，共 ${group.total || '?'} 人，部分成员尚未加载` : ''}</div>
                <Input className="dm-member-search" aria-label="搜索群成员" placeholder="搜索群成员" value={memberSearch} onChange={e => setMemberSearch(e.target.value)} />
              </>
            )}
            <div className="dm-member-list">
              {group.members.filter(m => m.name.toLowerCase().includes(memberSearch.trim().toLowerCase())).map((m) => (
                <div className="dm-member" key={m.id}>
                  <ConvAvatar name={m.name} url={m.avatar || null} />
                  <span className="dm-member-name">{m.name || '成员'}</span>
                  {m.role === 1 && <Badge variant="secondary">群主</Badge>}
                  {m.role === 2 && <Badge variant="secondary">管理员</Badge>}
                  <Button variant="outline" size="sm" onClick={() => follow(m)} disabled={!!busy || m.followed}>
                    {m.followed ? '已关注' : '关注'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => chatMember(m)} disabled={!!busy}>
                    私聊
                  </Button>
                </div>
              ))}
              {group.members.length === 0 && <div className="note">没有读到成员列表。</div>}
            </div>
            <div className="row">
              <span className="note">{memberNote}</span>
              <Button variant="outline" onClick={() => setGroupOpen(false)}>关闭</Button>
            </div>
          </div></DialogContent></Dialog>
      )}
    </>
  )
}
