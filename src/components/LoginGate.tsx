export function LoginGate({
  msg,
  onStart,
  onDone,
}: {
  msg: string
  onStart: () => void
  onDone: () => void
}) {
  return (
    <div className="overlay gate">
      <div className="dlg">
        <h3>需要先登录抖音</h3>
        <p className="note">
          点「去登录」会打开抖音登录窗口，请完成扫码/登录；登录成功后回到本页面点「我已登录完成」。
        </p>
        <div className="row">
          <span className="login-msg">{msg}</span>
          <button onClick={onStart}>去登录</button>
          <button className="primary" onClick={onDone}>
            我已登录完成
          </button>
        </div>
      </div>
    </div>
  )
}
