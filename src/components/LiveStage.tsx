import { AudioLines, Expand, Fish, MessageCircle, Radio, Settings2, Volume2, VolumeX, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useLiveStream } from '../hooks/useLiveStream'
import { useStagePlayback } from '../hooks/useStagePlayback'
import type { MsgItem, StageReply, StageState, Stat } from '../types'
import { Button } from './ui/button'
import { VoiceDialog } from './VoiceDialog'
import './live-stage.css'

const greeting = '你好呀，我是小鲸！\n发条弹幕，和我聊聊天吧。'
const statusText = { idle: '等待互动', thinking: '正在想怎么回复', synthesizing: '正在准备声音', ready: '正在陪你聊天', error: '回复遇到问题' }

function StageBoard({ messages, stat, stage, reply, speaking = false, preview = false, wsDown = false }: {
  messages: MsgItem[]; stat: Stat; stage: StageState | null; reply: StageReply | null; speaking?: boolean; preview?: boolean; wsDown?: boolean
}) {
  const feed = useRef<HTMLDivElement>(null)
  const name = stage?.config.name || '小鲸'
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [messages])

  return <div className={`stage-board${speaking ? ' is-speaking' : ''}`}>
    <div className="stage-orbit stage-orbit-one" /><div className="stage-orbit stage-orbit-two" />
    <header className="stage-masthead">
      <div className="stage-identity"><span className="stage-logo"><Fish /></span><div><strong>{name}的深海电台</strong><span>把日常说给大海听</span></div></div>
      <div className={`stage-live-tag${!stat.room_id || !stage?.config.enabled || wsDown ? ' is-idle' : ''}`}><Radio />{wsDown ? '连接已断开' : !stat.room_id ? '未连接直播间' : stat.status !== '已进房' ? stat.status : stage?.config.enabled ? '互动已开启' : preview ? '采集预览 · 互动已暂停' : '采集中 · 互动已暂停'}</div>
    </header>
    <div className="stage-main">
      <section className="stage-character-area" aria-label="AI 主播">
        <div className="stage-intro"><span>和 {name} 一起</span><h2>潜入今天的<br />好心情<span>。</span></h2></div>
        <div className="stage-speech" key={reply?.id || 'greeting'} aria-live="polite">
          <div className="stage-speech-label"><span>{reply ? `回复 @${reply.user}` : `${name}想对你说`}</span>{speaking ? <AudioLines /> : <MessageCircle />}</div>
          <p>{reply?.text || greeting}</p>
        </div>
        <div className="stage-character-glow" />
        <img className="stage-character" src="/live-stage/host-maid.png" alt="蓝发鲸鱼女仆小鲸" />
        <div className="stage-character-label"><span className="stage-voice-bars"><i /><i /><i /><i /></span>{speaking ? `${name}正在说话` : !stat.room_id && !reply ? '等待连接直播间' : stage ? statusText[stage.status] : '等你的一条弹幕'}</div>
      </section>
      <aside className="stage-chat">
        <div className="stage-chat-heading"><MessageCircle /><strong>海底来信</strong><span>{messages.length ? `${messages.length} 条互动` : '实时弹幕'}</span></div>
        <div className="stage-activity-counts"><span>进房 <b>{stage?.activity?.joins || 0}</b></span><span>关注 <b>{stage?.activity?.follows || 0}</b></span><small>本次连接检测到</small></div>
        {!!stage?.activity?.events.length && <div className="stage-activity-feed" role="log" aria-label="进房与关注提醒">{stage.activity.events.slice(-3).map(event => <p key={event.id}><time>{event.time}</time><span>{event.user}</span>{event.kind === 'follow' ? '关注了主播' : '进入了直播间'}</p>)}</div>}
        <div ref={feed} className="stage-chat-feed" role="log" aria-label="观众实时消息">
          {messages.slice(-40).map((item, i) => <div className="stage-chat-message" key={`${item.id}-${i}`}><div className={`stage-viewer-avatar color-${i % 4}`}>{(item.user || '观众').slice(0, 1)}</div><div><span>{item.user || '观众'}</span><p>{item.text}</p></div></div>)}
          {!messages.length && <div className="stage-chat-empty"><Waves /><strong>海面静悄悄的</strong><p>{stat.room_id ? '等待第一条观众消息' : '连接直播间，收听大家的来信'}</p></div>}
        </div>
        <div className="stage-chat-footer"><span />每一条消息，都有机会被听见</div>
      </aside>
    </div>
    <footer className="stage-footer"><span><Waves /> 你的树洞，今天也在线</span><span className="stage-token-usage" title="本次应用运行期间的主播 AI 回复用量，包含试播；重启后清零，不包含 TTS">Token <b>{(stage?.usage?.total_tokens || 0).toLocaleString()}</b> · 输入 {(stage?.usage?.prompt_tokens || 0).toLocaleString()} / 输出 {(stage?.usage?.completion_tokens || 0).toLocaleString()}{!!stage?.usage?.unreported && ` · ${stage.usage.unreported} 次未返回用量`}</span></footer>
  </div>
}

