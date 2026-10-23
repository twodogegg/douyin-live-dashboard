import type { Stat } from '../types'

export type View = 'live' | 'dm'

export function Header({
  stat,
  wsDown,
  loggedIn,
  connected,
  connBusy,
  connMsg,
  connMsgOk,
  roomInput,
  setRoomInput,
  onToggleConn,
  onOpenHistory,
  onOpenSettings,
  onShowLiveWindow,
  onShowDmWindow,
  onOpenAccount,
  view,
  onView,
}: {
  stat: Stat
  wsDown: boolean
  loggedIn: boolean
  connected: boolean
  connBusy: boolean
  connMsg: string
  connMsgOk: boolean
  roomInput: string
  setRoomInput: (v: string) => void
  onToggleConn: () => void
  onOpenHistory: () => void
  onOpenSettings: () => void
  onShowLiveWindow: () => void
  onShowDmWindow: () => void
  onOpenAccount: () => void
  view: View
  onView: (v: View) => void
}) {
  const dotClass =
    'dot' +
    (stat.status === '已进房'
      ? ' on'
      : String(stat.status).includes('异常') || wsDown
        ? ' err'
        : '')
  const roomText = wsDown
    ? '连接断开，3s 后重连…'
    : connected
      ? `${stat.room || stat.room_id}（${stat.status}）`
      : stat.status || '待机'

  return (
    <header>
      <span className={dotClass} />
      <h1>抖音语音直播间 AI 看板</h1>
      <div className="tabs">
        <button className={`tab${view === 'live' ? ' on' : ''}`} onClick={() => onView('live')}>
          直播看板
        </button>
        <button className={`tab${view === 'dm' ? ' on' : ''}`} onClick={() => onView('dm')}>
          私信
        </button>
      </div>
      <button className={`pill${loggedIn ? ' on' : ''}`} onClick={onOpenAccount}>
        {loggedIn ? '已登录' : '未登录'}
      </button>

      {view === 'live' ? (
        <>
          <input
            placeholder="填写语音直播间号"
            autoComplete="off"
            value={roomInput}
            disabled={connected || !loggedIn}
            onChange={(e) => setRoomInput(e.target.value)}
          />
          <button disabled={!loggedIn} onClick={onToggleConn}>
            {connBusy ? '断开' : '连接'}
          </button>
          <span className="conn-msg" style={connMsgOk ? undefined : { color: 'var(--accent)' }}>
            {connMsg}
          </span>
          <span className="room">{roomText}</span>
          <div className="stats">
            <span>
              主播侧 <b>{stat.r1_count}</b>
            </span>
            <span>
              观众侧 <b>{stat.r2_count}</b>
            </span>
            <span>
              AI 摘要 <b>{stat.ai_count}</b>
            </span>
            <span>{stat.last_ai ? `上次摘要 ${stat.last_ai}` : ''}</span>
          </div>
        </>
      ) : (
        <>
          <span className="room">私信工作台</span>
          <div className="stats" />
        </>
      )}

      <button onClick={view === 'live' ? onShowLiveWindow : onShowDmWindow}>
        {view === 'live' ? '直播窗口' : '私信窗口'}
      </button>
      <button onClick={onOpenHistory}>🕘 历史</button>
      <button onClick={onOpenSettings}>⚙ 设置</button>
    </header>
  )
}
