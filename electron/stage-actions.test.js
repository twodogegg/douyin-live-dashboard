import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialStageActions, stageActionsReducer } from '../src/lib/stage-actions.ts'

const event = (id, kind) => ({ id, kind, user: '观众', gift: '', count: 1, value: 0, time: '' })
const sync = (state, events, options = {}) => stageActionsReducer(state, {
  type: 'sync', room: 'room-1', online: true, enabled: true, events, ...options,
})

test('历史事件不重播，新关注和礼物按顺序播放且状态更新不重复入队', () => {
  const old = event('old', 'gift')
  const follow = event('follow', 'follow')
  const gift = event('gift', 'gift')
  let state = sync(initialStageActions, [old])
  state = sync(state, [old, follow, gift])
  state = sync(state, [old, follow, gift])
  assert.deepEqual(state.queue.map(item => item.kind), ['follow', 'gift'])
  state = stageActionsReducer(state, { type: 'ended', id: 'follow' })
  assert.deepEqual(state.queue.map(item => item.id), ['gift'])
  assert.equal(stageActionsReducer(state, { type: 'ended', id: 'follow' }), state)
})

test('暂停、断线和切房清除旧动作，重新连接不会重播历史', () => {
  const follow = event('follow', 'follow')
  let state = sync(initialStageActions, [])
  state = sync(state, [follow])
  state = sync(state, [follow], { enabled: false })
  assert.equal(state.queue.length, 0)
  state = sync(state, [follow], { enabled: true })
  assert.equal(state.queue.length, 0)
  state = sync(state, [follow], { online: false })
  state = sync(state, [follow])
  assert.equal(state.queue.length, 0)
  state = sync(state, [follow, event('other', 'gift')], { room: 'room-2' })
  assert.equal(state.queue.length, 0)
  state = sync(state, [follow, event('other', 'gift'), event('new', 'gift')], { room: 'room-2' })
  assert.equal(state.queue[0]?.id, 'new')
})

test('未连接时也可预览，普通进房不会触发动作', () => {
  let state = sync(initialStageActions, [])
  state = sync(state, [event('join', 'join')])
  assert.equal(state.queue.length, 0)
  state = stageActionsReducer(state, { type: 'preview', action: { id: 'preview-1', kind: 'gift', preview: true } })
  state = sync(state, [], { online: false })
  assert.equal(state.queue[0]?.id, 'preview-1')
})