export function LiveStageStudio({ messages, stat, stage, reply, wsDown, onOpenSettings }: {
  messages: MsgItem[]; stat: Stat; stage: StageState | null; reply: StageReply | null; wsDown: boolean; onOpenSettings: () => void
}) {
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [draft, setDraft] = useState(stage?.config || null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [testText, setTestText] = useState('你好小鲸，今天有点累，可以鼓励我一下吗？')
  const [previewReply, setPreviewReply] = useState<StageReply | null>(null)

  useEffect(() => { if (stage) setDraft(stage.config) }, [stage?.config.name, stage?.config.system_prompt, stage?.config.cooldown, stage?.config.voice_enabled, stage?.config.enabled])
  useEffect(() => {
    if (stage) return
    let alive = true
    api.stageConfig().then(result => {
      if (!alive) return
      if (result?.config) setDraft(result.config)
      else setNote('直播背景板需要桌面端服务，请运行 npm run dev:desktop。')
    })
    return () => { alive = false }
  }, [stage])

  const action = async (run: () => Promise<void>) => {
    setBusy(true)
    setNote('')
    try { await run() } catch (e) { setNote(e instanceof Error ? e.message : '操作失败') } finally { setBusy(false) }
  }
  const save = async (enabled = draft?.enabled) => {
    if (!draft) return
    const result = await api.stageSave({ ...draft, enabled })
    if (!result?.ok) throw new Error(result?.msg || '保存失败，请检查桌面端服务')
    setDraft(result.config)
    setNote(enabled ? '互动已开启，新观众消息会自动触发回复。' : '设置已保存，自动互动已暂停。')
  }
  const openOutput = () => action(async () => {
    const result = await api.stageOpen()
    if (!result?.ok) window.open(`${location.origin}/#/stage`, 'live-stage-output')
  })

  return <div className="workspace stage-workspace">
    <div className="page-heading"><div><div className="eyebrow">VIRTUAL LIVE STUDIO</div><h1>让每句弹幕，都被听见<span className="heading-dot">.</span></h1><p>小鲸在这里，把观众的来信变成有声音的回应。</p></div><Button onClick={openOutput}><Expand />打开播出窗口</Button></div>
    <div className="stage-studio-grid">
      <section className="stage-preview-section"><div className="stage-preview-heading"><span><span className="status-dot" />播出画面</span><span>16:9 · 预览静音</span></div>
        <div className="stage-preview"><StageBoard messages={messages} stat={stat} stage={stage} reply={previewReply || reply || stage?.last_reply || null} preview wsDown={wsDown} /></div>
        <div className="stage-preview-tools"><span><Fish />蓝鲸电台 · 默认主题</span><Button variant="outline" size="sm" onClick={() => setPreviewReply(previewReply ? null : { id: 'preview', user: '海盐汽水', message: '', text: '辛苦啦！让烦恼先沉到海底，\n小鲸陪你慢慢充会儿电。', audio_url: '', audio_error: '', test: true })}>{previewReply ? '结束气泡预览' : '预览回复气泡'}</Button></div>
        <div className="stage-guide"><Radio /><div><strong>把这个小世界，放进你的直播间</strong><p>在直播伴侣添加「窗口采集」，选择独立播出窗口。语音输出选择虚拟声卡，直播伴侣的麦克风选择它对应的输入设备。</p><small>预览不会播放声音；请在播出窗口点击「启用语音」，并保留窗口开启。</small></div></div>
      </section>
      <aside className="stage-controls">
        <div className="stage-control-heading"><Settings2 /><h2>互动设置</h2><span>{stage ? stage.config.enabled ? '运行中' : '已暂停' : '未连接'}</span></div>
        <div className="stage-usage-note">主播回复累计 {(stage?.usage?.total_tokens || 0).toLocaleString()} token · {stage?.usage?.requests || 0} 次调用<small>本次运行累计，含试播；重启后清零。进房与关注统计以页面实际显示的事件为准。</small>{!!stage?.usage?.unreported && <small>{stage.usage.unreported} 次调用未返回 token 用量，未计入累计。</small>}</div>
        <fieldset disabled={busy || !draft}>
          <label htmlFor="stage-name">主播名字</label><input id="stage-name" value={draft?.name || ''} maxLength={30} onChange={e => draft && setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="stage-persona">主播人设</label><textarea id="stage-persona" rows={5} value={draft?.system_prompt || ''} maxLength={6000} onChange={e => draft && setDraft({ ...draft, system_prompt: e.target.value })} />
          <div className="stage-control-row"><label htmlFor="stage-cooldown">回复间隔 <small>秒</small></label><input id="stage-cooldown" type="number" min={3} max={120} value={draft?.cooldown || 10} onChange={e => draft && setDraft({ ...draft, cooldown: Number(e.target.value) })} /></div>
          <label className="stage-voice-toggle"><span><Volume2 />语音回复<small>使用 Fish Audio 当前音色</small></span><input type="checkbox" checked={draft?.voice_enabled ?? true} onChange={e => draft && setDraft({ ...draft, voice_enabled: e.target.checked })} /></label>
          <div className="stage-settings-links"><button onClick={() => setVoiceOpen(true)}>选择音色</button><button onClick={onOpenSettings}>配置 AI 模型</button></div>
          <div className="stage-start-row"><Button variant="outline" onClick={() => action(() => save())}>保存设置</Button><Button onClick={() => action(() => save(!stage?.config.enabled))}>{stage?.config.enabled ? '暂停互动' : '开启互动'}</Button></div>
        </fieldset>
        <div className="stage-test"><h3>试播一句</h3><p>输入一条观众消息，测试 AI 回复和语音。</p><textarea aria-label="测试观众消息" rows={3} maxLength={1000} value={testText} onChange={e => setTestText(e.target.value)} /><Button variant="outline" disabled={busy || !draft || !testText.trim()} onClick={() => action(async () => {
          await save()
          setPreviewReply(null)
          const result = await api.stageTest(testText)
          if (!result?.ok) throw new Error(result?.msg || '试播失败')
          setNote('回复已送到播出窗口；开启窗口语音后可听到。')
        })}><AudioLines />{busy ? '正在处理…' : '生成试播回复'}</Button></div>
        <p className="stage-control-note" role="status">{note || stage?.error || (wsDown ? '服务连接断开，正在重连…' : stage ? statusText[stage.status] : '正在读取背景板配置…')}</p>
      </aside>
    </div>
    {voiceOpen && <VoiceDialog onClose={() => setVoiceOpen(false)} />}
  </div>
}

export function LiveStageOutput() {
  const { r2, stat, stage, stageReply, wsDown } = useLiveStream()
  const playback = useStagePlayback(stageReply, !wsDown && (!!stage?.config.enabled || !!stageReply?.test))
  const [settings, setSettings] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')
  useEffect(() => { document.title = `${stage?.config.name || '小鲸'}直播间 · 播出画面` }, [stage?.config.name])
  return <div className="stage-output">
    <StageBoard messages={r2} stat={stat} stage={stage} reply={playback.current || stage?.last_reply || null} speaking={playback.speaking} wsDown={wsDown} />
    <div className={`stage-output-tools${!playback.armed || playback.error || settings ? ' visible' : ''}`}>
      <button onClick={() => playback.setArmed(!playback.armed)}>{playback.armed ? <Volume2 /> : <VolumeX />}{playback.armed ? '语音已启用' : '启用语音'}</button>
      <button aria-label="音频输出设置" onClick={() => setSettings(!settings)}><Settings2 /></button>
      <button aria-label="全屏播出" onClick={() => {
        const task = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
        task.catch(() => setFullscreenError('无法进入全屏，请使用系统的窗口全屏按钮。'))
      }}><Expand /></button>
      {settings && <div className="stage-audio-settings"><strong>语音输出设备</strong><select aria-label="语音输出设备" value={playback.device} onChange={e => { void playback.chooseDevice(e.target.value) }}><option value="default">系统默认输出</option>{playback.devices.filter(item => item.deviceId !== 'default').map((item, i) => <option key={item.deviceId} value={item.deviceId}>{item.label || `音频设备 ${i + 1}`}</option>)}</select><button onClick={() => { void playback.refreshDevices(true) }}>检测音频设备</button><p>选择虚拟声卡的输出端，再在直播伴侣中选择对应的麦克风输入。Oray 若只提供输入端，需要另用同时支持输入和输出的虚拟声卡。</p></div>}
      {(playback.error || fullscreenError) && <p className="stage-output-error" role="alert">{playback.error || fullscreenError}</p>}
    </div>
  </div>
}
