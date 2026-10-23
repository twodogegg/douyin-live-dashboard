import { Activity, ArrowUpRight, AudioLines, Check, ChevronRight, History, LayoutDashboard, MessageSquare, Radio, Settings2, ShieldCheck, Unplug, UserRound } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Separator } from './ui/separator'
import { cn } from '../lib/utils'
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
  const roomText = wsDown ? '服务连接断开' : connected ? `${stat.room || stat.room_id} · ${stat.status}` : '等待连接直播间'

  return <>
    <aside className="app-sidebar">
      <div className="brand"><span className="brand-mark"><AudioLines /></span><div><strong>抖音工作台</strong><span>LIVE & CONNECT</span></div></div>
      <div className="sidebar-label">工作空间</div>
      <nav aria-label="主导航" className="sidebar-nav">
        <Button variant={view === 'live' ? 'secondary' : 'ghost'} className={cn('nav-button', view === 'live' && 'active')} onClick={() => onView('live')}><LayoutDashboard data-icon="inline-start" />直播看板<ChevronRight data-icon="inline-end" /></Button>
        <Button variant={view === 'dm' ? 'secondary' : 'ghost'} className={cn('nav-button', view === 'dm' && 'active')} onClick={() => onView('dm')}><MessageSquare data-icon="inline-start" />私信工作台<ChevronRight data-icon="inline-end" /></Button>
        <Button variant="ghost" className="nav-button" onClick={onOpenHistory}><History data-icon="inline-start" />历史记录</Button>
      </nav>
      <Separator />
      <div className="sidebar-label">偏好设置</div>
      <Button variant="ghost" className="nav-button" onClick={onOpenSettings}><Settings2 data-icon="inline-start" />模型与设置</Button>
      <div className="sidebar-bottom">
        <div className="local-note"><ShieldCheck /><div><strong>你的数据，留在本地</strong><p>登录状态与会话独立保存</p></div></div>
        <Separator />
        <Button variant="ghost" className="account-button" onClick={onOpenAccount}><span className="account-avatar"><UserRound /></span><span><strong>抖音账号</strong><small>{loggedIn ? '已登录 · 管理账号' : '未登录 · 点击登录'}</small></span><ChevronRight data-icon="inline-end" /></Button>
      </div>
    </aside>
    <header className="app-header">
      <div className="breadcrumb">工作空间<ChevronRight /><strong>{view === 'live' ? '直播看板' : '私信工作台'}</strong></div>
      <div className="header-actions"><Badge variant={wsDown ? 'destructive' : 'outline'}><Activity data-icon="inline-start" />{wsDown ? '服务离线' : '本地服务已连接'}</Badge><Separator orientation="vertical" /><Button variant="ghost" size="sm" onClick={view === 'live' ? onShowLiveWindow : onShowDmWindow}>打开抖音窗口<ArrowUpRight data-icon="inline-end" /></Button></div>
    </header>
    {view === 'live' && <div className="live-connection">
      <div className="connection-state"><Radio /><div><strong>直播间连接</strong><p>{roomText}</p></div></div>
      <Input aria-label="直播间号" placeholder="输入语音直播间号" autoComplete="off" value={roomInput} disabled={connected || !loggedIn} onChange={e => setRoomInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && loggedIn) onToggleConn() }} />
      <Button variant={connBusy ? 'outline' : 'default'} disabled={!loggedIn} onClick={onToggleConn}>{connBusy ? <Unplug data-icon="inline-start" /> : <Radio data-icon="inline-start" />}{connBusy ? '断开连接' : '连接直播间'}</Button>
      {connMsg && <span className={cn('connection-note', !connMsgOk && 'error-text')}>{connMsgOk && <Check />}{connMsg}</span>}
    </div>}
  </>
}
