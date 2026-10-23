import { AudioLines, Bot, MessagesSquare, Radio, Users } from 'lucide-react'
import { Badge } from './components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './components/ui/card'
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AiFeed } from './components/AiFeed'
import { AccountDialog } from './components/AccountDialog'
import { DmPanel } from './components/DmPanel'
import { Header } from './components/Header'
import { HistoryDialog } from './components/HistoryDialog'
import { LoginGate } from './components/LoginGate'
import { MessageFeed } from './components/MessageFeed'
import { LS, readLocalConfig, SettingsDialog } from './components/SettingsDialog'
import { useLiveStream } from './hooks/useLiveStream'

export default function App() {
  const { r1, r2, ai, avatars, stat, wsDown } = useLiveStream()
  const [view, setView] = useState<'live' | 'dm'>('live')

  const [loggedIn, setLoggedIn] = useState(false)
  const [roomInput, setRoomInput] = useState('')
  const [connMsg, setConnMsg] = useState('')
  const [connMsgOk, setConnMsgOk] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loginMsg, setLoginMsg] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [aiTag, setAiTag] = useState('未配置')
  const booted = useRef(false)

  const connected = !!stat.room_id
  const connBusy = connected || busy

  const startLogin = async () => {
    setLoginMsg('正在打开浏览器…')
    const r = await api.loginStart()
    setLoginMsg(
      r && r.ok ? '登录窗口已打开，请完成扫码登录后点「我已登录完成」' : '打开失败，请确认服务正常',
    )
  }

  // 首次进入：先检测登录状态，未登录自动跳到登录页；并把本地已存的 key 下发给后端
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    ;(async () => {
      const st = await api.loginStatus()
      const on = !!(st && st.logged_in)
      setLoggedIn(on)
      if (!on) await startLogin()

      if (localStorage.getItem(LS.key)) {
        const conf = readLocalConfig()
        const r = await api.saveConfig(conf)
        if (r && r.ok && r.has_key) setAiTag(`${r.model} · 每 ${r.window}s`)
      }
      // 后端可能已有配置（例如通过接口写入），以服务端状态为准回填标签
      const cur = await api.getConfig()
      if (cur && cur.has_key) setAiTag(`${cur.model} · 每 ${cur.window}s`)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 后端也会通过 WS 推送登录态（例如在浏览器里完成登录后）
  useEffect(() => {
    if (typeof stat.logged_in === 'boolean') setLoggedIn(stat.logged_in)
  }, [stat.logged_in])

  // 以 WS 推送的后端配置为准，避免 localStorage 与后端不一致时标签显示错误
  useEffect(() => {
    if (typeof stat.has_key === 'boolean') {
      setAiTag(stat.has_key ? `${stat.model} · 每 ${stat.window}s` : '未配置')
    }
  }, [stat.has_key, stat.model, stat.window])

  const finishLogin = async () => {
    setLoginMsg('检测中…')
    const r = await api.loginComplete()
    if (r && r.ok) {
      setLoggedIn(true)
      setLoginMsg('登录成功 ✓')
    } else {
      setLoginMsg((r && r.msg) || '还没检测到登录，请在浏览器里完成登录后再点')
    }
  }

  const toggleConn = async () => {
    if (connBusy) {
      setConnMsg('')
      await api.disconnect()
      return
    }
    const rid = roomInput.trim()
    if (!/^\d{4,20}$/.test(rid)) {
      setConnMsgOk(false)
      setConnMsg('房号必须是纯数字')
      return
    }
    setConnMsgOk(true)
    setConnMsg('连接中…')
    setBusy(true)
    const r = await api.connect(rid)
    setBusy(false)
    if (r && r.ok) {
      setConnMsgOk(true)
      setConnMsg(`已连接 ${rid}`)
    } else {
      setConnMsgOk(false)
      setConnMsg((r && r.msg) || '连接失败')
    }
  }

  return (
    <div className="app-shell">
      <Header
        stat={stat}
        wsDown={wsDown}
        loggedIn={loggedIn}
        connected={connected}
        connBusy={connBusy}
        connMsg={connMsg}
        connMsgOk={connMsgOk}
        roomInput={roomInput}
        setRoomInput={setRoomInput}
        onToggleConn={toggleConn}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onShowLiveWindow={() => api.showLiveWindow()}
        onShowDmWindow={() => api.dmOpen()}
        onOpenAccount={() => setAccountOpen(true)}
        view={view}
        onView={setView}
      />

      {view === 'live' ? (
        <div className="workspace live-workspace">
          <div className="page-heading"><div><div className="eyebrow">LIVE OVERVIEW</div><h1>每一条互动，都有回响<span className="heading-dot">.</span></h1><p>实时捕捉直播间动态，让 AI 帮你关注对话重点。</p></div><Badge variant="outline"><Radio />{connected ? '正在监听' : '准备就绪'}</Badge></div>
          <div className="overview-grid">
            {[
              { title: '主播侧消息', value: stat.r1_count, description: '视频区公屏', icon: AudioLines },
              { title: '观众侧消息', value: stat.r2_count, description: '聊天室互动', icon: Users },
              { title: 'AI 实时摘要', value: stat.ai_count, description: stat.last_ai ? `最近更新 ${stat.last_ai}` : '等待新的分析窗口', icon: Bot },
            ].map(item => <Card key={item.title} className="metric-card"><CardHeader><CardDescription>{item.title}</CardDescription><item.icon /><CardTitle><span className="metric-value">{item.value.toLocaleString()}</span></CardTitle></CardHeader><CardContent><span className="metric-detail">{item.description}</span></CardContent></Card>)}
          </div>
          <main className="live-grid">
            <section className="col"><h2><AudioLines />主播侧<Badge variant="secondary">实时公屏</Badge></h2><MessageFeed items={r1} avatars={avatars} fallbackName="主播侧" region="r1" /></section>
            <section className="col ai-column"><h2><Bot />AI 洞察<Badge variant="outline">{aiTag}</Badge></h2><AiFeed cards={ai} /></section>
            <section className="col"><h2><MessagesSquare />观众侧<Badge variant="secondary">聊天室</Badge></h2><MessageFeed items={r2} avatars={avatars} fallbackName="" region="r2" /></section>
          </main>
          <div className="workspace-footnote"><span className="status-dot" />{connected ? '实时消息流已连接' : '连接直播间后，消息将在这里实时更新'}<span>数据仅保存在本机</span></div>
        </div>
      ) : <DmPanel />}

      {!loggedIn && <LoginGate msg={loginMsg} onStart={startLogin} onDone={finishLogin} />}
      {accountOpen && (
        <AccountDialog onClose={() => setAccountOpen(false)} onChanged={setLoggedIn} />
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={(tag) => setAiTag(tag)} />
      )}
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} />}
    </div>
  )
}
