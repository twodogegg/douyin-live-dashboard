import { AudioLines, Expand, Fish, Gift, Heart, Inbox, MessageCircle, Music2, Pause, Play, Radio, Settings2, SkipForward, Sparkles, Sun, Volume2, VolumeX, Waves } from 'lucide-react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { api } from '../api'
import { useLiveStream } from '../hooks/useLiveStream'
import { useStagePlayback } from '../hooks/useStagePlayback'
import { initialStageActions, stageActionsReducer } from '../lib/stage-actions'
import type { StageAction, StageActionKind } from '../lib/stage-actions'
import type { MsgItem, StageEvents, StageReply, StageState, Stat } from '../types'
import { Button } from './ui/button'
import { VoiceDialog } from './VoiceDialog'
import './live-stage.css'

const greeting = '你好呀，我是小鲸！\n发条弹幕，和我聊聊天吧。'
const statusText = { idle: '等待互动', thinking: '正在想怎么回复', synthesizing: '正在准备声音', ready: '正在陪你聊天', error: '回复遇到问题' }
// 舞台状态对应的中文说明，用于工作台和播出画面。
const localText: Record<string, string> = {
  idle: '聊天中', arrival: '欢迎新观众', busy: '回应中', backchannel: '垫话中',
  follow: '新关注', gifted: '收到礼物', spotlight: '大礼物',
}

/** 现场状态条：当前状态、在说什么、未读积压，一眼看清直播进行到哪。 */
function StageLiveBar({ stage, eventsDown }: { stage: StageState | null; eventsDown: boolean }) {
  const local = stage?.local
  const inbox = stage?.inbox
  const reply = stage?.last_reply
  const subject = local?.subject
  const stateKey = local?.state || 'idle'
  return <div className={`stage-live-bar state-${stateKey}`}>
    <div className="stage-live-state"><span className="stage-live-dot" /><strong>{localText[stateKey] || stateKey}</strong>{subject?.user && <span>@{subject.user}{subject.gift ? ` · ${subject.gift}${subject.count && subject.count > 1 ? ` ×${subject.count}` : ''}` : ''}</span>}</div>
    <div className="stage-live-now"><AudioLines />{reply ? <span><b>{reply.sentences?.length || 1}</b> 句 · {reply.text.slice(0, 24)}{reply.text.length > 24 ? '…' : ''}</span> : <span>等待下一条观众消息</span>}</div>
    <div className="stage-live-inbox"><Inbox /><span>未读 <b>{inbox?.unread ?? 0}</b></span>{inbox?.prefetched && <em title="下一批回复已经在说话期间准备好了">下一批已就绪</em>}{!!inbox?.dropped && <em className="warn">丢弃 {inbox.dropped}</em>}</div>
    {eventsDown && <span className="stage-live-offline">记录服务未连接</span>}
  </div>
}

const kindText: Record<string, string> = {
  message: '弹幕', reply: '回复', gift: '礼物', follow: '关注', join: '进房',
  welcome: '问候', played: '播放', stale: '过期', error: '错误', unknown_event: '未识别',
}
const kindIcon: Record<string, typeof MessageCircle> = {
  message: MessageCircle, reply: Sparkles, gift: Gift, follow: Heart, join: Waves,
  stale: Inbox, error: Sun, unknown_event: Sun,
}

