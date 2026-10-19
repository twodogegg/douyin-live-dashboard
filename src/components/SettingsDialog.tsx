import { useState } from 'react'
import { api } from '../api'

export const LS = { base: 'dy.base', model: 'dy.model', key: 'dy.key', win: 'dy.win' }

export function readLocalConfig() {
  return {
    base_url: localStorage.getItem(LS.base) || 'https://api.darl.cn/v1',
    model: localStorage.getItem(LS.model) || 'gpt-4o-mini',
    key: localStorage.getItem(LS.key) || '',
    window: parseInt(localStorage.getItem(LS.win) || '') || 20,
  }
}

export function SettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (tag: string) => void
}) {
  const init = readLocalConfig()
  const [base, setBase] = useState(init.base_url)
  const [model, setModel] = useState(init.model)
  const [key, setKey] = useState(init.key)
  const [win, setWin] = useState(String(init.window))
  const [saveState, setSaveState] = useState('')

  const save = async () => {
    const conf = {
      base_url: base.trim(),
      model: model.trim(),
      key: key.trim(),
      window: parseInt(win) || 20,
    }
    localStorage.setItem(LS.base, conf.base_url)
    localStorage.setItem(LS.model, conf.model)
    localStorage.setItem(LS.key, conf.key)
    localStorage.setItem(LS.win, String(conf.window))
    const r = await api.saveConfig(conf)
    setSaveState(r && r.ok ? '已应用 ✓' : '保存失败')
    onSaved(r && r.has_key ? `${conf.model} · 每 ${conf.window}s` : '未配置')
    setTimeout(onClose, 600)
  }

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dlg">
        <h3>AI 分析设置</h3>
        <label>Base URL</label>
        <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.darl.cn/v1" />
        <label>模型</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
        <label>API Key（仅存浏览器 localStorage，随请求发到本机后端）</label>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
        <label>分析窗口（秒）</label>
        <input
          type="number"
          min={5}
          max={300}
          value={win}
          onChange={(e) => setWin(e.target.value)}
        />
        <div className="row">
          <span className="save-state">{saveState}</span>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>
            保存并应用
          </button>
        </div>
        <div className="note">Key 不会写入服务器磁盘，仅保存在你自己的浏览器里。</div>
      </div>
    </div>
  )
}
