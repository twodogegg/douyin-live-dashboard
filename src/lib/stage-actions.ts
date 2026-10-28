import type { StageActivityEvent } from '../types'

export type StageActionKind = 'follow' | 'gift'
export type StageAction = { id: string; kind: StageActionKind; preview: boolean; user?: string; gift?: string; count?: number }
export type StageActionState = { room: string; synced: boolean; seen: string[]; queue: StageAction[] }

type Change =
  | { type: 'sync'; room: string; online: boolean; enabled: boolean; events: StageActivityEvent[] }
  | { type: 'preview'; action: StageAction }
  | { type: 'ended'; id: string }

export const initialStageActions: StageActionState = { room: '', synced: false, seen: [], queue: [] }

export function stageActionsReducer(state: StageActionState, change: Change): StageActionState {
  if (change.type === 'preview') return { ...state, queue: [...state.queue, change.action].slice(0, 20) }
  if (change.type === 'ended') return state.queue[0]?.id === change.id ? { ...state, queue: state.queue.slice(1) } : state

  const preview = state.queue.filter(action => action.preview)
  if (!change.online) return { room: '', synced: false, seen: [], queue: preview }

  const seen = change.events.map(event => event.id)
  if (!state.synced || state.room !== change.room) return { room: change.room, synced: true, seen, queue: preview }

  const known = new Set(state.seen)
  const fresh: StageAction[] = []
  for (const event of change.events) {
    if (known.has(event.id)) continue
    known.add(event.id)
    if (change.enabled && change.room && (event.kind === 'follow' || event.kind === 'gift')) {
      fresh.push({ id: event.id, kind: event.kind, preview: false, user: event.user, gift: event.gift, count: event.count })
    }
  }
  return { ...state, seen, queue: change.enabled ? [...state.queue, ...fresh].slice(0, 20) : preview }
}
