import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { AiFeed } from './components/AiFeed'
import { Header } from './components/Header'
import { HistoryDialog } from './components/HistoryDialog'
import { LoginGate } from './components/LoginGate'
import { MessageFeed } from './components/MessageFeed'
import { LS, readLocalConfig, SettingsDialog } from './components/SettingsDialog'
import { useLiveStream } from './hooks/useLiveStream'

export default function App() {
  const { r1, r2, ai, avatars, stat, wsDown } = useLiveStream()

  const [loggedIn, setLoggedIn] = useState(false)
  const [roomInput, setRoomInput] = useState('')
  const [connMsg, setConnMsg] = useState('')
  const [connMsgOk, setConnMsgOk] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loginMsg, setLoginMsg] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [aiTag, setAiTag] = useState('未配置')
  const booted = useRef(false)

  const connected = !!stat.room_id
  const connBusy = connected || busy

  const startLogin = async () => {
    setLoginMsg('正在打开浏览器…')
    const r = await api.loginStart()
    setLoginMsg(
      r && r.ok ? '浏览器已打开，请完成扫码登录后点「我已登录完成」' : '打开失败，请确认后端服务正常',
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
    <>
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
      />

      <main>
        <section className="col">
          <h2>
            🎤 主播侧<span className="tag">视频区公屏 · 流式上屏</span>
          </h2>
          <MessageFeed items={r1} avatars={avatars} fallbackName="主播侧" region="r1" />
        </section>
        <section className="col">
          <h2>
            🤖 AI 实时摘要<span className="tag">{aiTag}</span>
          </h2>
          <AiFeed cards={ai} />
        </section>
        <section className="col">
          <h2>
            💬 观众侧<span className="tag">聊天室弹幕</span>
          </h2>
          <MessageFeed items={r2} avatars={avatars} fallbackName="" region="r2" />
        </section>
      </main>

      {!loggedIn && <LoginGate msg={loginMsg} onStart={startLogin} onDone={finishLogin} />}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={(tag) => setAiTag(tag)} />
      )}
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} />}
    </>
  )
}
