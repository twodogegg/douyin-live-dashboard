export type Stat = {
  status: string
  room: string
  room_id: string
  r1_count: number
  r2_count: number
  ai_count: number
  last_ai: string
  logged_in: boolean
  model?: string
  window?: number
  has_key?: boolean
}

// 区域1（主播侧）与区域2（观众侧）共用的消息结构。
// id：区域1 是后端按「行」判定的稳定 bid，区域2 是浏览器端节点 id。
export type MsgItem = {
  id: string | number
  user: string
  text: string
  time: string
}

export type AiCard = {
  time: string
  count: number
  model?: string
  summary?: string
  pending?: boolean
  images?: GeneratedImage[]
}

export type StageConfig = {
  enabled: boolean
  name: string
  system_prompt: string
  cooldown: number
  voice_enabled: boolean
  music_enabled: boolean
  welcome_enabled: boolean
  prefetch_enabled: boolean
}
export type MusicSong = { id: number; name: string; artists: string[]; user: string; query: string; request_id: string }
export type StageMusic = {
  enabled: boolean
  connected: boolean
  playing: boolean
  current: { name: string; artist: string; user?: string } | null
  next: MusicSong | null
  queue: MusicSong[]
  pending: number
  error: string
  notice: string
}
export type StageSentence = { index: number; text: string; audio_url: string }
export type StageReply = {
  id: string
  user: string
  message: string
  text: string
  audio_url: string
  audio_error: string
  test: boolean
  // 逐句合成用：播出窗口按句播放，并在播到下一句前取音频。
  sentences?: StageSentence[]
  // 本次回复回应了哪一批观众消息。
  batch?: { users: string[]; count: number }
  // chat | gift | follow | welcome：决定舞台的状态样式。
  mode?: string
}
export type StageLocal = {
  state: 'idle' | 'arrival' | 'busy' | 'backchannel' | 'follow' | 'gifted' | 'spotlight'
  label: string
  reason: string
  subject: { user?: string; gift?: string; count?: number; value?: number } | null
  since: number
  until: number
}
export type StageInbox = { unread: number; speaking: boolean; prefetched: boolean; dropped: number }
export type StageActivityEvent = {
  id: string
  kind: 'join' | 'follow' | 'gift'
  user: string
  gift: string
  count: number
  value: number
  time: string
}
export type StageState = {
  config: StageConfig
  music: StageMusic | null
  status: 'idle' | 'thinking' | 'synthesizing' | 'ready' | 'error'
  error: string
  last_reply: StageReply | null
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; requests: number; unreported: number }
  activity: { joins: number; follows: number; gifts: number; gift_value: number; events: StageActivityEvent[] }
  local?: StageLocal
  inbox?: StageInbox
}

export type StageEvent = {
  id: number
  ts: number
  time: string
  room_id: string
  session: string
  kind: string
  user: string
  text: string
  gift: string
  count: number | null
  value: number | null
  state: string
  mode: string
  latency_ms: number | null
}
export type StageSummary = {
  messages: number
  replies: number
  gifts: number
  follows: number
  joins: number
  unknown_events: number
  stale: number
  gift_value: number
  avg_latency_ms: number | null
}
export type StageEvents = {
  ok: boolean
  session: string
  events: StageEvent[]
  summary: StageSummary
  ranking: {
    gifts: { user: string; value: number; count: number; times: number }[]
    viewers: { user: string; gifts: number; follows: number; messages: number }[]
  }
}

// ---------- 私信 ----------
export type DmConv = {
  id: string
  legacy_id?: string
  name: string
  avatar: string | null
  preview: string
  last_ts: number
  last_time?: string
  unread: number
  is_group?: boolean | number
  peer_sec_uid?: string
  auto_reply_blocked?: number
}

export type DmMsg = {
  key: string
  conv_id: string
  direction: 'in' | 'out'
  kind?: 'text' | 'image' | 'video' | 'note' | 'audio' | 'unsupported'
  transcript?: string
  text: string
  thumb?: string
  author?: string
  source_id?: string
  sender_id?: string
  sender_name?: string
  sender_avatar?: string
  sender_sec_uid?: string
  aweme_id?: string
  video_url?: string
  media_url?: string
  images?: string[]
  ts: number
  time: string
}

export type DmMedia = {
  ok: boolean
  kind?: 'video' | 'image' | 'note'
  url?: string
  images?: string[]
  text?: string
  author?: string
  msg?: string
}

export type DmGroupMember = {
  id: string
  sec_uid: string
  name: string
  avatar: string
  role?: number
  followed?: boolean
}

export type DmGroup = {
  ok: boolean
  group: boolean
  name?: string
  count?: string
  members: DmGroupMember[]
  conv_id?: string
  total?: number
  complete?: boolean
  msg?: string
}

export type DmStat = {
  receiving?: boolean
  status: string
  running: boolean
  url?: string
  error?: string
  conv_count: number
  active_id: string
  unread: number
  last_scan: string
  sending: boolean
  auto_enabled?: boolean
  auto_status?: string
  account_id?: string
  receive_mode?: 'browser' | 'compare' | 'protocol'
  send_mode?: 'browser'
  phase?: 'receiving' | 'waiting' | 'generating' | 'sending' | 'retrying' | 'paused'
  protocol?: { status: string; error: string; received: number; comparison?: { browser: number; protocol: number; matched: number } }
}

export type AgentCapabilities = {
  tools: string[]
  skills: string[]
  image_model: string
  image_size: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  image_quality: 'auto' | 'low' | 'medium' | 'high'
}

export type DmAgent = AgentCapabilities & {
  receive_mode?: 'browser' | 'compare' | 'protocol'
  system_prompt: string
  agent_rules: string
  temperature: number
  enabled: boolean
  reply_delay: number
  reply_interval: number
  global_interval: number
}

export type DmMemory = {
  send_partial?: number
  send_receipt_id?: string
  send_outcome?: 'pending' | 'unknown' | 'confirmed' | 'failed'
  conv_id: string
  blocked: number
  summary: string
  profile: string
  updated: number
}

export type AgentTool = { id: string; name: string; description: string; risk: 'read' | 'write'; agents: string[]; parameters?: Record<string, unknown> }
export type AgentSkill = { id: string; name: string; description: string; scope: 'builtin' | 'custom' }
export type CapabilityCatalog = { tools: AgentTool[]; skills: AgentSkill[] }
export type GeneratedImage = { name: string; url: string; size: number }
export type DraftResult = { ok: boolean; text?: string; images?: GeneratedImage[]; msg?: string }

export type FishConfig = {
  has_key: boolean
  key?: string
  tts_model: 'drama-3' | 's2.1-pro' | 's2.1-pro-free'
  asr_model: string
  reference_id: string
  voice_name: string
  speed: number
  emotion: string
}

export type FishVoice = { id: string; name: string; description: string; state: string; languages: string[]; tags: string[]; visibility: string }
export type VoiceAudio = { id: string; url: string; text?: string; duration_ms?: number }
export type MemoryProfile = Record<'facts' | 'preferences' | 'inferences', { text: string; evidence: string; updated_at: string }[]>

export type DmContact = { relationship: string; address: string; tone: string; boundaries: string; updated: number; examples: { id: number; source_key: string; original: string; reply: string; created: number }[] }
