import type { AiCard, DmAgent, DmMemory, DmConv, DmMsg, DmGroup, DmMedia, DmStat, MsgItem, Stat } from './types'

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
  loginSave: () => req<LoginResult>('/login/save', post()),
  loginClear: () => req<LoginResult>('/login/clear', post()),
  connect: (room_id: string) => req<ConnResult>('/connect', post({ room_id })),
  disconnect: () => req<ConnResult>('/disconnect', post()),
  saveConfig: (c: ConfigPayload) => req<ConfigResult>('/config', post(c)),
  getConfig: () => req<ConfigResult>('/config'),
  agentConfig: () => req<AgentConfig>('/agent'),
  saveAgentConfig: (c: AgentConfig) => req<AgentSaveResult>('/agent', post(c)),
  history: (limit = 60) => req<{ windows: HistoryWindow[] }>(`/history?limit=${limit}`),
  historyWindow: (id: number) => req<{ messages: HistoryMessage[] }>(`/history/${id}`),
  showLiveWindow: () => req<{ ok: boolean; visible?: boolean }>('/window/show', post()),

  // ---- 私信 ----
  dmStatus: () => req<DmStat>('/dm/status'),
  dmStart: () => req<DmStat & { ok?: boolean }>('/dm/start', post()),
  dmStop: () => req<DmStat & { ok?: boolean }>('/dm/stop', post()),
  dmOpen: () => req<{ ok: boolean }>('/dm/open', post()),
  dmSync: () => req<DmStat & { ok?: boolean }>('/dm/sync', post()),
  dmConvs: (limit = 80) =>
    req<{ conversations: DmConv[] }>(`/dm/conversations?limit=${limit}`),
  dmSelect: (conv_id: string) =>
    req<{ ok: boolean; msg?: string; active_id?: string }>('/dm/select', post({ conv_id })),
  dmMsgs: (convId: string, limit = 200) =>
    req<{ messages: DmMsg[] }>(`/dm/messages/${encodeURIComponent(convId)}?limit=${limit}`),
  dmDraft: (conv_id: string) =>
    req<{ ok: boolean; text?: string; msg?: string }>('/dm/draft', post({ conv_id })),
  dmSend: (conv_id: string, text: string) =>
    req<{ ok: boolean; msg?: string }>('/dm/send', post({ conv_id, text })),
  dmAttach: (conv_id: string) =>
    req<{ ok: boolean; count?: number; canceled?: boolean; msg?: string }>('/dm/attach', post({ conv_id })),
  dmGroup: (conv_id: string) => req<DmGroup>('/dm/group', post({ conv_id })),
  dmMember: (conv_id: string, member_id: string) =>
    req<{
      ok: boolean
      name?: string
      chatting?: boolean
      active_id?: string
      limited?: boolean
      needFollow?: boolean
      followText?: string
      msg?: string
    }>('/dm/member', post({ conv_id, member_id })),
  dmFollow: (conv_id: string, member_id: string) =>
    req<{ ok: boolean; already?: boolean; after?: string; msg?: string }>('/dm/member-follow', post({ conv_id, member_id })),
  dmMedia: (key: string, refresh = false) => req<DmMedia>('/dm/media/resolve', post({ key, refresh })),
  dmMediaOpen: (key: string) => req<{ ok: boolean; msg?: string }>('/dm/media/open', post({ key })),
  dmAgent: () => req<DmAgent>('/dm/agent'),
  dmSaveAgent: (c: DmAgent) =>
    req<{ ok: boolean; msg?: string }>('/dm/agent', post(c)),
  dmBlock: (conv_id: string, blocked: boolean) => req<{ ok: boolean; msg?: string }>('/dm/block', post({ conv_id, blocked })),
  dmMemory: (id: string) => req<DmMemory>(`/dm/memory/${encodeURIComponent(id)}`),
  dmDump: () => req<{ url: string; title: string; tree: string }>('/dm/dump'),
}

export type { AiCard, MsgItem, Stat }
