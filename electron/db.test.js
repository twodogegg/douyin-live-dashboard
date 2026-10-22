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
