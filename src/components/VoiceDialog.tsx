import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { api } from '../api'
import type { FishConfig, FishVoice, VoiceAudio } from '../types'

const sample = '今天过得怎么样？忙完了就休息一会儿，我们慢慢聊。'

export function VoiceDialog({ onClose, initialText = '' }: { onClose: () => void; initialText?: string }) {
  const [config, setConfig] = useState<FishConfig | null>(null)
  const [tab, setTab] = useState<'library' | 'design' | 'clone'>('library')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [own, setOwn] = useState(false)
  const [language, setLanguage] = useState('zh')
  const [page, setPage] = useState(1)
  const [voices, setVoices] = useState<FishVoice[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [text, setText] = useState(initialText.trim().slice(0, 2000) || sample)
  const [audio, setAudio] = useState<VoiceAudio | null>(null)
  const [instruction, setInstruction] = useState('')
  const [candidates, setCandidates] = useState<VoiceAudio[]>([])
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileUrl, setFileUrl] = useState('')
  const [transcript, setTranscript] = useState('')
  const [consent, setConsent] = useState(false)

  useEffect(() => {
    let alive = true
    api.voiceConfig().then(c => { if (alive) { if (c?.asr_model) setConfig(c); else setNote('语音配置读取失败，请使用更新后的桌面端') } })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!file) { setFileUrl(''); return }
    const url = URL.createObjectURL(file)
    setFileUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (!config?.has_key || tab !== 'library') return
    let alive = true
    setListBusy(true)
    setNote('')
    setVoices([])
    const id = query.match(/[a-f\d]{32}/i)?.[0]
    const run = async () => {
      if (id) {
        const r = await api.voiceGet(id)
        if (!alive) return
        setVoices(r?.ok && r.voice ? [r.voice] : [])
        setHasMore(false)
        if (!r?.ok) setNote(r?.msg || '没有找到该音色')
      } else {
        const r = await api.voiceList(query, own, page, language)
        if (!alive) return
        setVoices(r?.items || [])
        setHasMore(!!r?.has_more)
        if (!r?.ok) setNote(r?.msg || '音色列表加载失败')
      }
      if (alive) setListBusy(false)
    }
    run()
    return () => { alive = false }
  }, [config?.has_key, tab, own, query, page, language, refresh])

  const saveConfig = async (next = config) => {
    if (!next) return null
    const r = await api.voiceSaveConfig(next)
    if (!r?.ok || !r.config) throw new Error(r?.msg || '语音设置保存失败')
    setConfig(r.config)
    return r.config
  }

  const action = async (label: string, run: () => Promise<void>) => {
    setBusy(label)
    setNote('')
    try { await run() } catch (e) { setNote(e instanceof Error ? e.message : '操作失败，请重试') } finally { setBusy('') }
  }

  const preview = (voice?: FishVoice) => action('正在合成语音…', async () => {
    await saveConfig()
    const r = await api.voicePreview(text, voice?.id)
    if (!r?.ok) throw new Error(r?.msg || '语音合成失败')
    setAudio(r)
    setNote(`已生成${voice ? ` · ${voice.name}` : ''}，点击播放试听`)
  })

  const choose = (voice: FishVoice) => action('正在切换音色…', async () => {
    if (voice.state !== 'trained') throw new Error('音色尚未就绪，请稍后刷新')
    if (config) await saveConfig({ ...config, reference_id: voice.id, voice_name: voice.name })
    setNote(`当前音色：${voice.name}`)
  })

  const create = (candidate?: VoiceAudio) => action('正在创建私有音色…', async () => {
    await saveConfig()
    let encoded: string | undefined
    if (!candidate) {
      if (!file) throw new Error('请选择参考录音')
      if (!consent) throw new Error('请确认录音使用授权')
      if (file.size > 20 * 1024 * 1024) throw new Error('录音不能超过 20 MB')
      encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('录音读取失败'))
        reader.readAsDataURL(file)
      })
    }
    const r = await api.voiceCreate({ name, ...(candidate ? { candidate_id: candidate.id } : { audio: encoded, mime: file?.type, transcript, consent }) })
    if (!r?.ok || !r.voice) throw new Error(r?.msg || '音色创建失败')
    setOwn(true)
    setLanguage('')
    setSearch('')
    setQuery('')
    setPage(1)
    setTab('library')
    setRefresh(n => n + 1)
    setNote(`已创建「${r.voice.name}」${r.voice.state === 'trained' ? '，可在我的音色中选择' : '，正在处理，稍后刷新查看'}`)
  })

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="settings-content sm:max-w-2xl"><div className="dlg settings voice-dialog"><DialogHeader><DialogTitle>音色与语音</DialogTitle><DialogDescription>管理音色，生成语音试听或识别语音内容。</DialogDescription></DialogHeader>
      <p className="note">当前音色：{config?.voice_name || config?.reference_id || '尚未选择'}</p>
      <p className="note">支持语音识别、合成与试听。当前抖音网页端没有语音发送入口。</p>
      {config && <fieldset disabled={!!busy}>
        <details open={!config.has_key}>
          <summary>语音设置</summary>
          <label htmlFor="fish-key">Fish Audio API Key</label>
          <input id="fish-key" type="password" autoComplete="new-password" value={config.key || ''} placeholder={config.has_key ? '已保存，留空保持原密钥' : '输入 API Key'} onChange={e => setConfig({ ...config, key: e.target.value })} />
          <div className="grid">
            <div><label htmlFor="fish-model">语音模型</label><select id="fish-model" value={config.tts_model} onChange={e => setConfig({ ...config, tts_model: e.target.value as FishConfig['tts_model'] })}>
              <option value="drama-3">Drama 3 · 最新</option><option value="s2.1-pro">S2.1 Pro</option><option value="s2.1-pro-free">S2.1 Pro Free · 测试</option>
            </select></div>
            <div><label htmlFor="fish-speed">语速</label><input id="fish-speed" type="number" min="0.5" max="2" step="0.1" value={config.speed} onChange={e => setConfig({ ...config, speed: Number(e.target.value) })} /></div>
          </div>
          <label htmlFor="fish-emotion">情绪与表达</label>
          <input id="fish-emotion" maxLength={500} value={config.emotion} placeholder="例如：温柔、放慢语速，带一点笑意" onChange={e => setConfig({ ...config, emotion: e.target.value })} />
          <p className="note">语音识别使用 Transcribe 1 Pro。表达指令只用于合成声音。</p>
          <div className="row"><button onClick={() => action('正在保存…', async () => { await saveConfig(); setRefresh(n => n + 1); setNote('语音设置已保存') })}>保存语音设置</button></div>
        </details>
        <label htmlFor="voice-text">试听文字</label>
        <textarea id="voice-text" rows={2} maxLength={2000} value={text} onChange={e => setText(e.target.value)} />
        <div className="row"><button disabled={!config.reference_id || !text.trim()} onClick={() => preview()}>使用当前音色生成</button></div>
        {audio && <div className="voice-preview"><audio key={audio.url} controls src={audio.url} /><a href={audio.url} download="语音.mp3">下载音频</a></div>}
        <div className="voice-tabs" role="tablist" aria-label="音色来源">
          {([['library', '音色库'], ['design', '设计音色'], ['clone', '音色复刻']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
        </div>
        {tab === 'library' && <>
          <form className="voice-search" onSubmit={e => { e.preventDefault(); setPage(1); setQuery(search.trim()); setRefresh(n => n + 1) }}>
            <input aria-label="搜索音色" placeholder="搜索音色名称，或粘贴音色 ID / 链接" value={search} maxLength={300} onChange={e => setSearch(e.target.value)} />
            <button type="submit">搜索</button>
          </form>
          <div className="voice-filters">
            <label className="check"><input type="checkbox" checked={own} onChange={e => { setOwn(e.target.checked); setPage(1) }} />我的音色</label>
            <select aria-label="音色语言" value={language} onChange={e => { setLanguage(e.target.value); setPage(1) }}><option value="zh">中文</option><option value="">全部语言</option><option value="en">英语</option><option value="ja">日语</option></select>
            <button onClick={() => setRefresh(n => n + 1)}>刷新</button>
          </div>
          {listBusy ? <p className="note">正在搜索音色…</p> : <div className="voice-list">
            {voices.map(voice => <article className="voice-card" key={voice.id}>
              <strong>{voice.name}</strong><span className="note">{config.reference_id === voice.id ? '当前使用' : voice.state === 'trained' ? voice.languages.join(' / ') : voice.state === 'failed' ? '创建失败' : '处理中'}</span>
              <p>{voice.description || voice.tags.join(' · ') || '暂无描述'}</p>
              <div className="row"><button disabled={voice.state !== 'trained' || !text.trim()} onClick={() => preview(voice)}>合成试听</button><button className="primary" disabled={voice.state !== 'trained' || config.reference_id === voice.id} onClick={() => choose(voice)}>使用此音色</button></div>
            </article>)}
            {!voices.length && <p className="note">{config.has_key ? '没有匹配的音色，可更换关键词或语言后搜索' : '请先保存 Fish Audio API Key'}</p>}
          </div>}
          <div className="row"><button disabled={page === 1 || listBusy} onClick={() => setPage(n => n - 1)}>上一页</button><span>第 {page} 页</span><button disabled={!hasMore || listBusy} onClick={() => setPage(n => n + 1)}>下一页</button></div>
        </>}
        {tab === 'design' && <>
          <label htmlFor="voice-instruction">想要怎样的声音</label>
          <textarea id="voice-instruction" rows={3} maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例如：年轻女性，中低音，温柔自然，语速稍慢，像熟悉的朋友聊天" />
          <p className="note">生成 4 个候选供试听，选中后再保存为私有音色。设计试听使用上方文字的前 150 字。</p>
          <div className="row"><button className="primary" disabled={!instruction.trim() || !text.trim()} onClick={() => action('正在设计音色…', async () => {
            await saveConfig()
            const r = await api.voiceDesign(instruction, text.slice(0, 150))
            if (!r?.ok) throw new Error(r?.msg || '音色设计失败')
            setCandidates(r.candidates)
            setNote('候选已生成，请试听后选择')
          })}>生成音色候选</button></div>
          {!!candidates.length && <><label htmlFor="design-name">保存后的音色名称</label><input id="design-name" maxLength={100} value={name} onChange={e => setName(e.target.value)} />
            {candidates.map((c, i) => <div className="voice-candidate" key={c.id}><span>候选 {i + 1}</span><audio controls src={c.url} /><button disabled={!name.trim()} onClick={() => create(c)}>保存此音色</button></div>)}
          </>}
        </>}
        {tab === 'clone' && <>
          <label htmlFor="clone-name">音色名称</label><input id="clone-name" value={name} maxLength={100} onChange={e => setName(e.target.value)} />
          <label htmlFor="clone-file">参考录音</label><input id="clone-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.opus,.flac" onChange={e => { setFile(e.target.files?.[0] || null); setConsent(false) }} />
          <p className="note">选择清晰的单人录音，建议 1–2 分钟、至少 10 秒，大小不超过 20 MB。创建后仅自己可见。</p>
          {fileUrl && <audio className="voice-reference" controls src={fileUrl} />}
          <label htmlFor="clone-transcript">录音文字（可选）</label><textarea id="clone-transcript" rows={2} maxLength={10000} value={transcript} onChange={e => setTranscript(e.target.value)} placeholder="填写与录音一致的内容，留空由服务识别" />
          <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />这是我本人的声音，或已获得声音所有者授权</label>
          <div className="row"><button className="primary" disabled={!name.trim() || !file || !consent} onClick={() => create()}>创建私有复刻音色</button></div>
        </>}
      </fieldset>}
      <p className="note" role="status">{busy || note}</p>
    </div></DialogContent></Dialog>
}
