import { useEffect, useState } from 'react'
import { Bot, Radio } from 'lucide-react'
import { api } from '../api'
import type { DmAgent, DmConv } from '../types'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Switch } from './ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Skeleton } from './ui/skeleton'

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
      else setNote('配置读取失败，请确认桌面服务已启动')
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

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="settings-content sm:max-w-2xl">
      <DialogHeader><DialogTitle>自动回复设置</DialogTitle><DialogDescription>设定你的表达方式，管理消息接收与回复节奏。</DialogDescription></DialogHeader>
      {!agent && !note && <Skeleton className="h-48 w-full" />}
      {agent && <Tabs defaultValue="persona">
        <TabsList className="w-full"><TabsTrigger value="persona">角色与规则</TabsTrigger><TabsTrigger value="runtime">接收与调度</TabsTrigger><TabsTrigger value="filter">过滤名单</TabsTrigger></TabsList>
        <TabsContent value="persona"><FieldGroup>
          <Field orientation="horizontal"><Bot /><div className="flex-1"><FieldLabel htmlFor="auto-enabled">自动回复</FieldLabel><FieldDescription>只处理启动后收到的私聊新消息，群聊由你手动回复。</FieldDescription></div><Switch id="auto-enabled" checked={agent.enabled} onCheckedChange={enabled => setAgent({ ...agent, enabled })} /></Field>
          <Field><FieldLabel htmlFor="dm-persona">角色设定</FieldLabel><FieldDescription>身份、背景、性格和说话习惯。联系人关系可在资料面板单独设置。</FieldDescription><Textarea id="dm-persona" rows={6} maxLength={20000} value={agent.system_prompt} onChange={e => setAgent({ ...agent, system_prompt: e.target.value })} /></Field>
          <Field><FieldLabel htmlFor="dm-agent-rules">Agent 功能规则</FieldLabel><FieldDescription>消息处理、图片理解与转人工规则，优先于角色设定。</FieldDescription><Textarea id="dm-agent-rules" rows={5} maxLength={20000} value={agent.agent_rules || ''} onChange={e => setAgent({ ...agent, agent_rules: e.target.value })} /></Field>
        </FieldGroup></TabsContent>
        <TabsContent value="runtime"><FieldGroup>
          <Field><FieldLabel>消息接收方式</FieldLabel><ToggleGroup type="single" variant="outline" value={agent.receive_mode || 'browser'} onValueChange={value => { if (value) setAgent({ ...agent, receive_mode: value as DmAgent['receive_mode'] }) }}><ToggleGroupItem value="browser">浏览器</ToggleGroupItem><ToggleGroupItem value="compare">协议对照</ToggleGroupItem><ToggleGroupItem value="protocol">实验协议接收</ToggleGroupItem></ToggleGroup><FieldDescription>对照模式观察协议消息，由浏览器链路触发回复。实验接收使用协议事件触发同一个回复队列。</FieldDescription></Field>
          <Alert><Radio /><AlertTitle>协议接收处于验证阶段</AlertTitle><AlertDescription>发送仍使用抖音原生页面。请先用测试账号对照文字、图片、自发消息和重连行为，再开启自动回复。图片通过浏览器读取原始内容。</AlertDescription></Alert>
          <FieldGroup className="grid grid-cols-2 gap-4">
            {([
              ['reply_delay', '合并等待 / 秒', 1, 300], ['reply_interval', '同一会话间隔 / 秒', 1, 86400],
              ['global_interval', '全局发送间隔 / 秒', 1, 300], ['temperature', '回复随机性', 0, 2],
            ] as const).map(([key, label, min, max]) => <Field key={key}><FieldLabel htmlFor={`dm-${key}`}>{label}</FieldLabel><Input id={`dm-${key}`} type="number" min={min} max={max} step={key === 'temperature' ? 0.1 : 1} value={agent[key]} onChange={e => setAgent({ ...agent, [key]: Number(e.target.value) })} /></Field>)}
          </FieldGroup><p className="helper-text">每收到一条新消息重新计时；生成期间的新消息、人工操作及名单变更会使旧回复失效。</p>
        </FieldGroup></TabsContent>
        <TabsContent value="filter"><FieldGroup><Field><FieldLabel htmlFor="filter-search">搜索联系人</FieldLabel><Input id="filter-search" placeholder="按昵称查找" value={search} onChange={e => setSearch(e.target.value)} /><FieldDescription>启用过滤后立即转为手动回复，记忆继续独立保存。</FieldDescription></Field>
          <div className="filter-list">{convs.filter(c => !c.is_group && c.name.includes(search.trim())).map(c => <Field orientation="horizontal" key={c.id}><FieldLabel htmlFor={`blocked-${c.id}`}>{c.name || '抖音用户'}</FieldLabel><Switch id={`blocked-${c.id}`} checked={!!c.auto_reply_blocked} disabled={busy} onCheckedChange={async value => { setBusy(true); try { setNote(await onBlocked(c.id, value) || '') } finally { setBusy(false) } }} /></Field>)}{!convs.length && <p className="helper-text">同步会话后，联系人会显示在这里。</p>}</div>
        </FieldGroup></TabsContent>
      </Tabs>}
      {note && <p role="status" className="error-text">{note}</p>}
      <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>取消</Button><Button onClick={save} disabled={!agent || busy}>{busy ? '保存中…' : '保存设置'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
