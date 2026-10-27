import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Wrench } from 'lucide-react'
import { api } from '../api'
import type { AgentCapabilities, CapabilityCatalog } from '../types'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from './ui/field'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'

const SIZE_OPTIONS = [
  ['1024x1024', '方形 1024×1024'],
  ['1536x1024', '横版 1536×1024'],
  ['1024x1536', '竖版 1024×1536'],
  ['auto', '自动'],
] as const

const QUALITY_OPTIONS = [
  ['low', '低（更快）'],
  ['medium', '中'],
  ['high', '高（更精细）'],
  ['auto', '自动'],
] as const

/**
 * 工具与 Skills 勾选面板。目录元数据从 /capabilities 首屏加载，
 * 完整指令只在服务端执行时读取，不随配置接口下发。
 */
export function CapabilityPicker({ agent, value, onChange }: {
  agent: 'dm' | 'live'
  value: AgentCapabilities
  onChange: (next: AgentCapabilities) => void
}) {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    api.capabilities().then(c => {
      if (!alive) return
      if (c && Array.isArray(c.tools)) setCatalog(c)
      else setError('工具目录加载失败，请确认桌面服务已启动')
    })
    return () => { alive = false }
  }, [])

  const tools = useMemo(
    () => (catalog?.tools || []).filter(tool => tool.agents.includes(agent)),
    [catalog, agent],
  )
  const skills = catalog?.skills || []
  const toggle = (key: 'tools' | 'skills', id: string) => {
    const set = new Set(value[key])
    if (set.has(id)) set.delete(id)
    else set.add(id)
    onChange({ ...value, [key]: [...set] })
  }

  if (!catalog && !error) return <Skeleton className="h-56 w-full" />
  if (error) return <p role="alert" className="error-text">{error}</p>

  return <FieldGroup>
    <FieldSet>
      <FieldLegend>可用工具</FieldLegend>
      <FieldDescription>勾选后，模型才能调用对应工具；未勾选的工具不会出现在模型的工具列表里。</FieldDescription>
      {tools.map(tool => <Field orientation="horizontal" key={tool.id}>
        <FieldLabel htmlFor={`tool-${tool.id}`} className="w-full">
          <span className="flex items-center gap-2"><Wrench className="size-4 text-muted-foreground" /><strong className="text-sm font-medium">{tool.name}</strong>
            <Badge variant={tool.risk === 'write' ? 'default' : 'secondary'}>{tool.risk === 'write' ? '写操作' : '只读'}</Badge>
          </span>
          <FieldDescription>{tool.description}</FieldDescription>
        </FieldLabel>
        <Checkbox id={`tool-${tool.id}`} checked={value.tools.includes(tool.id)} onCheckedChange={() => toggle('tools', tool.id)} />
      </Field>)}
    </FieldSet>

    <FieldSet>
      <FieldLegend>Skills</FieldLegend>
      <FieldDescription>选中的 Skill 会把指令注入 Agent 的系统提示；未选中的完全不参与。</FieldDescription>
      {skills.map(skill => <Field orientation="horizontal" key={skill.id}>
        <FieldLabel htmlFor={`skill-${skill.id}`} className="w-full">
          <span className="flex items-center gap-2"><Sparkles className="size-4 text-muted-foreground" /><strong className="text-sm font-medium">{skill.name}</strong>
            <Badge variant="outline">{skill.scope === 'builtin' ? '内置' : '自定义'}</Badge>
          </span>
          <FieldDescription>{skill.description}</FieldDescription>
        </FieldLabel>
        <Checkbox id={`skill-${skill.id}`} checked={value.skills.includes(skill.id)} onCheckedChange={() => toggle('skills', skill.id)} />
      </Field>)}
      {!skills.length && <p className="helper-text">还没有可用的 Skill。</p>}
    </FieldSet>

    {value.tools.includes('generate_image') && <FieldSet>
      <FieldLegend>生图模型</FieldLegend>
      <FieldDescription>沿用「模型连接」里的 Base URL 和 API Key；密钥不会出现在配置接口或日志里。</FieldDescription>
      <Field><FieldLabel htmlFor="image-model">模型名称</FieldLabel>
        <Input id="image-model" value={value.image_model} onChange={e => onChange({ ...value, image_model: e.target.value })} placeholder="gpt-image-2.5-flare" /></Field>
      <FieldGroup className="grid grid-cols-2 gap-4">
        <Field><FieldLabel htmlFor="image-size">默认尺寸</FieldLabel>
          <Input id="image-size" list="image-size-options" value={value.image_size} onChange={e => onChange({ ...value, image_size: e.target.value as AgentCapabilities['image_size'] })} />
          <datalist id="image-size-options">{SIZE_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</datalist>
        </Field>
        <Field><FieldLabel htmlFor="image-quality">默认质量</FieldLabel>
          <Input id="image-quality" list="image-quality-options" value={value.image_quality} onChange={e => onChange({ ...value, image_quality: e.target.value as AgentCapabilities['image_quality'] })} />
          <datalist id="image-quality-options">{QUALITY_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</datalist>
        </Field>
      </FieldGroup>
    </FieldSet>}
  </FieldGroup>
}
