import type { AiCard, MsgItem, Stat } from './types'

async function req<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(path, init)
    return (await r.json()) as T
  } catch {
    return null
  }
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  ...(body === undefined
    ? {}
    : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
})

export type ConfigPayload = { base_url: string; model: string; key: string; window: number }
export type ConfigResult = { ok: boolean; model: string; window: number; has_key: boolean }
export type AgentConfig = {
  system_prompt: string
  temperature: number
  max_tokens: number
  max_chars: number
  min_messages: number
  r1_gap: number
  keep_prev_summary: boolean
  merge_repeats: boolean
  repeat_max_chars: number
  repeat_min_count: number
  no_change_marker: string
  suppress_no_change: boolean
  region_labels: { r1: string; r2: string }
}
export type AgentSaveResult = { ok: boolean; msg?: string; config?: AgentConfig }
export type ConnResult = { ok: boolean; msg?: string; room_id?: string; room?: string }
export type LoginResult = { ok: boolean; logged_in?: boolean; msg?: string; opened?: boolean }
export type HistoryWindow = { id: number; time: string; n: number; model: string; summary: string }
export type HistoryMessage = {
  time: string
  region: string
  user: string
  text: string
  avatar: string | null
}

export const api = {
  loginStatus: () => req<{ logged_in: boolean }>('/login/status'),
  loginStart: () => req<LoginResult>('/login/start', post()),
  loginComplete: () => req<LoginResult>('/login/complete', post()),
  connect: (room_id: string) => req<ConnResult>('/connect', post({ room_id })),
  disconnect: () => req<ConnResult>('/disconnect', post()),
  saveConfig: (c: ConfigPayload) => req<ConfigResult>('/config', post(c)),
  getConfig: () => req<ConfigResult>('/config'),
  agentConfig: () => req<AgentConfig>('/agent'),
  saveAgentConfig: (c: AgentConfig) => req<AgentSaveResult>('/agent', post(c)),
  history: (limit = 60) => req<{ windows: HistoryWindow[] }>(`/history?limit=${limit}`),
  historyWindow: (id: number) => req<{ messages: HistoryMessage[] }>(`/history/${id}`),
}

export type { AiCard, MsgItem, Stat }
