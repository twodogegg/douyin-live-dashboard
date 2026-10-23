import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldDescription } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Switch } from './ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
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
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.agentConfig().then((c) => (c ? setAgent(c) : setAgentErr('Agent 配置加载失败，请检查后端服务')))
  }, [])

  const setField = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setAgent((prev) => (prev ? { ...prev, [k]: v } : prev))

  const save = async () => {
    setBusy(true)
    const conf = {
      base_url: base.trim(),
      model: model.trim(),
      key: key.trim(),
      window: parseInt(win) || 20,
    }
    const r = await api.saveConfig(conf)
    const ar = agent ? await api.saveAgentConfig(agent) : { ok: true, msg: '' }
    setBusy(false)
    if (!r?.ok || !ar?.ok) { setSaveState(ar?.msg || '保存失败，请重试'); return }
    localStorage.setItem(LS.base, conf.base_url)
    localStorage.setItem(LS.model, conf.model)
    localStorage.setItem(LS.key, conf.key)
    localStorage.setItem(LS.win, String(conf.window))
    onSaved(r.has_key ? `${conf.model} · 每 ${conf.window}s` : '未配置')
    onClose()
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="settings-content sm:max-w-2xl">
    <DialogHeader><DialogTitle>模型与设置</DialogTitle><DialogDescription>连接模型服务，调整直播摘要的分析方式。私信回复沿用同一模型。</DialogDescription></DialogHeader>
    <Tabs defaultValue="model"><TabsList className="w-full"><TabsTrigger value="model">模型连接</TabsTrigger><TabsTrigger value="analysis">摘要 Agent</TabsTrigger></TabsList>
      <TabsContent value="model"><FieldGroup>
        <Field><FieldLabel htmlFor="ai-base">Base URL</FieldLabel><Input id="ai-base" value={base} onChange={e => setBase(e.target.value)} placeholder="https://api.darl.cn/v1" /></Field>
        <Field><FieldLabel htmlFor="ai-model">模型名称</FieldLabel><Input id="ai-model" value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o-mini" /></Field>
        <Field><FieldLabel htmlFor="ai-key">API Key</FieldLabel><Input id="ai-key" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="留空保留已配置的密钥" /><FieldDescription>用于连接你配置的模型服务。</FieldDescription></Field>
        <Field><FieldLabel htmlFor="ai-window">分析窗口 / 秒</FieldLabel><Input id="ai-window" type="number" min={5} max={300} value={win} onChange={e => setWin(e.target.value)} /><FieldDescription>每个时间窗口结束后，汇总这段时间的直播互动。</FieldDescription></Field>
      </FieldGroup></TabsContent>
      <TabsContent value="analysis">{agent ? <FieldGroup>
        <Field><FieldLabel htmlFor="analysis-prompt">系统提示词</FieldLabel><Textarea id="analysis-prompt" rows={7} value={agent.system_prompt} onChange={e => setField('system_prompt', e.target.value)} /></Field>
        <FieldGroup className="grid grid-cols-2 gap-4">{([
          ['temperature', '随机性', 0, 2, .1], ['max_tokens', '最大输出 tokens', 1, 8000, 1], ['max_chars', '最大输入字符', 100, 50000, 100], ['min_messages', '最少消息条数', 1, 500, 1], ['r1_gap', '主播断句间隔 / 秒', 0, 120, .5],
        ] as const).map(([k, label, min, max, step]) => <Field key={k}><FieldLabel htmlFor={`analysis-${k}`}>{label}</FieldLabel><Input id={`analysis-${k}`} type="number" min={min} max={max} step={step} value={agent[k]} onChange={e => setField(k, Number(e.target.value))} /></Field>)}</FieldGroup>
        {([['keep_prev_summary', '保留上一段摘要作为上下文'], ['merge_repeats', '合并重复的短弹幕'], ['suppress_no_change', '无实质变化时不显示新摘要']] as const).map(([k, label]) => <Field orientation="horizontal" key={k}><FieldLabel htmlFor={`analysis-${k}`}>{label}</FieldLabel><Switch id={`analysis-${k}`} checked={agent[k]} onCheckedChange={value => setField(k, value)} /></Field>)}
      </FieldGroup> : <p className="helper-text">{agentErr || '正在读取配置…'}</p>}</TabsContent>
    </Tabs>
    {saveState && <p role="status" className="error-text">{saveState}</p>}
    <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>取消</Button><Button onClick={save} disabled={!agent || busy}>{busy ? '保存中…' : '保存并应用'}</Button></DialogFooter>
  </DialogContent></Dialog>
}
