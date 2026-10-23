import { useEffect, useState } from 'react'
import { api } from '../api'
import type { DmAgent, DmConv } from '../types'

export function DmSettingsDialog({ convs, onClose, onBlocked }: {
  convs: DmConv[]
  onClose: () => void
  onBlocked: (id: string, blocked: boolean) => Promise<string | undefined>
}) {
  const [agent, setAgent] = useState<DmAgent | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    api.dmAgent().then(c => {
      if (c && typeof c.enabled === 'boolean') setAgent(c)
      else setNote('配置读取失败，请使用 Electron 桌面端')
    })
  }, [])

  const save = async () => {
    if (!agent) return
    setBusy(true)
    const result = await api.dmSaveAgent(agent)
    setBusy(false)
    if (result?.ok) onClose()
    else setNote(result?.msg || '保存失败')
  }

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="dlg settings" role="dialog" aria-label="自动回复设置">
        <h3>自动回复设置</h3>
        {agent && <>
          <label className="check"><input type="checkbox" checked={agent.enabled} onChange={e => setAgent({ ...agent, enabled: e.target.checked })} />开启自动回复</label>
          <p className="note">开启私信后生效，只回复开启后收到的私聊新消息。群聊保留手动回复。回复模型沿用「AI 分析设置」。</p>
          <h4 id="dm-persona-label">角色设定</h4>
          <p className="note">定义角色是谁：身份、背景、性格、说话习惯，以及和对方的关系。</p>
          <textarea id="dm-persona" aria-labelledby="dm-persona-label" rows={6} maxLength={20000} value={agent.system_prompt} onChange={e => setAgent({ ...agent, system_prompt: e.target.value })} />
          <h4 id="dm-agent-rules-label">Agent 功能规则</h4>
          <p className="note">定义如何处理消息、图片、会话记忆和转人工。与角色设定冲突时，优先遵守功能规则。</p>
          <textarea id="dm-agent-rules" aria-labelledby="dm-agent-rules-label" rows={6} maxLength={20000} value={agent.agent_rules || ''} onChange={e => setAgent({ ...agent, agent_rules: e.target.value })} />
          <p className="note">模型输出 [转人工] 时，会暂停此会话自动回复，并加入过滤名单。</p>
          <h4>运行设置</h4>
          <div className="grid">
            {([
              ['reply_delay', '最后一条消息后等待（秒）', 1, 300],
              ['reply_interval', '同一会话最短回复间隔（秒）', 1, 86400],
              ['global_interval', '不同会话发送间隔（秒）', 1, 300],
              ['temperature', '回复随机性', 0, 2],
            ] as const).map(([key, label, min, max]) => <div key={key}>
              <label htmlFor={`dm-${key}`}>{label}</label>
              <input id={`dm-${key}`} type="number" min={min} max={max} step={key === 'temperature' ? 0.1 : 1} value={agent[key]} onChange={e => setAgent({ ...agent, [key]: Number(e.target.value) })} />
            </div>)}
          </div>
          <p className="note">每收到一条新消息就重新计时。例如设为 5 秒，对方停止发送 5 秒后才统一回复；生成期间收到新消息，也会合并后重新生成。人工发送会取消待回复任务。</p>
        </>}
        <h4>过滤名单</h4>
        <p className="note">勾选后立即生效，该会话仅手动回复，仍独立保存摘要记忆。</p>
        <input aria-label="搜索过滤名单" placeholder="搜索会话昵称" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="dm-filter-list">
          {convs.filter(c => !c.is_group && c.name.includes(search.trim())).map(c => <label className="check" key={c.id}>
            <input type="checkbox" checked={!!c.auto_reply_blocked} disabled={busy} onChange={async e => {
              setBusy(true)
              try { setNote(await onBlocked(c.id, e.target.checked) || '') } finally { setBusy(false) }
            }} />
            {c.name || '抖音用户'}<span className="hint">{c.id.slice(-8)}</span>
          </label>)}
          {!convs.length && <p className="note">开启私信并同步后，可在这里选择会话。</p>}
        </div>
        <div className="row"><span className="note" role="status">{note}</span><button onClick={onClose} disabled={busy}>关闭</button><button className="primary" onClick={save} disabled={!agent || busy}>{busy ? '保存中…' : '保存设置'}</button></div>
      </div>
    </div>
  )
}
