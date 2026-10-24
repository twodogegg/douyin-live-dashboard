import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as db from './db.js'

afterEach(() => db.closeDb())

const message = (overrides = {}) => ({
  key: 'group:m:1', conv_id: 'group', direction: 'in', kind: 'text', text: '你好',
  thumb: '', author: '', ts: 1, time: '00:00:01', source_id: '1', sender_id: 'user-a',
  sender_name: '甲', sender_avatar: '', sender_sec_uid: '', aweme_id: '', video_url: '', media_url: '',
  ...overrides,
})

test('旧数据库补列时保留已有消息', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-db-'))
  const file = path.join(dir, 'old.db')
  const old = new Database(file)
  old.exec("CREATE TABLE dm_messages(key TEXT PRIMARY KEY, conv_id TEXT, direction TEXT, text TEXT, ts REAL, time TEXT); INSERT INTO dm_messages VALUES('old','group','in','历史消息',1,'00:00:01')")
  old.close()
  try {
    db.initDb(file)
    assert.equal(db.dmGetMsg('old').text, '历史消息')
    assert.equal(db.dmGetMsg('old').sender_id, '')
  } finally {
    db.closeDb()
    fs.rmSync(dir, { recursive: true })
  }
})

test('会话更换真实 ID 后，旧消息继续归属该会话并可补齐身份', () => {
  db.initDb(':memory:')
  db.dmUpsertConv({ id: 'legacy', name: '群聊' })
  db.dmSaveMsg(message({ key: 'legacy:in:hash:1', conv_id: 'legacy', source_id: '', sender_id: '', sender_name: '' }))
  db.dmMigrateConv('legacy', 'group')
  const saved = db.dmSaveMsg(message(), 'in:hash:1')
  assert.equal(saved.inserted, false)
  assert.equal(db.dmListMsgs('group').length, 1)
  assert.equal(db.dmGetMsg('group:m:1').sender_name, '甲')
  assert.equal(db.dmGetMsg('legacy:in:hash:1').source_id, '1')
  assert.equal(db.dmGetConv('legacy'), undefined)
})

test('图片数组往返存储，旧卡片按资源 ID 找回媒体且不混淆两个作品', () => {
  db.initDb(':memory:')
  const original = 'https://p3-sign.douyinpic.com/obj/tos-cn-o-00061/photo~tplv-x-get:.image?sign=a'
  db.dmSaveMsg(message({ kind: 'image', thumb: 'https://p3.douyinpic.com/img/asset~thumb.webp?sign=a', media_url: original, images: [original] }))
  const legacy = message({ key: 'legacy:in:old:1', source_id: '', kind: 'image', thumb: 'https://p9.douyinpic.com/asset~large.webp?sign=b' })
  db.dmSaveMsg(legacy)
  assert.deepEqual(db.dmGetMsg('group:m:1').images, [original])
  assert.deepEqual(db.dmFindMedia(legacy).images, [original])
  db.dmSaveMsg(message({ key: 'group:m:2', source_id: '2', kind: 'video', thumb: legacy.thumb, aweme_id: 'different-work' }))
  assert.equal(db.dmFindMedia(legacy), null)
})

test('不同成员的相同文本不会被合并，重复扫描真实消息不会重复入库', () => {
  db.initDb(':memory:')
  const first = message()
  const second = message({ key: 'group:m:2', source_id: '2', sender_id: 'user-b', sender_name: '乙' })
  db.dmSaveMsg(first)
  db.dmSaveMsg(second)
  assert.equal(db.dmSaveMsg(first), null)
  assert.deepEqual(db.dmListMsgs('group').map(m => m.sender_id).sort(), ['user-a', 'user-b'])
})

test('封面签名变化时补齐旧视频，已有真实消息时清除同一份旧卡片', () => {
  db.initDb(':memory:')
  const video = message({ kind: 'video', text: '分享视频', thumb: 'https://p9.douyinpic.com/cover.jpg?sign=new', aweme_id: '123' })
  const legacy = message({ key: 'old:in:oldhash:1', kind: 'video', text: '分享视频', thumb: 'https://p3.douyinpic.com/cover.jpg?sign=old', source_id: '', sender_id: '', sender_name: '' })
  db.dmSaveMsg(legacy)
  assert.equal(db.dmSaveMsg(video, 'in:newhash:1').inserted, false)
  assert.equal(db.dmListMsgs('group').length, 1)
  assert.equal(db.dmGetMsg(video.key).aweme_id, '123')
  db.dmSaveMsg(legacy)
  assert.equal(db.dmSaveMsg(video, 'in:newhash:1').old_key, legacy.key)
  assert.equal(db.dmListMsgs('group').length, 1)
})

