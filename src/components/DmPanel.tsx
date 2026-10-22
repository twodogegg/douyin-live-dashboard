import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useDmStream } from '../hooks/useDmStream'
import type { DmGroup, DmGroupMember, DmMedia, DmMsg } from '../types'

function ConvAvatar({ name, url }: { name: string; url: string | null }) {
  return (
    <span className="av dm-av">
      {url ? (
        <img src={url} referrerPolicy="no-referrer" loading="lazy" alt="" />
      ) : (
        <i>{Array.from((name || '?').trim())[0] || '?'}</i>
      )}
    </span>
  )
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

function MsgContent({ m, onMedia }: { m: DmMsg; onMedia: (m: DmMsg) => void }) {
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
    <div className="overlay" onClick={onClose}>
      <div className="dlg dm-player" onClick={e => e.stopPropagation()} role="dialog" aria-label="媒体预览">
        <h3>{title}</h3>
        {loading && <div className="dm-empty">正在加载媒体…</div>}
        {media?.url && <video src={media.url} poster={message.thumb} controls autoPlay onError={() => setError('视频播放失败，请重试或查看抖音原作品')} />}
        {!!images.length && (
          <>
            <div className="dm-image-view">
              <button className={zoom ? 'dm-image-zoom' : ''} onClick={() => setZoom(v => !v)} title={zoom ? '适应窗口' : '放大图片'}>
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
      </div>
    </div>
  )
}

export function DmPanel() {
  const { stat, convs, activeId, msgs, wsDown, selecting, selectionError, openConv, activateConv, refreshConvs } = useDmStream()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'' | 'boot' | 'draft' | 'send' | 'sync' | 'attach' | 'group' | 'member'>('')
  const [note, setNote] = useState('')
  const [noteBad, setNoteBad] = useState(false)
  const [group, setGroup] = useState<DmGroup | null>(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [memberNote, setMemberNote] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [media, setMedia] = useState<DmMsg | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)

  const active = convs.find((c) => c.id === activeId)
  const canSend = stat.running && stat.active_id === activeId && !!activeId && text.trim().length > 0 && !busy && !selecting

  const say = (msg: string, bad = false) => {
    setNote(msg)
    setNoteBad(bad)
  }

  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])

  useEffect(() => {
    setText('')
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
    const r = await api.dmDraft(activeId)
    setBusy('')
    if (r && r.ok && r.text) {
      setText(r.text)
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
      say('已发送')
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

  return (
    <>
      <main className="dm-main">
      <section className="dm-list">
        <h2>
          私信
          <span className="tag">
            {wsDown ? '连接断开' : stat.running ? stat.status : '未启动'}
          </span>
        </h2>
        <div className="dm-tools">
          {stat.running ? (
            <button onClick={stop} disabled={busy === 'boot'}>停止</button>
          ) : (
            <button className="primary" onClick={start} disabled={busy === 'boot'}>开启私信</button>
          )}
          <button onClick={sync} disabled={!stat.running || busy === 'sync'}>
            {busy === 'sync' ? '同步中…' : '同步'}
          </button>
          <button onClick={() => api.dmOpen()}>打开窗口</button>
        </div>
        {!stat.running && (
          <div className="dm-empty">
            点「开启私信」后会在后台打开抖音私信页（不抢占前台），
            读取会话列表后在这里生成草稿。
          </div>
        )}
        {stat.error && <div className="dm-empty bad">{stat.error}</div>}
        <div className="dm-convs">
          {convs.length === 0 && stat.running && (
            <div className="dm-empty">还没有读到会话。若页面在登录页，请点「打开窗口」完成登录。</div>
          )}
          {convs.map((c) => (
            <button
              key={c.id}
              className={`dm-item${c.id === activeId ? ' on' : ''}`}
              onClick={() => openConv(c.id)}
              disabled={!!busy}
            >
              <ConvAvatar name={c.name} url={c.avatar} />
              <span className="dm-item-body">
                <span className="dm-item-top">
                  <span className="dm-name">{c.name || '抖音用户'}</span>
                  <span className="dm-time">{c.last_time || ''}</span>
                </span>
                <span className="dm-preview">{c.preview || '（暂无消息）'}</span>
              </span>
              {c.unread > 0 && <span className="dm-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
            </button>
          ))}
        </div>
      </section>

      <section className="dm-thread">
        <h2>
          {active ? active.name : '选择一个会话'}
          {activeId && !!active?.is_group && (
            <button
              className="pill dm-head-btn"
              onClick={loadGroup}
              disabled={!stat.running || !!busy || selecting}
            >
              {busy === 'group' ? '读取中…' : '群信息'}
            </button>
          )}
          <span className="tag">{activeId ? `会话 ${activeId.slice(0, 10)}` : ''}</span>
        </h2>

        <div className="dm-msgs" ref={feedRef}>
          {!activeId && (
            <div className="dm-empty">左侧选一个会话，或先点「开启私信」同步会话列表。</div>
          )}
          {selecting && <div className="note">正在切换会话…</div>}
          {msgs.map((m) => (
            <div key={m.key} className={`dm-msg ${m.direction}`}>
              <div className={`dm-bubble${m.kind && m.kind !== 'text' ? ' media' : ''}`}>
                <div className="dm-sender">
                  <ConvAvatar name={m.direction === 'out' ? '我' : m.sender_name || active?.name || '?'} url={m.sender_avatar || null} />
                  <span>{m.direction === 'out' ? '我' : m.sender_name || (active?.is_group ? '未记录发送者' : active?.name || '对方')}</span>
                </div>
                <MsgContent m={m} onMedia={setMedia} />
                <div className="dm-stamp">{m.time}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="dm-compose">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={activeId ? '输入回复，或点「生成草稿」' : '先选择一个会话'}
            disabled={!stat.running || !activeId || selecting || stat.active_id !== activeId}
            rows={3}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) send()
            }}
          />
          <div className="dm-actions">
            <span className={`dm-note${noteBad ? ' bad' : ''}`}>{selectionError || note}</span>
            <button
              onClick={attach}
              disabled={!stat.running || !activeId || !!busy || selecting}
              title="发送图片或视频"
            >
              {busy === 'attach' ? '选择中…' : '📎 文件'}
            </button>
            <button
              onClick={draft}
              disabled={!stat.running || !activeId || !!busy || selecting}
            >
              {busy === 'draft' ? '生成中…' : '生成草稿'}
            </button>
            <button className="primary" onClick={send} disabled={!canSend}>
              {busy === 'send' ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      </section>
      </main>

      {media && <MediaDialog message={media} onClose={() => setMedia(null)} />}

      {groupOpen && group && (
        <div className="overlay" onClick={() => setGroupOpen(false)}>
          <div className="dlg dm-group" onClick={(e) => e.stopPropagation()}>
            <h3>
              {group.name || '群信息'}
              <span className="hint">{group.count || ''}</span>
            </h3>
            {!group.group && <div className="note">这个会话不是群聊。</div>}
            {group.group && (
              <>
                <div className="note">已读取 {group.members.length} 人{group.complete === false ? `，共 ${group.total || '?'} 人，部分成员尚未加载` : ''}</div>
                <input className="dm-member-search" aria-label="搜索群成员" placeholder="搜索群成员" value={memberSearch} onChange={e => setMemberSearch(e.target.value)} />
              </>
            )}
            <div className="dm-member-list">
              {group.members.filter(m => m.name.toLowerCase().includes(memberSearch.trim().toLowerCase())).map((m) => (
                <div className="dm-member" key={m.id}>
                  <ConvAvatar name={m.name} url={m.avatar || null} />
                  <span className="dm-member-name">{m.name || '成员'}</span>
                  {m.role === 1 && <span className="tag">群主</span>}
                  {m.role === 2 && <span className="tag">管理员</span>}
                  <button onClick={() => follow(m)} disabled={!!busy || m.followed}>
                    {m.followed ? '已关注' : '关注'}
                  </button>
                  <button onClick={() => chatMember(m)} disabled={!!busy}>
                    私聊
                  </button>
                </div>
              ))}
              {group.members.length === 0 && <div className="note">没有读到成员列表。</div>}
            </div>
            <div className="row">
              <span className="note">{memberNote}</span>
              <button onClick={() => setGroupOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
