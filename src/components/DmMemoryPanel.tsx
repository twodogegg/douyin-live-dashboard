import { useEffect, useState } from 'react'
import { BookOpen, Check, Pencil, Plus, RefreshCw, Save, Search, Trash2, UserRound } from 'lucide-react'
import { api } from '../api'
import type { DmContact, DmMemory, MemoryProfile } from '../types'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

const labels = { facts: '确定事实', preferences: '明确偏好', inferences: '待确认推测' } as const
// 画像只描述聊天对象；evidence 前面统一标出证据来自谁，避免误读成本人信息。
const speakerOf = (evidence: string) => /人工/.test(evidence) ? '人工' : '对方'
const blankProfile = (): MemoryProfile => ({ facts: [], preferences: [], inferences: [] })
const readProfile = (memory: DmMemory | null): MemoryProfile => {
  try { const p = JSON.parse(memory?.profile || ''); return { facts: p.facts || [], preferences: p.preferences || [], inferences: p.inferences || [] } } catch { return blankProfile() }
}
const blankContact: DmContact = { relationship: '', address: '', tone: '', boundaries: '', updated: 0, examples: [] }

export function DmMemoryPanel({ id, memory, name, isGroup, refreshKey = 0, progress = '', onInspect }: { id: string; memory: DmMemory | null; name: string; isGroup?: boolean; refreshKey?: number; progress?: string; onInspect?: (evidence: string) => Promise<{ role: 'me' | 'user'; text: string; ts: number }[]> }) {
  const [editing, setEditing] = useState(false)
  const [summary, setSummary] = useState('')
  const [profile, setProfile] = useState<MemoryProfile>(blankProfile)
  const [contact, setContact] = useState<DmContact>(blankContact)
  const [contactEditing, setContactEditing] = useState(false)
  const [contactSaved, setContactSaved] = useState(false)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [clearing, setClearing] = useState(false)
  const [inspect, setInspect] = useState<{ evidence: string; loading: boolean; runs: { role: 'me' | 'user'; text: string; ts: number }[]; error: string } | null>(null)
  const current = editing ? profile : readProfile(memory)

  const check = async (evidence: string) => {
    setInspect({ evidence, loading: true, runs: [], error: '' })
    try {
      const found = await onInspect?.(evidence) || []
      setInspect({ evidence, loading: false, runs: found, error: found.length ? '' : '在最近 300 条聊天记录里没找到这句依据，可能是更早的消息或已被改写' })
    } catch (e) {
      setInspect({ evidence, loading: false, runs: [], error: e instanceof Error ? e.message : '读取聊天记录失败' })
    }
  }

  useEffect(() => { let alive = true; api.dmContact(id).then(r => { if (alive && r && !('ok' in r)) setContact(r) }); return () => { alive = false } }, [id, refreshKey])

  const save = async (clear = false) => {
    setBusy(true)
    const result = await api.dmSaveMemory(id, clear ? { clear: true } : { summary, profile, expected_updated: version })
    setBusy(false)
    if (result?.ok) { setEditing(false); setClearing(false); setNote(clear ? '已清空记忆，聊天记录已保留' : '记忆已保存') }
    else setNote(result?.msg || '保存失败')
  }

  const rebuild = async () => {
    setBusy(true); setNote('')
    const result = await api.dmRebuildProfile(id)
    setBusy(false)
    setNote(result?.ok ? (result.msg || '画像已重建') : (result?.msg || '重建失败'))
  }

  const saveContact = async () => {
    setBusy(true)
    const result = await api.dmSaveContact(id, contact)
    setBusy(false)
    if (result?.ok && result.contact) { setContact(result.contact); setContactEditing(false); setContactSaved(true); setNote('联系人资料已保存') }
    else setNote(result?.msg || '保存失败')
  }

  return <aside className="contact-panel">
    <div className="contact-panel-heading"><UserRound /><h2>{isGroup ? '会话资料' : '联系人资料'}</h2><Badge variant="outline">独立保存</Badge></div>
    <div className="contact-identity"><span className="contact-monogram">{Array.from(name || '?')[0]}</span><strong>{name || '抖音用户'}</strong><span>{isGroup ? '群聊 · 手动回复' : '抖音私信联系人'}</span></div>
    <Tabs defaultValue="profile" className="contact-tabs">
      <TabsList className="w-full"><TabsTrigger value="profile">画像</TabsTrigger><TabsTrigger value="memory">记忆</TabsTrigger><TabsTrigger value="examples">样例</TabsTrigger></TabsList>
      <TabsContent value="profile">
        <div className="panel-section-title"><h3>相处方式</h3>{!isGroup && <Button variant="ghost" size="icon-sm" aria-label={contactEditing ? '保存联系人资料' : '编辑联系人资料'} onClick={() => contactEditing ? saveContact() : (setContactSaved(false), setContactEditing(true))} disabled={busy}>{contactEditing ? <Save /> : <Pencil />}</Button>}</div>
        {!isGroup && !contactEditing && !contactSaved && !contact.relationship && !contact.address && !contact.tone && !contact.boundaries && <p className="panel-hint contact-empty-hint">这些字段现在只是占位，点右上角的铅笔才能填写。它们会作为固定要求一起参与草稿生成，不需要每次重复交代。</p>}
        <FieldGroup className="gap-4">{([
          ['relationship', '你们的关系', '例如：朋友、客户、合作伙伴'], ['address', '对方的称呼', '希望怎样称呼对方'], ['tone', '语气偏好', '例如：简洁、自然、少用表情'], ['boundaries', '交流禁区', '需要避开的话题或表达'],
        ] as const).map(([key, label, placeholder]) => <Field key={key}><FieldLabel htmlFor={`contact-${key}`}>{label}</FieldLabel>{contactEditing ? <Input id={`contact-${key}`} value={contact[key]} maxLength={500} placeholder={placeholder} disabled={busy} onChange={e => setContact({ ...contact, [key]: e.target.value })} /> : <p className="contact-value">{contact[key] || '尚未设置'}</p>}</Field>)}</FieldGroup>
        <div className="panel-section-title"><h3>对方的画像</h3><Badge variant="secondary">{Object.values(current).reduce((n, a) => n + a.length, 0)} 条</Badge></div>
        <p className="helper-text profile-caption">以下都是「对方」（{name || '聊天对象'}）说的或表现出的信息，不含你和角色的设定。</p>
        {(Object.keys(labels) as (keyof MemoryProfile)[]).map(key => <div className="profile-group" key={key}><h4>{labels[key]}</h4>{!current[key].length && <p className="helper-text">暂无记录</p>}{current[key].map((item, i) => <div className="profile-entry" key={i}><p>{item.text}</p><small><span className="evidence-tag">{speakerOf(item.evidence)}</span>依据：{item.evidence}<br />{item.updated_at}{item.evidence && <Button variant="link" size="sm" className="evidence-jump" onClick={() => check(item.evidence)}><Search data-icon="inline-start" />核对原文</Button>}</small></div>)}</div>)}
        <p className="panel-hint">推测单独保存，不会作为确定事实。画像只整理对方的信息；你说过的话只作为判断对方的依据，不会变成对方的事实。只记录长期特征，不记录“几点说了什么”。</p>
        {!isGroup && <div className="profile-actions"><Button variant="outline" size="sm" disabled={busy} onClick={rebuild}><RefreshCw data-icon="inline-start" />{busy ? '重建中…' : '按全部历史重建画像'}</Button><span className="helper-text">{progress || '按旧到新分段重读聊天记录，先补全语音转写，再只提取稳定特征；不改动摘要。'}</span></div>}
      </TabsContent>
      <TabsContent value="memory">
        <div className="panel-section-title"><h3>近期话题与约定</h3>{!editing && <Button variant="ghost" size="icon-sm" aria-label="编辑记忆" disabled={!memory || busy} onClick={() => { setSummary(memory?.summary || ''); setProfile(readProfile(memory)); setVersion(memory?.updated || 0); setEditing(true); setNote('') }}><Pencil /></Button>}</div>
        {editing ? <FieldGroup><Field><FieldLabel htmlFor="memory-summary">聊天摘要</FieldLabel><Textarea id="memory-summary" rows={6} maxLength={2400} value={summary} disabled={busy} onChange={e => setSummary(e.target.value)} /></Field>
          {(Object.keys(labels) as (keyof MemoryProfile)[]).map(key => <Field key={key}><FieldLabel>{labels[key]}（对方）</FieldLabel>{profile[key].map((item, i) => <div className="flex gap-2" key={i}><Input aria-label={`${labels[key]} ${i + 1}`} value={item.text} maxLength={200} disabled={busy} onChange={e => setProfile({ ...profile, [key]: profile[key].map((v, n) => n === i ? { text: e.target.value, evidence: '人工修订', updated_at: new Date().toISOString() } : v) })} /><Button variant="ghost" size="icon" aria-label={`删除${labels[key]} ${i + 1}`} disabled={busy} onClick={() => setProfile({ ...profile, [key]: profile[key].filter((_, n) => n !== i) })}><Trash2 /></Button></div>)}<Button variant="outline" size="sm" disabled={busy || profile[key].length >= 15} onClick={() => setProfile({ ...profile, [key]: [...profile[key], { text: '', evidence: '人工填写', updated_at: new Date().toISOString() }] })}><Plus data-icon="inline-start" />添加</Button></Field>)}
          <div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => save()}><Check data-icon="inline-start" />保存</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>取消</Button></div>
        </FieldGroup> : <p className="memory-summary">{memory?.summary || '还没有聊天摘要。读取对话后，AI 会整理近期话题、约定和未解决的问题。'}</p>}
        <p className="helper-text">{memory?.updated ? `更新于 ${new Date(memory.updated).toLocaleString('zh-CN', { hour12: false })}` : '等待首次整理'}</p>
        <div className="memory-layer"><BookOpen /><div><strong>原始对话</strong><p>聊天记录保留在会话中，摘要和画像不会替代原始消息。</p></div></div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setClearing(true)}>清空此联系人的记忆</Button>
      </TabsContent>
      <TabsContent value="examples"><div className="panel-section-title"><h3>我的说话样例</h3><Badge variant="secondary">{contact.examples.length}</Badge></div><p className="helper-text">生成草稿后，改成你的语气，再主动点击「收录改写」。仅用于当前联系人。</p>
        {!contact.examples.length && <Empty><EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia><EmptyTitle>让回复更像你</EmptyTitle><EmptyDescription>你确认过的人工改写会出现在这里。</EmptyDescription></EmptyHeader></Empty>}
        {contact.examples.map(example => <div className="example-card" key={example.id}><small>人工确认 · {new Date(example.created).toLocaleDateString('zh-CN')}</small><p>{example.reply}</p><Button variant="ghost" size="sm" disabled={busy} onClick={async () => { setBusy(true); const r = await api.dmDeleteExample(id, example.id); setBusy(false); if (r?.ok && r.contact) setContact(r.contact); else setNote(r?.msg || '删除失败') }}><Trash2 data-icon="inline-start" />移除样例</Button></div>)}
      </TabsContent>
    </Tabs>
    {note && <p className="panel-status" role="status">{note}</p>}
    <Dialog open={clearing} onOpenChange={setClearing}><DialogContent><DialogHeader><DialogTitle>清空此联系人的记忆？</DialogTitle><DialogDescription>将清空摘要和自动整理的画像。原始对话、联系人资料和人工样例继续保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setClearing(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => save(true)}>清空记忆</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!inspect} onOpenChange={open => !open && setInspect(null)}><DialogContent><DialogHeader><DialogTitle>核对原文</DialogTitle><DialogDescription>这条画像的依据在真实聊天记录里对应谁说的话。</DialogDescription></DialogHeader>
      {inspect?.loading && <p className="helper-text">正在读取聊天记录…</p>}
      {inspect?.error && <p className="helper-text">{inspect.error}</p>}
      {!!inspect?.runs.length && <div className="inspect-list">
        <div className="inspect-evidence"><small>画像里的依据</small><p>{inspect.evidence}</p></div>
        {inspect.runs.map((run, i) => <div className={`inspect-run ${run.role}`} key={i}><small>{run.role === 'me' ? '我（本账号发出）' : '对方发出'} · {run.ts ? new Date(run.ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}</small><p>{run.text || '（无文字内容）'}</p></div>)}
        {inspect.runs.every(run => run.role === 'me') && <p className="panel-hint">这段依据全部来自你本人发出的消息。画像本该记对方的信息，说明这次整理把本人的话算成了对方的。</p>}
        {inspect.runs.every(run => run.role === 'user') && <p className="panel-hint">这段依据全部来自对方，来源正确。</p>}
      </div>}
    </DialogContent></Dialog>
  </aside>
}