test('会话记忆、名单与回复时间独立保存，ID 迁移保留记忆且扫描不覆盖名单', () => {
  db.initDb(':memory:')
  db.dmUpsertConv({ id: 'legacy', name: '同名' })
  db.dmUpsertConv({ id: 'b', name: '同名' })
  db.dmSaveMemory('legacy', { summary: '喜欢茶', blocked: 1, summary_cursor: 3, last_reply_at: 1000 })
  db.dmSaveMemory('b', { summary: '喜欢咖啡' })
  db.dmMigrateConv('legacy', 'a')
  db.dmUpsertConv({ id: 'a', name: '新名字' })
  assert.equal(db.dmGetMemory('a').summary, '喜欢茶')
  assert.equal(db.dmGetMemory('a').last_reply_at, 1000)
  assert.equal(db.dmGetMemory('b').summary, '喜欢咖啡')
  assert.equal(db.dmListConvs().find(c => c.id === 'a').auto_reply_blocked, 1)
  assert.equal(db.dmGetMemory('b').blocked, 0)
})

test('语音转写不会被后续扫描清空；画像迁移及清空仅影响当前用户', () => {
  db.initDb(':memory:')
  db.dmUpsertConv({ id: 'legacy', name: '同名' })
  db.dmUpsertConv({ id: 'b', name: '同名' })
  db.dmSaveMsg(message({ key: 'voice', conv_id: 'legacy', kind: 'audio', text: '[语音]', transcript: '喜欢温柔的人' }))
  db.dmSaveMsg(message({ key: 'voice', conv_id: 'legacy', kind: 'audio', text: '[语音]', transcript: '' }))
  assert.equal(db.dmGetMsg('voice').transcript, '喜欢温柔的人')
  const profile = JSON.stringify({ facts: [], preferences: [{ text: '温柔' }], inferences: [] })
  db.dmSaveMemory('legacy', { profile, summary: '甲的记忆' })
  db.dmSaveMemory('b', { profile: '乙的画像', summary: '乙的记忆' })
  db.dmMigrateConv('legacy', 'a')
  assert.equal(db.dmGetMemory('a').profile, profile)
  db.dmEditMemory('a', { clear: true })
  assert.equal(db.dmGetMemory('a').profile, '')
  assert.equal(db.dmGetMemory('a').summary, '')
  assert.equal(db.dmMemoryBatch('a', db.dmGetMemory('a').summary_cursor).length, 0)
  assert.equal(db.dmGetMemory('b').profile, '乙的画像')
  assert.equal(db.dmGetMsg('voice').transcript, '喜欢温柔的人')
})

test('摘要增量按入库游标读取，后加载的较早历史也不会漏掉', () => {
  db.initDb(':memory:')
  db.dmSaveMsg(message({ key: 'new', source_id: 'new', ts: 100 }))
  const first = db.dmMemoryBatch('group', 0)
  db.dmSaveMemory('group', { summary_cursor: first.at(-1).seq })
  db.dmSaveMsg(message({ key: 'old', source_id: 'old', ts: 1 }))
  db.dmSaveMsg(message({ key: 'other', conv_id: 'other', source_id: 'other' }))
  assert.deepEqual(db.dmMemoryBatch('group', db.dmGetMemory('group').summary_cursor).map(m => m.key), ['old'])
  assert.deepEqual(db.dmPendingMemories().map(m => m.conv_id).sort(), ['group', 'other'])
})

test('重启后保留摘要、过滤名单与频率时间，并恢复未总结的会话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-memory-'))
  const file = path.join(dir, 'data.db')
  try {
    db.initDb(file)
    db.dmSaveMsg(message())
    db.dmSaveMemory('group', { blocked: 1, summary: '已约定明天联系', last_reply_at: 2000, send_outcome: 'pending' })
    db.closeDb()
    db.initDb(file)
    assert.equal(db.dmGetMemory('group').summary, '已约定明天联系')
    assert.equal(db.dmGetMemory('group').blocked, 1)
    assert.equal(db.dmGetMemory('group').last_reply_at, 2000)
    assert.equal(db.dmGetMemory('group').send_outcome, 'unknown')
    assert.deepEqual(db.dmPendingMemories(), [{ conv_id: 'group' }])
  } finally {
    db.closeDb()
    fs.rmSync(dir, { recursive: true })
  }
})

