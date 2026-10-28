// 直播间状态机：把「观众做了什么」映射成「主播进入什么状态、表演什么」。
//
// 状态只由事件驱动，不让模型自己决定——礼物要不要感谢、关注要不要欢迎，
// 必须在文案之外就可预测，否则一次模型抽风就能把直播节奏带跑。

export const STATES = {
  idle: { label: '聊天', priority: 0, hold_ms: 0 },
  arrival: { label: '迎客', priority: 5, hold_ms: 3000 },
  busy: { label: '回应中', priority: 8, hold_ms: 0 },
  backchannel: { label: '垫话', priority: 9, hold_ms: 0 },
  follow: { label: '新关注', priority: 15, hold_ms: 6000 },
  gifted: { label: '收礼', priority: 20, hold_ms: 6000 },
  spotlight: { label: '大礼物', priority: 40, hold_ms: 12000 },
}

// 低于该价值的礼物只走普通感谢，不进入聚光状态。
const SPOTLIGHT_VALUE = 1000

export function createStageState({ now = () => Date.now() } = {}) {
  let state = 'idle'
  let reason = ''
  let since = now()
  let until = 0
  let subject = null
  const listeners = new Set()

  const enter = (next, detail = {}) => {
    const def = STATES[next]
    if (!def) return state
    // 低优先级事件不打断高优先级的表演：收礼途中进来的观众不会抢掉感谢。
    if (detail.priority !== undefined && STATES[state].priority > detail.priority) return state
    const changed = state !== next || detail.reason !== reason
    state = next
    reason = detail.reason || ''
    subject = detail.subject || null
    if (changed || def.hold_ms) {
      since = now()
      until = def.hold_ms ? since + def.hold_ms : 0
    }
    if (changed) for (const fn of listeners) { try { fn(snapshot()) } catch { /* 监听器异常不影响状态 */ } }
    return state
  }

  const snapshot = () => ({ state, label: STATES[state]?.label || state, reason, subject: subject ? { ...subject } : null, since, until })

  return {
    snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    // 事件 → 状态。返回本次是否真的进入了新状态，调用方据此决定要不要生成感谢。
    applyEvent(event) {
      if (!event) return { entered: false, state }
      if (event.kind === 'gift') {
        const next = event.value >= SPOTLIGHT_VALUE ? 'spotlight' : 'gifted'
        enter(next, { reason: 'gift', subject: { user: event.user, gift: event.gift, count: event.count, value: event.value } })
        return { entered: true, state, priority: STATES[next].priority }
      }
      if (event.kind === 'follow') {
        enter('follow', { reason: 'follow', subject: { user: event.user } })
        return { entered: true, state, priority: STATES.follow.priority }
      }
      if (event.kind === 'join') {
        // 进房不抢夺正在进行的感谢或聚光，只作为低优先级状态短暂展示。
        if (STATES[state].priority > STATES.arrival.priority) return { entered: false, state }
        enter('arrival', { reason: 'join', subject: { user: event.user } })
        return { entered: true, state, priority: STATES.arrival.priority }
      }
      return { entered: false, state }
    },
    markBusy(kind = 'busy') { if (STATES[state].priority <= STATES.busy.priority) enter(kind, { reason: kind }) },
    // 表演结束回到聊天态；聚光/收礼的保持时间到期后也走这里。
    settle() {
      if (!until || now() < until) return state
      return enter('idle', { reason: '' })
    },
    reset() {
      state = 'idle'
      reason = ''
      subject = null
      since = now()
      until = 0
    },
  }
}
