import { AudioLines, ArrowUpRight, ShieldCheck } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

export function LoginGate({ msg, onStart, onDone }: { msg: string; onStart: () => void; onDone: () => void }) {
  return <Dialog open><DialogContent showCloseButton={false} onEscapeKeyDown={e => e.preventDefault()} onInteractOutside={e => e.preventDefault()}>
    <div className="login-brand"><AudioLines /></div><DialogHeader><DialogTitle>连接你的抖音账号</DialogTitle><DialogDescription>在抖音窗口完成扫码登录，回来后即可开始管理直播互动和私信。</DialogDescription></DialogHeader>
    <p className="helper-text" role="status">{msg}</p><div className="empty-privacy"><ShieldCheck />登录状态仅保存在本机</div><DialogFooter><Button variant="outline" onClick={onStart}>打开登录窗口<ArrowUpRight data-icon="inline-end" /></Button><Button onClick={onDone}>我已登录完成</Button></DialogFooter>
  </DialogContent></Dialog>
}
