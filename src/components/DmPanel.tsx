import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useDmStream } from '../hooks/useDmStream'
import type { DmGroup, DmMsg } from '../types'

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

function MsgContent({ m }: { m: DmMsg }) {
  if (m.kind === 'image') {
    return m.thumb ? (
      <a className="dm-media" href={m.thumb} target="_blank" rel="noreferrer">
        <img src={m.thumb} alt="" referrerPolicy="no-referrer" />
      </a>
    ) : (
      <div className="dm-media-missing">[图片]</div>
    )
  }
  if (m.kind === 'video') {
    return (
      <button className="dm-video" onClick={() => api.dmOpen()} title="在抖音私信窗口里查看视频">
        {m.thumb ? <img src={m.thumb} alt="" referrerPolicy="no-referrer" /> : <div className="dm-media-missing">视频</div>}
        <span className="dm-video-play">▶</span>
        <span className="dm-video-author">{m.author || '分享视频'}</span>
      </button>
    )
  }
  if (m.kind === 'unsupported') {
    return <div className="dm-text dim">{m.text}</div>
  }
  return (
    <div className="dm-text">
      <LinkText text={m.text} />
    </div>
  )
}

export function DmPanel() {
  const { stat, convs, activeId, msgs, wsDown, openConv, refreshConvs } = useDmStream()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'' | 'boot' | 'draft' | 'send' | 'sync' | 'attach' | 'group' | 'member'>('')
  const [note, setNote] = useState('')
  const [noteBad, setNoteBad] = useState(false)
  const [group, setGroup] = useState<DmGroup | null>(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [memberNote, setMemberNote] = useState('')
  const [followTarget, setFollowTarget] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)

  const active = convs.find((c) => c.id === activeId)
  const canSend = stat.running && !!activeId && text.trim().length > 0 && !busy

  const say = (msg: string, bad = false) => {
    setNote(msg)
    setNoteBad(bad)
  }

  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])

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
    const r = await api.dmAttach()
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
    setGroup(r)
    setMemberNote('')
    setGroupOpen(true)
  }

  const chatMember = async (name: string, idx: number) => {
    setBusy('member')
    setMemberNote(`正在打开与 ${name} 的私聊…`)
    setFollowTarget('')
    const r = await api.dmMember(idx)
    setBusy('')
    if (!r || !r.ok) {
      setMemberNote((r && r.msg) || '打开失败')
      return
    }
    if (r.followText === '关注') setFollowTarget(name)
    if (r.chatting) {
      setMemberNote(
        r.limited
          ? `已打开与 ${name} 的私聊窗口。对方回复或关注你之前，只能发送一条文字消息。`
          : `已打开与 ${name} 的私聊窗口`,
      )
    } else if (r.needFollow) {
      setMemberNote(`需要先关注 ${name} 才能私聊，可点下方「关注对方」后再试`)
    } else {
      setMemberNote(r.msg || '已打开成员主页，请在窗口里点「私信」')
    }
  }

  const follow = async () => {
    setBusy('member')
    setMemberNote('正在关注…')
    const r = await api.dmFollow()
    setBusy('')
    if (r && r.ok) {
      setMemberNote(`已关注${followTarget ? ` ${followTarget}` : ''}（${r.after || '已关注'}），可再点「私聊」`)
      setFollowTarget('')
    } else {
      setMemberNote((r && r.msg) || '关注失败')
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
          {activeId && (
            <button
              className="pill dm-head-btn"
              onClick={loadGroup}
              disabled={!stat.running || busy === 'group'}
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
          {msgs.map((m) => (
            <div key={m.key} className={`dm-msg ${m.direction}`}>
              <div className={`dm-bubble${m.kind && m.kind !== 'text' ? ' media' : ''}`}>
                <MsgContent m={m} />
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
            disabled={!stat.running || !activeId}
            rows={3}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) send()
            }}
          />
          <div className="dm-actions">
            <span className={`dm-note${noteBad ? ' bad' : ''}`}>{note}</span>
            <button
              onClick={attach}
              disabled={!stat.running || !activeId || busy !== ''}
              title="发送图片或视频"
            >
              {busy === 'attach' ? '选择中…' : '📎 文件'}
            </button>
            <button
              onClick={draft}
              disabled={!stat.running || !activeId || busy === 'draft' || busy === 'send'}
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

      {groupOpen && group && (
        <div className="overlay" onClick={() => setGroupOpen(false)}>
          <div className="dlg dm-group" onClick={(e) => e.stopPropagation()}>
            <h3>
              {group.name || '群信息'}
              <span className="hint">{group.count || ''}</span>
            </h3>
            {!group.group && <div className="note">这个会话不是群聊。</div>}
            <div className="dm-member-list">
              {group.members.map((m) => (
                <div className="dm-member" key={m.idx}>
                  <ConvAvatar name={m.name} url={m.avatar || null} />
                  <span className="dm-member-name">{m.name || '成员'}</span>
                  <button onClick={() => chatMember(m.name, m.idx)} disabled={busy === 'member'}>
                    私聊
                  </button>
                </div>
              ))}
              {group.members.length === 0 && <div className="note">没有读到成员列表。</div>}
            </div>
            <div className="row">
              <span className="note">{memberNote}</span>
              {followTarget && (
                <button onClick={follow} disabled={busy === 'member'}>
                  关注对方
                </button>
              )}
              <button onClick={() => setGroupOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