/** 行为流水：这段时间到底发生了什么，接待了多少人、回了多少条、哪些没接上。 */
function StageEventsPanel({ roomId }: { roomId: string }) {
  const [data, setData] = useState<StageEvents | null>(null)
  const [kind, setKind] = useState('')
  const [scope, setScope] = useState<'session' | 'room'>('session')
  const [error, setError] = useState('')
  const feed = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const result = await api.stageEvents({
      limit: 120,
      kind,
      room_id: roomId,
      ...(scope === 'session' ? { session: '' } : {}),
    })
    if (!result) { setError('读取记录失败，请确认桌面端服务正在运行'); return }
    setError('')
    setData(result)
  }, [kind, roomId, scope])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load() }, 4000)
    return () => window.clearInterval(timer)
  }, [load])

  const summary = data?.summary
  return <section className="stage-events" aria-label="直播行为记录">
    <div className="stage-events-heading"><Inbox /><h3>行为记录</h3><span>{scope === 'session' ? '本次运行' : '同房间以前'}</span></div>
    <div className="stage-events-stats">
      <div><b>{summary?.messages ?? 0}</b><span>弹幕</span></div>
      <div><b>{summary?.replies ?? 0}</b><span>回复</span></div>
      <div><b>{summary?.gifts ?? 0}</b><span>礼物</span></div>
      <div><b>{summary?.follows ?? 0}</b><span>关注</span></div>
      <div><b>{summary?.avg_latency_ms ?? '—'}</b><span>平均延迟 ms</span></div>
    </div>
    <div className="stage-events-toolbar">
      <select aria-label="按类型筛选记录" value={kind} onChange={e => setKind(e.target.value)}>
        <option value="">全部类型</option>
        {Object.entries(kindText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <button onClick={() => setScope(scope === 'session' ? 'room' : 'session')}>{scope === 'session' ? '本次运行' : '同房间历史'}</button>
      <button onClick={() => void load()}>刷新</button>
    </div>
    {error && <p className="stage-events-error" role="alert">{error}</p>}
    <div className="stage-events-feed" ref={feed}>
      {!data?.events.length && !error && <p className="stage-events-empty">还没有记录。连接直播间并开启互动后，这里会记下每一次弹幕、礼物和回复。</p>}
      {data?.events.map(event => {
        const Icon = kindIcon[event.kind] || MessageCircle
        return <div key={event.id} className={`stage-event kind-${event.kind}`}>
          <time>{event.time}</time>
          <Icon />
          <div>
            <span>{kindText[event.kind] || event.kind}{event.gift ? ` ${event.gift}${event.count && event.count > 1 ? ` ×${event.count}` : ''}` : ''}{event.user ? ` · ${event.user}` : ''}{event.mode ? ` · ${event.mode}` : ''}</span>
            {!!event.text && <p>{event.text}</p>}
          </div>
          {event.latency_ms !== null && <em>{event.latency_ms}ms</em>}
        </div>
      })}
    </div>
    {!!data?.ranking.gifts.length && <div className="stage-events-ranking"><strong>礼物榜</strong><ol>{data.ranking.gifts.slice(0, 5).map(item => <li key={item.user}><span>{item.user}</span><b>{item.value.toLocaleString()}</b></li>)}</ol></div>}
  </section>
}

function StageBoard({ messages, stat, stage, reply, speaking = false, preview = false, wsDown = false, currentIndex = 0, total = 1, previewAction = null }: {
  messages: MsgItem[]; stat: Stat; stage: StageState | null; reply: StageReply | null; speaking?: boolean; preview?: boolean; wsDown?: boolean; currentIndex?: number; total?: number; previewAction?: StageAction | null
}) {
  const feed = useRef<HTMLDivElement>(null)
  const [actions, dispatchAction] = useReducer(stageActionsReducer, initialStageActions)
  const [videoError, setVideoError] = useState('')
  const name = stage?.config.name || '小鲸'
  const music = stage?.music
  const local = stage?.local
  const currentAction = actions.queue[0]
  const subject = currentAction && !currentAction.preview ? currentAction : local?.subject
  const bannerKind = currentAction && !currentAction.preview ? currentAction.kind : local?.state === 'follow' ? 'follow' : local?.state === 'gifted' || local?.state === 'spotlight' ? 'gift' : ''
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [messages])
  useEffect(() => {
    dispatchAction({ type: 'sync', room: stat.room_id, online: !!stage && !wsDown, enabled: !!stage?.config.enabled, events: stage?.activity?.events || [] })
  }, [stage, stat.room_id, wsDown])
  useEffect(() => { if (previewAction) dispatchAction({ type: 'preview', action: previewAction }) }, [previewAction])
  useEffect(() => { if (currentAction) setVideoError('') }, [currentAction?.id])

  return <div className={`stage-board${speaking ? ' is-speaking' : ''}${currentAction ? ' has-action' : ''} state-${local?.state || 'idle'}`}>
    {currentAction && <video key={currentAction.id} className="stage-action-video" src={`/live-stage/action-${currentAction.kind}.mp4`} aria-label={currentAction.kind === 'follow' ? '关注后空翻视频' : '礼物吃米饭视频'} autoPlay muted playsInline onEnded={() => dispatchAction({ type: 'ended', id: currentAction.id })} onError={() => { setVideoError('动作视频暂时无法播放'); dispatchAction({ type: 'ended', id: currentAction.id }) }} />}
    {videoError && <div className="stage-action-error" role="alert">{videoError}</div>}
    <div className="stage-orbit stage-orbit-one" /><div className="stage-orbit stage-orbit-two" />
    {/* 礼物与关注在这里浮一下：观众送了什么、是谁，画面上一眼可见。 */}
    {bannerKind && subject?.user && <div className="stage-gift-banner" key={`${bannerKind}-${subject.user}-${subject.gift || ''}`}>
      {bannerKind === 'follow' ? <Heart /> : <Gift />}
      <span>{bannerKind === 'follow' ? `${subject.user} 关注了主播` : `${subject.user} 送出了 ${subject.gift}${subject.count && subject.count > 1 ? ` ×${subject.count}` : ''}`}</span>
    </div>}
    <header className="stage-masthead">
      <div className="stage-identity"><span className="stage-logo"><Fish /></span><div><strong>{name}的深海电台</strong><span>把日常说给大海听</span></div></div>
      <div className={`stage-live-tag${!stat.room_id || !stage?.config.enabled || wsDown ? ' is-idle' : ''}`}><Radio />{wsDown ? '连接已断开' : !stat.room_id ? '未连接直播间' : stat.status !== '已进房' ? stat.status : stage?.config.enabled ? '互动已开启' : preview ? '采集预览 · 互动已暂停' : '采集中 · 互动已暂停'}</div>
    </header>
    <div className="stage-main">
      <section className="stage-character-area" aria-label="AI 主播">
        <div className="stage-intro"><span>和 {name} 一起玩</span><div className="stage-action-cues"><p><Heart />点击关注 · 后空翻</p><p><Gift />送礼物 · 吃大米饭</p></div></div>
        <div className="stage-speech" key={reply?.id || 'greeting'} aria-live="polite">
          <div className="stage-speech-label"><span>{reply ? `回复 @${reply.user}` : `${name}想对你说`}</span>{speaking ? <AudioLines /> : <MessageCircle />}</div>
          <p>{reply?.text || greeting}</p>
        </div>
        <div className="stage-character-glow" />
        <img className="stage-character" src="/live-stage/host-maid.png" alt="蓝发鲸鱼女仆小鲸" />
        <div className="stage-character-label"><span className="stage-voice-bars"><i /><i /><i /><i /></span>{speaking ? `${name}正在说话` : !stat.room_id && !reply ? '等待连接直播间' : stage ? statusText[stage.status] : '等你的一条弹幕'}</div>
        {/* 多句回复时显示进度：观众能看出她还在说，而不是卡住了。 */}
        {speaking && total > 1 && <div className="stage-sentence-progress">第 {currentIndex + 1} / {total} 句</div>}
      </section>
      <aside className="stage-chat">
        <section className="stage-music" aria-label="观众点歌" aria-live="polite">
          <div className="stage-music-heading"><Music2 /><strong>深海点歌台</strong><span>{wsDown ? '连接已断开' : !music?.connected ? '等待连接' : music.playing ? '正在播放' : '已暂停'}</span></div>
          <div className="stage-music-current"><span className={`stage-music-disc${music?.playing && !wsDown ? ' is-playing' : ''}`}><Music2 /></span><div><strong title={music?.current?.name}>{wsDown ? '播放状态待同步' : music?.current?.name || '等待第一首歌'}</strong><p>{!wsDown && music?.current ? `${music.current.artist}${music.current.user ? ` · @${music.current.user} 点播` : ''}` : '发弹幕：点歌 歌名 歌手'}</p></div></div>
          <div className="stage-music-next"><span>下一首</span><strong title={music?.next?.name}>{music?.next ? `${music.next.name} · ${music.next.artists.join('/')}` : music?.pending ? '正在寻找歌曲…' : '暂无点歌'}</strong>{!!music?.queue.length && <small>{music.queue.length} 首待播</small>}</div>
          <p className={`stage-music-notice${music?.error ? ' has-error' : ''}`}>{music?.error || music?.notice || (music?.enabled ? '把想听的歌，交给小鲸' : '观众点歌未开启')}</p>
        </section>
        <div className="stage-chat-heading"><MessageCircle /><strong>海底来信</strong><span>{messages.length ? `${messages.length} 条互动` : '实时弹幕'}</span></div>
        <div className="stage-activity-counts"><span>进房 <b>{stage?.activity?.joins || 0}</b></span><span>关注 <b>{stage?.activity?.follows || 0}</b></span><small>本次连接检测到</small></div>
        {!!stage?.activity?.events.length && <div className="stage-activity-feed" role="log" aria-label="直播互动提醒">{stage.activity.events.slice(-3).map(event => <p key={event.id}><time>{event.time}</time><span>{event.user}</span>{event.kind === 'follow' ? '关注了主播' : event.kind === 'gift' ? `送出了 ${event.gift}${event.count > 1 ? ` ×${event.count}` : ''}` : '进入了直播间'}</p>)}</div>}
        <div ref={feed} className="stage-chat-feed" role="log" aria-label="观众实时消息">
          {messages.slice(-40).map((item, i) => <div className="stage-chat-message" key={`${item.id}-${i}`}><div className={`stage-viewer-avatar color-${i % 4}`}>{(item.user || '观众').slice(0, 1)}</div><div><span>{item.user || '观众'}</span><p>{item.text}</p></div></div>)}
          {!messages.length && <div className="stage-chat-empty"><Waves /><strong>海面静悄悄的</strong><p>{stat.room_id ? '等待第一条观众消息' : '连接直播间，收听大家的来信'}</p></div>}
        </div>
        <div className="stage-chat-footer"><span />每一条消息，都有机会被听见</div>
      </aside>
    </div>
    <footer className="stage-footer"><span><Waves /> 你的树洞，今天也在线</span><span className="stage-token-usage" title="本次应用运行期间的主播互动用量，包含回复、点歌识别与试播；重启后清零，不包含 TTS">Token <b>{(stage?.usage?.total_tokens || 0).toLocaleString()}</b> · 输入 {(stage?.usage?.prompt_tokens || 0).toLocaleString()} / 输出 {(stage?.usage?.completion_tokens || 0).toLocaleString()}{!!stage?.usage?.unreported && ` · ${stage.usage.unreported} 次未返回用量`}</span></footer>
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
  const [previewAction, setPreviewAction] = useState<StageAction | null>(null)
  const previewSequence = useRef(0)
  const [songText, setSongText] = useState('')

  const playPreview = (kind: StageActionKind) => setPreviewAction({ id: `preview-${++previewSequence.current}`, kind, preview: true })

  useEffect(() => { if (stage) setDraft(stage.config) }, [stage?.config.name, stage?.config.system_prompt, stage?.config.cooldown, stage?.config.voice_enabled, stage?.config.enabled, stage?.config.music_enabled])
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
    <StageLiveBar stage={stage} eventsDown={!stage} />
    <div className="stage-studio-grid">
      <section className="stage-preview-section"><div className="stage-preview-heading"><span><span className="status-dot" />播出画面</span><span>16:9 · 预览静音</span></div>
        <div className="stage-preview"><StageBoard messages={messages} stat={stat} stage={stage} reply={previewReply || reply || stage?.last_reply || null} preview wsDown={wsDown} previewAction={previewAction} /></div>
        <div className="stage-preview-tools"><span><Fish />蓝鲸电台 · 默认主题</span><div className="stage-preview-buttons"><Button variant="outline" size="sm" onClick={() => playPreview('follow')}>预览后空翻</Button><Button variant="outline" size="sm" onClick={() => playPreview('gift')}>预览吃米饭</Button><Button variant="outline" size="sm" onClick={() => setPreviewReply(previewReply ? null : { id: 'preview', user: '海盐汽水', message: '', text: '辛苦啦！让烦恼先沉到海底，\n小鲸陪你慢慢充会儿电。', audio_url: '', audio_error: '', test: true })}>{previewReply ? '结束气泡预览' : '预览回复气泡'}</Button></div></div>
        <div className="stage-guide"><Radio /><div><strong>把这个小世界，放进你的直播间</strong><p>在直播伴侣添加「窗口采集」，选择独立播出窗口。语音输出选择虚拟声卡，直播伴侣的麦克风选择它对应的输入设备。</p><small>预览不会播放声音；请在播出窗口点击「启用语音」，并保留窗口开启。</small></div></div>
      </section>
      <aside className="stage-controls">
        <div className="stage-control-heading"><Settings2 /><h2>互动设置</h2><span>{stage ? stage.config.enabled ? '运行中' : '已暂停' : '未连接'}</span></div>
        <div className="stage-usage-note">主播互动累计 {(stage?.usage?.total_tokens || 0).toLocaleString()} token · {stage?.usage?.requests || 0} 次调用<small>本次运行累计，含点歌识别与试播；重启后清零。进房与关注统计以页面实际显示的事件为准。</small>{!!stage?.usage?.unreported && <small>{stage.usage.unreported} 次调用未返回 token 用量，未计入累计。</small>}</div>
        <fieldset disabled={busy || !draft}>
          <label htmlFor="stage-name">主播名字</label><input id="stage-name" value={draft?.name || ''} maxLength={30} onChange={e => draft && setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="stage-persona">主播人设</label><textarea id="stage-persona" rows={5} value={draft?.system_prompt || ''} maxLength={6000} onChange={e => draft && setDraft({ ...draft, system_prompt: e.target.value })} />
          <div className="stage-control-row"><label htmlFor="stage-cooldown">回复间隔 <small>秒</small></label><input id="stage-cooldown" type="number" min={3} max={120} value={draft?.cooldown || 10} onChange={e => draft && setDraft({ ...draft, cooldown: Number(e.target.value) })} /></div>
          <label className="stage-voice-toggle"><span><Volume2 />语音回复<small>使用 Fish Audio 当前音色</small></span><input type="checkbox" checked={draft?.voice_enabled ?? true} onChange={e => draft && setDraft({ ...draft, voice_enabled: e.target.checked })} /></label>
          <label className="stage-voice-toggle"><span><Music2 />观众点歌<small>按弹幕顺序排队，由网易云客户端播放</small></span><input type="checkbox" checked={draft?.music_enabled ?? false} onChange={e => draft && setDraft({ ...draft, music_enabled: e.target.checked })} /></label>
          <label className="stage-voice-toggle"><span><Waves />进房欢迎<small>观众进入时打招呼，不会打断正在进行的感谢</small></span><input type="checkbox" checked={draft?.welcome_enabled ?? true} onChange={e => draft && setDraft({ ...draft, welcome_enabled: e.target.checked })} /></label>
          <label className="stage-voice-toggle"><span><Sparkles />预取下一批<small>说话时同时生成下一条回复，播完即刻接上</small></span><input type="checkbox" checked={draft?.prefetch_enabled ?? true} onChange={e => draft && setDraft({ ...draft, prefetch_enabled: e.target.checked })} /></label>
          <div className="stage-settings-links"><button onClick={() => setVoiceOpen(true)}>选择音色</button><button onClick={onOpenSettings}>配置 AI 模型</button></div>
          <div className="stage-start-row"><Button variant="outline" onClick={() => action(() => save())}>保存设置</Button><Button onClick={() => action(() => save(!stage?.config.enabled))}>{stage?.config.enabled ? '暂停互动' : '开启互动'}</Button></div>
        </fieldset>
        <div className="stage-test stage-music-controls"><h3>网易云音乐</h3><p>无需开播，输入歌名即可本地测试。</p><p>{stage?.music?.connected ? '已连接 · 音乐沿用网易云的系统输出' : '首次连接会重新打开网易云客户端'}</p><Button variant="outline" disabled={busy} onClick={() => action(async () => {
          const result = await api.musicConnect()
          if (!result?.ok) throw new Error(result?.msg || '连接失败')
          setNote('网易云已连接，开启观众点歌并保存设置后即可接收弹幕点歌。')
        })}><Music2 />{stage?.music?.connected ? '重新连接网易云' : '连接网易云'}</Button>
          <div className="stage-start-row"><Button variant="outline" disabled={busy || !stage?.music?.connected} onClick={() => action(async () => { const r = await api.musicControl('play_pause'); if (!r?.ok) throw new Error(r?.msg || '操作失败') })}>{stage?.music?.playing ? <Pause /> : <Play />}{stage?.music?.playing ? '暂停音乐' : '播放音乐'}</Button><Button variant="outline" disabled={busy || !stage?.music?.connected} onClick={() => action(async () => { const r = await api.musicControl('next'); if (!r?.ok) throw new Error(r?.msg || '操作失败') })}><SkipForward />播放下一首</Button></div>
          <input aria-label="点播歌曲" placeholder="歌名，可加歌手" value={songText} maxLength={180} onChange={e => setSongText(e.target.value)} />
          <Button variant="outline" disabled={busy || !songText.trim() || !stage?.music?.enabled || !stage?.music?.connected} onClick={() => action(async () => { const r = await api.musicRequest(`点歌 ${songText.trim()}`); if (!r?.ok) throw new Error(r?.msg || '点歌失败'); setSongText('') })}>加入点歌队列</Button>
          {!!stage?.music?.queue.length && <ol className="stage-music-queue" aria-label="待播歌曲">{stage.music.queue.map(song => <li key={song.request_id}><strong>{song.name}</strong><span>{song.artists.join('/')} · @{song.user}</span></li>)}</ol>}
          <p role="status">{stage?.music?.error || stage?.music?.notice}</p>
        </div>
        <div className="stage-test"><h3>试播一句</h3><p>输入一条观众消息，测试 AI 回复和语音。</p><textarea aria-label="测试观众消息" rows={3} maxLength={1000} value={testText} onChange={e => setTestText(e.target.value)} /><Button variant="outline" disabled={busy || !draft || !testText.trim()} onClick={() => action(async () => {
          await save()
          setPreviewReply(null)
          const result = await api.stageTest(testText)
          if (!result?.ok) throw new Error(result?.msg || '试播失败')
          setNote('回复已送到播出窗口；开启窗口语音后可听到。')
        })}><AudioLines />{busy ? '正在处理…' : '生成试播回复'}</Button></div>
        <p className="stage-control-note" role="status">{note || stage?.error || (wsDown ? '服务连接断开，正在重连…' : stage ? statusText[stage.status] : '正在读取背景板配置…')}</p>
      </aside>
      <StageEventsPanel roomId={stat.room_id} />
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
    <StageBoard messages={r2} stat={stat} stage={stage} reply={playback.current || stage?.last_reply || null} speaking={playback.speaking} wsDown={wsDown} currentIndex={playback.currentIndex} total={playback.total} />
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