test('首次账号归属迁移保留消息记忆和名单，后续账号不共享联系人与样例', () => {
  db.initDb(':memory:')
  db.dmUpsertConv({ id: 'legacy', name: '联系人' })
  db.dmSaveMsg(message({ key: 'legacy:m:1', conv_id: 'legacy' }))
  db.dmSaveMemory('legacy', { blocked: 1, summary: '原有记忆', handled_key: 'legacy:m:1' })
  db.dmUseAccount('100')
  const id = 'douyin:100:legacy'
  assert.equal(db.dmListConvs()[0].id, id)
  assert.equal(db.dmGetMemory(id).summary, '原有记忆')
  assert.equal(db.dmGetMemory(id).blocked, 1)
  assert.equal(db.dmGetMsg('legacy:m:1').conv_id, id)
  db.dmSaveContact(id, { relationship: '朋友', address: '小林', tone: '自然', boundaries: '' })
  assert.throws(() => db.dmAddExample(id, { source_key: 'legacy:m:1', original: '原稿', reply: '改写', confirmed: false }))
  assert.throws(() => db.dmAddExample(id, { source_key: 'legacy:m:1', original: '原稿', reply: '原稿', confirmed: true }))
  db.dmAddExample(id, { source_key: 'legacy:m:1', original: '原稿', reply: '人工改写', confirmed: true })
  db.dmUseAccount('200')
  assert.equal(db.dmListConvs().length, 0)
  assert.equal(db.dmGetMsg('legacy:m:1'), undefined)
  assert.throws(() => db.dmContact(id))
  assert.throws(() => db.dmGetMemory(id))
  assert.throws(() => db.dmSaveMsg(message({ conv_id: id })))
  db.dmUpsertConv({ id: 'douyin:200:legacy', name: '联系人' })
  assert.deepEqual(db.dmContact('douyin:200:legacy').examples, [])
  db.dmUseAccount('100')
  assert.equal(db.dmContact(id).relationship, '朋友')
  assert.equal(db.dmContact(id).examples[0].reply, '人工改写')
})

test('协议和浏览器使用同一真实 ID 去重，并保留已解密的媒体', () => {
  db.initDb(':memory:')
  const browser = message({ kind: 'image', images: ['https://example.com/original.png'], sender_name: '甲', media_url: 'https://example.com/original.png' })
  const protocol = message({ key: 'protocol:1', kind: 'image', text: '[图片]', sender_name: '', media_url: '', media_ref: '{"encrypted":true}' })
  assert.equal(db.dmSaveMsg(browser).inserted, true)
  assert.equal(db.dmSaveMsg(protocol).inserted, false)
  assert.equal(db.dmListMsgs('group').length, 1)
  assert.equal(db.dmGetMsg(protocol.key).sender_name, '甲')
  assert.deepEqual(db.dmGetMsg(protocol.key).images, browser.images)
  assert.equal(db.dmGetMsg(browser.key).media_ref, protocol.media_ref)
  db.dmSaveMsg(message({ key: 'second', source_id: '2', text: protocol.text }))
  assert.equal(db.dmListMsgs('group').length, 2)
})

test('未确认发送持久化，只有新的自己发出的消息能核对成功', () => {
  db.initDb(':memory:')
  db.dmSaveMemory('group', { send_outcome: 'unknown', send_text: '收到', send_started: 10000 })
  db.dmReconcileSend(message({ text: '收到', direction: 'in', ts: 11 }))
  db.dmReconcileSend(message({ text: '收到', direction: 'out', ts: 1 }))
  db.dmReconcileSend(message({ text: '别的内容', direction: 'out', ts: 11 }))
  assert.equal(db.dmGetMemory('group').send_outcome, 'unknown')
  db.dmReconcileSend(message({ text: '收到', direction: 'out', ts: 11 }))
  assert.equal(db.dmGetMemory('group').send_outcome, 'confirmed')
})

test('已成功发出的首段自动解除不确定状态，原有同文消息不能充当本次回执', () => {
  db.initDb(':memory:')
  db.dmSaveMemory('group', { send_outcome: 'unknown', send_text: '第一段\n\n第二段', send_started: 10000, send_before_ids: '["old"]' })
  assert.equal(db.dmReconcileSend(message({ source_id: 'old', direction: 'out', text: '第一段', ts: 10.1 })), undefined)
  assert.equal(db.dmGetMemory('group').send_outcome, 'unknown')
  const saved = db.dmReconcileSend(message({ source_id: 'new', direction: 'out', text: '第一段', ts: 10.8 }))
  assert.equal(saved.send_outcome, 'confirmed')
  assert.equal(saved.send_partial, 1)
  assert.equal(saved.send_receipt_id, 'new')
  assert.equal(saved.send_text, '')
})

test('历史分段按旧到新读取，可跨游标重扫全部消息', () => {
  db.initDb(':memory:')
  const conv = 'rebuild'
  db.dmUpsertConv({ id: conv, name: '重扫' })
  db.dmSaveMsg({ key: conv + ':m:1', conv_id: conv, direction: 'in', kind: 'text', text: '第一条', ts: 1 })
  db.dmSaveMsg({ key: conv + ':m:2', conv_id: conv, direction: 'out', kind: 'text', text: '第二条', ts: 2 })
  db.dmSaveMsg({ key: conv + ':m:3', conv_id: conv, direction: 'in', kind: 'text', text: '第三条', ts: 3 })
  db.dmSaveMemory(conv, { summary_cursor: db.dmCountMsgs(conv) })
  const chunk = db.dmHistoryChunk(conv, 0, 2)
  assert.deepEqual(chunk.map(m => m.text), ['第二条', '第三条'])
  const older = db.dmHistoryChunk(conv, chunk[0].seq, 2)
  assert.deepEqual(older.map(m => m.text), ['第一条'])
  assert.equal(db.dmHistoryChunk(conv, older[0].seq, 2).length, 0)
})
