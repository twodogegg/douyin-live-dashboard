import { useEffect, useState } from 'react'
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

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dlg">
        <h3>抖音登录</h3>
        <p className="note">登录态保存在本机应用数据目录，重启应用会自动复用。</p>

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <span className={`pill${logged ? ' on' : ''}`}>{logged ? '已登录' : '未登录'}</span>
          <span className="login-msg">{msg}</span>
        </div>

        <div className="row">
          {confirmClear ? (
            <>
              <span className="login-msg">清空后需要重新扫码登录</span>
              <button onClick={() => setConfirmClear(false)}>取消</button>
              <button className="primary" onClick={clear}>
                确认清空
              </button>
            </>
          ) : (
            <>
              <button onClick={startLogin}>打开抖音窗口</button>
              <button onClick={save} disabled={!logged}>
                保存登录态
              </button>
              <button onClick={() => setConfirmClear(true)}>清空登录态</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
