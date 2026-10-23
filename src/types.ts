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
  kind?: 'text' | 'image' | 'video' | 'note' | 'unsupported'
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
}

export type DmAgent = {
  system_prompt: string
  agent_rules: string
  temperature: number
  enabled: boolean
  reply_delay: number
  reply_interval: number
  global_interval: number
}

export type DmMemory = {
  conv_id: string
  blocked: number
  summary: string
  updated: number
}
