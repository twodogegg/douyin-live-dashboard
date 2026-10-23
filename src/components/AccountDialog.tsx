import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { api } from '../api'

/** 抖音登录态管理：打开登录窗口、手动保存、清空后重新登录。 */
export function AccountDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: (loggedIn: boolean) => void
}) {
  const [logged, setLogged] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    api.loginStatus().then((r) => {
      const on = !!r?.logged_in
      setLogged(on)
      onChanged(on)
    })
  }, [])

  const startLogin = async () => {
    setMsg('正在打开抖音窗口…')
    const r = await api.loginStart()
    setMsg(r && r.ok ? '请在抖音窗口里完成扫码登录' : '打开失败，请重试')
  }

  const save = async () => {
    const r = await api.loginSave()
    const on = !!r?.logged_in
    setLogged(on)
    onChanged(on)
    setMsg(r && r.ok ? '登录态已保存' : (r && r.msg) || '当前未登录，无法保存')
  }

  const clear = async () => {
    await api.loginClear()
    setLogged(false)
    onChanged(false)
    setConfirmClear(false)
    setMsg('登录态已清空，请重新登录')
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent>
    <DialogHeader><DialogTitle>抖音账号</DialogTitle><DialogDescription>管理登录状态。重启应用后会自动复用已保存的登录。</DialogDescription></DialogHeader>
    <div className="flex items-center gap-3"><Badge variant={logged ? 'secondary' : 'outline'}>{logged ? '已登录' : '未登录'}</Badge><span className="helper-text" role="status">{msg}</span></div>
    {confirmClear ? <><p className="helper-text">清空后需要重新扫码登录，后台私信接收将暂停。</p><DialogFooter><Button variant="outline" onClick={() => setConfirmClear(false)}>取消</Button><Button variant="destructive" onClick={clear}>确认清空</Button></DialogFooter></> : <DialogFooter><Button variant="ghost" onClick={() => setConfirmClear(true)}>清空登录态</Button><Button variant="outline" onClick={startLogin}>打开抖音窗口</Button><Button onClick={save} disabled={!logged}>保存登录态</Button></DialogFooter>}
  </DialogContent></Dialog>
}
