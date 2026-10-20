import { useEffect, useState } from 'react'
import { api, type AgentConfig } from '../api'

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
  const [agent, setAgent] = useState<AgentConfig | null>(null)
  const [agentErr, setAgentErr] = useState('')
  const [saveState, setSaveState] = useState('')

  useEffect(() => {
    api.agentConfig().then((c) => (c ? setAgent(c) : setAgentErr('Agent 配置加载失败，请检查后端服务')))
  }, [])

  const setField = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setAgent((prev) => (prev ? { ...prev, [k]: v } : prev))

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
    const ar = agent ? await api.saveAgentConfig(agent) : { ok: true, msg: '' }
    setSaveState(r && r.ok && ar && ar.ok ? '已应用 ✓' : (ar && ar.msg) || '保存失败')
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
      <div className="dlg settings">
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

        <h4>分析 Agent</h4>
        <label>系统提示词</label>
        {agent ? (
          <>
            <textarea
              rows={10}
              value={agent.system_prompt}
              onChange={(e) => setField('system_prompt', e.target.value)}
            />
            <div className="grid">
              <div>
                <label>Temperature</label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={2}
                  value={agent.temperature}
                  onChange={(e) => setField('temperature', Number(e.target.value))}
                />
              </div>
              <div>
                <label>Max tokens</label>
                <input
                  type="number"
                  min={1}
                  max={8000}
                  value={agent.max_tokens}
                  onChange={(e) => setField('max_tokens', Number(e.target.value))}
                />
              </div>
              <div>
                <label>送模型最大字符数</label>
                <input
                  type="number"
                  min={100}
                  max={50000}
                  value={agent.max_chars}
                  onChange={(e) => setField('max_chars', Number(e.target.value))}
                />
              </div>
              <div>
                <label>最少消息条数</label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={agent.min_messages}
                  onChange={(e) => setField('min_messages', Number(e.target.value))}
                />
              </div>
              <div>
                <label>主播侧断句间隔（秒）</label>
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  max={120}
                  value={agent.r1_gap}
                  onChange={(e) => setField('r1_gap', Number(e.target.value))}
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={agent.keep_prev_summary}
                  onChange={(e) => setField('keep_prev_summary', e.target.checked)}
                />
                把上一段摘要作为上下文
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={agent.merge_repeats}
                  onChange={(e) => setField('merge_repeats', e.target.checked)}
                />
                合并重复短弹幕
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={agent.suppress_no_change}
                  onChange={(e) => setField('suppress_no_change', e.target.checked)}
                />
                无实质变化时不上屏
              </label>
            </div>
          </>
        ) : (
          <div className="note">{agentErr || 'Agent 配置加载中…'}</div>
        )}

        <div className="row">
          <span className="save-state">{saveState}</span>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save} disabled={!agent}>
            保存并应用
          </button>
        </div>
        <div className="note">
          Key 不会写入服务器磁盘，仅保存在你自己的浏览器里。Agent 配置保存在本机应用数据目录的 agent_config.json。
        </div>
      </div>
    </div>
  )
}
