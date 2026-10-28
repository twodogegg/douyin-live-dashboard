import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStageState, STATES } from './stage-state.js'

function fixture() {
  let now = 1000
  const state = createStageState({ now: () => now })
  return { state, advance: ms => { now += ms } }
}

test('礼物与关注进入对应状态，并记录触发主体', () => {
  const { state } = fixture()
  const gift = state.applyEvent({ kind: 'gift', user: '海盐', gift: '小心心', count: 5, value: 5 })
  assert.equal(gift.entered, true)
  assert.equal(gift.state, 'gifted')
  assert.deepEqual(state.snapshot().subject, { user: '海盐', gift: '小心心', count: 5, value: 5 })

  const follow = state.applyEvent({ kind: 'follow', user: '小鹿' })
  assert.equal(follow.state, 'follow')
  assert.equal(state.snapshot().subject.user, '小鹿')
})

test('大礼物进入聚光状态，普通礼物只进入收礼状态', () => {
  const { state } = fixture()
  assert.equal(state.applyEvent({ kind: 'gift', user: '甲', gift: '小心心', count: 1, value: 1 }).state, 'gifted')
  const { state: second } = fixture()
  assert.equal(second.applyEvent({ kind: 'gift', user: '乙', gift: '嘉年华', count: 1, value: 30000 }).state, 'spotlight')
})

test('进房不打断正在进行的高优先级表演', () => {
  const { state } = fixture()
  state.applyEvent({ kind: 'gift', user: '甲', gift: '嘉年华', count: 1, value: 30000 })
  assert.equal(state.snapshot().state, 'spotlight')
  const join = state.applyEvent({ kind: 'join', user: '路人' })
  assert.equal(join.entered, false)
  assert.equal(state.snapshot().state, 'spotlight')
})

test('表演保持时间到期后回到聊天状态', () => {
  const { state, advance } = fixture()
  state.applyEvent({ kind: 'gift', user: '甲', gift: '小心心', count: 1, value: 1 })
  assert.equal(state.snapshot().state, 'gifted')
  assert.equal(STATES.gifted.hold_ms, 6000)
  advance(3000)
  assert.equal(state.settle(), 'gifted', '未到期不会提前退出')
  advance(4000)
  assert.equal(state.settle(), 'idle')
})

test('订阅者能收到状态变化，reset 清空表演主体', () => {
  const { state } = fixture()
  const seen = []
  other: {
    const unsubscribe = state.subscribe(snapshot => seen.push(snapshot.state))
    state.applyEvent({ kind: 'follow', user: '小鹿' })
    unsubscribe()
  }
  assert.deepEqual(seen, ['follow'])
  state.reset()
  assert.equal(state.snapshot().state, 'idle')
  assert.equal(state.snapshot().subject, null)
})
