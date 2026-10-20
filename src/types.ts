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
