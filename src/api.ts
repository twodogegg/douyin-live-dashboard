import type { AiCard, DmContact, DmAgent, DmMemory, DmConv, DmMsg, DmGroup, DmMedia, DmStat, FishConfig, FishVoice, VoiceAudio, MemoryProfile, MsgItem, Stat } from './types'

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
  dmContact: (id: string) => req<DmContact>(`/dm/contact/${encodeURIComponent(id)}`),
  dmSaveContact: (id: string, contact: DmContact) => req<{ ok: boolean; msg?: string; contact?: DmContact }>(`/dm/contact/${encodeURIComponent(id)}`, post(contact)),
  dmAddExample: (id: string, body: { source_key: string; original: string; reply: string; confirmed: boolean }) => req<{ ok: boolean; msg?: string; contact?: DmContact }>(`/dm/examples/${encodeURIComponent(id)}`, post(body)),
  dmDeleteExample: (id: string, example: number) => req<{ ok: boolean; msg?: string; contact?: DmContact }>(`/dm/examples/${encodeURIComponent(id)}?id=${example}`, { method: 'DELETE' }),
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
    req<{ ok: boolean; outcome?: 'confirmed' | 'failed' | 'unknown'; partial?: boolean; msg?: string }>('/dm/send', post({ conv_id, text })),
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
  dmSaveMemory: (id: string, patch: { summary?: string; profile?: MemoryProfile; clear?: boolean; expected_updated?: number }) =>
    req<{ ok: boolean; msg?: string }>(`/dm/memory/${encodeURIComponent(id)}`, post(patch)),
  dmBackfillTranscripts: (id: string) =>
    req<{ ok: boolean; total?: number; done?: number; failed?: number; msg?: string }>(`/dm/transcripts/${encodeURIComponent(id)}`, post()),
  dmRebuildProfile: (id: string) =>
    req<{ ok: boolean; msg?: string; memory?: DmMemory }>(`/dm/memory/${encodeURIComponent(id)}/rebuild`, post()),
  voiceConfig: () => req<FishConfig>('/dm/voice/config'),
  voiceSaveConfig: (c: FishConfig) => req<{ ok: boolean; msg?: string; config?: FishConfig }>('/dm/voice/config', post(c)),
  voiceList: (title: string, own: boolean, page: number, language: string) =>
    req<{ ok: boolean; msg?: string; items: FishVoice[]; has_more: boolean }>(`/dm/voice/models?${new URLSearchParams({ title, own: String(own), page: String(page), language })}`),
  voiceGet: (id: string) => req<{ ok: boolean; msg?: string; voice?: FishVoice }>(`/dm/voice/models/${encodeURIComponent(id)}`),
  voicePreview: (text: string, reference_id?: string, emotion?: string) =>
    req<VoiceAudio & { ok: boolean; msg?: string }>('/dm/voice/preview', post({ text, reference_id, emotion })),
  voiceDesign: (instruction: string, text: string) =>
    req<{ ok: boolean; msg?: string; candidates: VoiceAudio[] }>('/dm/voice/design', post({ instruction, text })),
  voiceCreate: (body: { name: string; candidate_id?: string; audio?: string; mime?: string; transcript?: string; consent?: boolean }) =>
    req<{ ok: boolean; msg?: string; voice?: FishVoice }>('/dm/voice/create', post(body)),
  voiceTranscribe: (key: string) => req<{ ok: boolean; msg?: string; text?: string }>('/dm/voice/transcribe', post({ key })),
  dmDump: () => req<{ url: string; title: string; tree: string }>('/dm/dump'),
}

export type { AiCard, MsgItem, Stat }
