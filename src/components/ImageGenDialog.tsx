import { useEffect, useState } from 'react'
import { ImageIcon, Send } from 'lucide-react'
import { api } from '../api'
import type { GeneratedImage } from '../types'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Textarea } from './ui/textarea'

/**
 * 手动生图弹窗：生成结果只落本地目录，通过 /generated-images 预览；
 * 发送时才把文件交给抖音私信页的原生上传控件。
 */
export function ImageGenDialog({ convId, onClose, onSent }: {
  convId: string
  onClose: () => void
  onSent: (message: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<'' | 'generate' | 'send'>('')
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [note, setNote] = useState('')

  useEffect(() => { if (busy === 'generate') setNote('正在生成图片…') }, [busy])

  const generate = async () => {
    if (!prompt.trim()) { setNote('请先填写图片描述'); return }
    setBusy('generate')
    setNote('')
    const r = await api.dmGenerateImages({ prompt: prompt.trim(), size: 'auto', n: 1 })
    setBusy('')
    if (r?.ok && r.images?.length) { setImages(r.images); setNote('已生成，确认后发送') }
    else setNote(r?.msg || '生成失败，请重试')
  }

  const send = async (image: GeneratedImage) => {
    setBusy('send')
    setNote('正在发送图片…')
    const r = await api.dmSendImage(convId, image.url)
    setBusy('')
    if (r?.ok) { onSent('图片已发送'); onClose() }
    else setNote(r?.msg || '发送失败，请在抖音窗口确认')
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="settings-content sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>AI 生图</DialogTitle>
        <DialogDescription>生成结果先在本机预览，点发送后才会上传到当前会话。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field><FieldLabel htmlFor="image-prompt">图片描述</FieldLabel>
          <Textarea id="image-prompt" rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述想要的画面：主体、场景、光线、风格…" /></Field>
        {!!images.length && <div className="generated-image-grid">
          {images.map(image => <figure key={image.url}>
            <img src={image.url} alt={image.name} loading="lazy" />
            <figcaption>
              <span>{(image.size / 1024).toFixed(0)} KB</span>
              <Button size="sm" disabled={!!busy} onClick={() => void send(image)}><Send data-icon="inline-start" />{busy === 'send' ? '发送中…' : '发送'}</Button>
            </figcaption>
          </figure>)}
        </div>}
      </FieldGroup>
      {note && <p role="status" className={/^生成失败|发送失败|请先/.test(note) ? 'error-text' : 'helper-text'}>{note}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={!!busy}>关闭</Button>
        <Button onClick={generate} disabled={!!busy}><ImageIcon data-icon="inline-start" />{busy === 'generate' ? '生成中…' : '生成图片'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
