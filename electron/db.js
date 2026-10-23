// 消息与 AI 摘要落 SQLite，看板刷新/重启后仍可回看历史。
import Database from 'better-sqlite3'
import { deliveryContent } from './dm-delivery.js'
import { mediaIdentity } from './media-data.js'

let db = null
let accountPrefix = null
const inAccount = id => accountPrefix === null || String(id).startsWith(accountPrefix)

export function initDb(file) {
  accountPrefix = null
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS messages(' +
      '  key TEXT PRIMARY KEY, ts REAL, time TEXT, region TEXT,' +
      '  user TEXT, text TEXT, avatar TEXT, window_id INTEGER)',
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_window ON messages(window_id)')
  db.exec(
    'CREATE TABLE IF NOT EXISTS windows(' +
      '  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, time TEXT,' +
      '  n INTEGER, model TEXT, summary TEXT)',
  )
  // 私信：会话 / 消息 / 草稿
  db.exec(
    'CREATE TABLE IF NOT EXISTS dm_conversations(' +
      '  id TEXT PRIMARY KEY, name TEXT, avatar TEXT, preview TEXT,' +
      '  last_ts REAL, last_time TEXT, unread INTEGER DEFAULT 0, updated REAL)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS dm_messages(' +
      '  key TEXT PRIMARY KEY, conv_id TEXT, direction TEXT, text TEXT,' +
      '  ts REAL, time TEXT)',
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_dm_msg_conv ON dm_messages(conv_id, ts)')
  db.exec('CREATE TABLE IF NOT EXISTS dm_message_aliases(alias TEXT PRIMARY KEY, message_key TEXT NOT NULL)')
  db.exec(`CREATE TABLE IF NOT EXISTS dm_memory(
    conv_id TEXT PRIMARY KEY, blocked INTEGER DEFAULT 0, summary TEXT DEFAULT '',
    summary_cursor INTEGER DEFAULT 0, updated REAL DEFAULT 0,
    handled_key TEXT DEFAULT '', last_reply_at REAL DEFAULT 0)`)
  if (!db.prepare('PRAGMA table_info(dm_memory)').all().some(c => c.name === 'profile')) db.exec("ALTER TABLE dm_memory ADD COLUMN profile TEXT DEFAULT ''")
  for (const [name, type] of [['send_outcome', "TEXT DEFAULT ''"], ['send_text', "TEXT DEFAULT ''"], ['send_started', 'REAL DEFAULT 0'], ['send_before_ids', "TEXT DEFAULT '[]'"], ['send_partial', 'INTEGER DEFAULT 0'], ['send_receipt_id', "TEXT DEFAULT ''"]]) {
    if (!db.prepare('PRAGMA table_info(dm_memory)').all().some(c => c.name === name)) db.exec(`ALTER TABLE dm_memory ADD COLUMN ${name} ${type}`)
  }
  db.prepare("UPDATE dm_memory SET send_outcome='unknown' WHERE send_outcome='pending'").run()
  // 补列保留历史；重新采集到的消息会补齐身份与媒体信息。
  const cols = db.prepare('PRAGMA table_info(dm_messages)').all().map((c) => c.name)
  for (const col of ['kind', 'thumb', 'author', 'source_id', 'sender_id', 'sender_name', 'sender_avatar', 'sender_sec_uid', 'aweme_id', 'video_url', 'media_url', 'images', 'transcript', 'platform', 'account_id', 'media_ref']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE dm_messages ADD COLUMN ${col} TEXT DEFAULT ''`)
  }
  const convCols = db.prepare('PRAGMA table_info(dm_conversations)').all().map((c) => c.name)
  for (const col of ['is_group', 'peer_sec_uid']) {
    if (!convCols.includes(col)) db.exec(`ALTER TABLE dm_conversations ADD COLUMN ${col} ${col === 'is_group' ? 'INTEGER DEFAULT 0' : "TEXT DEFAULT ''"}`)
  }
  db.exec("CREATE TABLE IF NOT EXISTS dm_meta(key TEXT PRIMARY KEY, value TEXT)")
  db.exec("CREATE TABLE IF NOT EXISTS dm_contacts(conv_id TEXT PRIMARY KEY, relationship TEXT DEFAULT '', address TEXT DEFAULT '', tone TEXT DEFAULT '', boundaries TEXT DEFAULT '', updated REAL DEFAULT 0)")
  db.exec("CREATE TABLE IF NOT EXISTS dm_examples(id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL, source_key TEXT NOT NULL, original TEXT NOT NULL, reply TEXT NOT NULL, created REAL NOT NULL)")
  return db
}

export function upsertMsg(key, now, region, user, text, avatar) {
  const stamp = new Date().toTimeString().slice(0, 8)
  db.prepare(
    'INSERT INTO messages(key, ts, time, region, user, text, avatar) VALUES(?,?,?,?,?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET text=excluded.text, avatar=excluded.avatar',
  ).run(key, now, stamp, region, user, text, avatar || null)
}

/** 开一个分析窗口，并只把本窗口实际缓冲的消息划进来。 */
export function openWindow(now, stamp, n, model, keys) {
  const info = db.prepare('INSERT INTO windows(ts, time, n, model, summary) VALUES(?,?,?,?,?)').run(now, stamp, n, model, '')
  const wid = Number(info.lastInsertRowid)
  if (keys && keys.length) {
    const upd = db.prepare('UPDATE messages SET window_id=? WHERE key=? AND window_id IS NULL')
    db.transaction(() => keys.forEach((k) => upd.run(wid, k)))()
  } else {
    db.prepare('UPDATE messages SET window_id=? WHERE window_id IS NULL AND ts<=?').run(wid, now)
  }
  return wid
}

export function closeWindow(wid, summary) {
  db.prepare('UPDATE windows SET summary=? WHERE id=?').run(summary, wid)
}

export function history(limit = 60) {
  return db
    .prepare('SELECT id, time, n, model, summary FROM windows ORDER BY id DESC LIMIT ?')
    .all(limit)
}

export function windowMessages(wid) {
  return db
    .prepare('SELECT time, region, user, text, avatar FROM messages WHERE window_id=? ORDER BY ts')
    .all(wid)
}

// ---------- 私信 ----------
export function dmUpsertConv(c) {
  if (!inAccount(c.id)) throw new Error('会话不属于当前账号')
  db.prepare(
    'INSERT INTO dm_conversations(id, name, avatar, preview, last_ts, last_time, unread, updated, is_group, peer_sec_uid)' +
      ' VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET' +
      ' name=excluded.name, avatar=excluded.avatar,' +
      ' preview=CASE WHEN excluded.last_ts >= dm_conversations.last_ts THEN excluded.preview ELSE dm_conversations.preview END,' +
      ' last_ts=MAX(dm_conversations.last_ts, excluded.last_ts),' +
      ' last_time=CASE WHEN excluded.last_ts >= dm_conversations.last_ts THEN excluded.last_time ELSE dm_conversations.last_time END,' +
      ' unread=excluded.unread, updated=excluded.updated, is_group=excluded.is_group, peer_sec_uid=excluded.peer_sec_uid',
  ).run(
    c.id,
    c.name || '',
    c.avatar || null,
    c.preview || '',
    c.last_ts || 0,
    c.last_time || '',
    c.unread || 0,
    Date.now() / 1000,
    c.is_group ? 1 : 0,
    c.peer_sec_uid || '',
  )
}

export function dmGetConv(id) {
  return inAccount(id) ? db.prepare('SELECT * FROM dm_conversations WHERE id=?').get(id) : undefined
}

export function dmListConvs(limit = 80) {
  return db
    .prepare('SELECT c.*, COALESCE(m.blocked,0) AS auto_reply_blocked FROM dm_conversations c LEFT JOIN dm_memory m ON m.conv_id=c.id WHERE (? IS NULL OR substr(c.id,1,length(?))=?) ORDER BY c.last_ts DESC LIMIT ?')
    .all(accountPrefix, accountPrefix, accountPrefix, limit)
}

export function dmMigrateConv(oldId, id) {
  if (!oldId || oldId === id || !dmGetConv(oldId)) return
  db.transaction(() => {
    const old = dmGetConv(oldId)
    if (!dmGetConv(id)) dmUpsertConv({ ...old, id })
    db.prepare('UPDATE dm_messages SET conv_id=? WHERE conv_id=?').run(id, oldId)
    const oldMemory = dmGetMemory(oldId)
    const current = dmGetMemory(id)
    dmSaveMemory(id, {
      blocked: oldMemory.blocked || current.blocked,
      summary: current.summary || oldMemory.summary,
      profile: current.profile || oldMemory.profile,
      summary_cursor: current.summary ? current.summary_cursor : oldMemory.summary_cursor,
      updated: current.summary ? current.updated : oldMemory.updated,
      handled_key: current.last_reply_at > oldMemory.last_reply_at ? current.handled_key : oldMemory.handled_key || current.handled_key,
      last_reply_at: Math.max(current.last_reply_at, oldMemory.last_reply_at),
    })
    for (const table of ['dm_contacts', 'dm_examples']) db.prepare(`UPDATE OR IGNORE ${table} SET conv_id=? WHERE conv_id=?`).run(id, oldId)
    db.prepare('DELETE FROM dm_memory WHERE conv_id=?').run(oldId)
    db.prepare('DELETE FROM dm_conversations WHERE id=?').run(oldId)
  })()
}

const DM_FIELDS = ['key', 'conv_id', 'direction', 'kind', 'text', 'thumb', 'author', 'ts', 'time',
  'source_id', 'sender_id', 'sender_name', 'sender_avatar', 'sender_sec_uid', 'aweme_id', 'video_url', 'media_url', 'images', 'transcript', 'platform', 'account_id', 'media_ref']

function readMsg(row) {
  if (!row) return row
  try { row.images = JSON.parse(row.images || '[]') } catch { row.images = [] }
  return row
}

const fieldValue = (key, message) => key === 'images' ? JSON.stringify(message.images || []) : message[key] ?? ''

export function dmGetMsg(key) {
  const row = db.prepare('SELECT * FROM dm_messages WHERE key=?').get(key)
    || db.prepare('SELECT m.* FROM dm_messages m JOIN dm_message_aliases a ON a.message_key=m.key WHERE a.alias=?').get(key)
  return row && inAccount(row.conv_id) ? readMsg(row) : undefined
}

export function dmFindMedia(message) {
  const identity = mediaIdentity(message.thumb)
  if (!identity) return null
  const matches = db.prepare("SELECT * FROM dm_messages WHERE conv_id=? AND key<>? AND (COALESCE(aweme_id,'')<>'' OR COALESCE(media_url,'')<>'')")
    .all(message.conv_id, message.key).filter(m => mediaIdentity(m.thumb) === identity)
  const assets = new Set(matches.map(m => m.aweme_id || mediaIdentity(m.media_url)))
  return assets.size === 1 ? readMsg(matches[0]) : null
}

export function dmSaveMsg(m, legacyKey = '') {
  if (!inAccount(m.conv_id)) throw new Error('消息不属于当前账号')
  return db.transaction(() => saveMsg(m, legacyKey))()
}

function saveMsg(m, legacyKey) {
  let old = dmGetMsg(m.key)
    || (m.source_id && db.prepare('SELECT * FROM dm_messages WHERE conv_id=? AND source_id=?').get(m.conv_id, m.source_id))
  let legacy = m.source_id && legacyKey && db.prepare("SELECT * FROM dm_messages WHERE conv_id=? AND key LIKE ? AND COALESCE(source_id,'')='' ").get(m.conv_id, '%:' + legacyKey)
  // 旧卡片的签名参数每次打开都会变化；仅在封面主体和出现次序唯一匹配时补齐旧记录。
  if (!legacy && m.source_id && m.thumb && legacyKey) {
    const occurrence = legacyKey.split(':').at(-1)
    const candidates = db.prepare("SELECT * FROM dm_messages WHERE conv_id=? AND direction=? AND kind=? AND text=? AND author=? AND COALESCE(source_id,'')='' ")
      .all(m.conv_id, m.direction, m.kind, m.text, m.author)
      .filter(row => mediaIdentity(row.thumb) && mediaIdentity(row.thumb) === mediaIdentity(m.thumb) && row.key.endsWith(':' + occurrence))
    if (candidates.length === 1) legacy = candidates[0]
  }
  let removed = ''
  if (old && legacy && old.key !== legacy.key) {
    db.prepare('DELETE FROM dm_messages WHERE key=?').run(legacy.key)
    removed = legacy.key
  }
  old ||= legacy
  if (old && typeof old.images === 'string') readMsg(old)
  if (old) {
    m = { ...m }
    for (const k of ['sender_name', 'sender_avatar', 'sender_sec_uid', 'thumb', 'author', 'aweme_id', 'video_url', 'media_url', 'transcript', 'platform', 'account_id', 'media_ref']) m[k] ||= old[k] || ''
    if (!m.images?.length) m.images = old.images || []
  }
  if (m.kind === 'audio') m = { ...m, transcript: m.transcript || old?.transcript || '' }
  if (old && typeof old.images === 'string') readMsg(old)
  if (old && !removed && DM_FIELDS.every(k => fieldValue(k, old) === fieldValue(k, m))) return null
  if (old) {
    db.prepare(`UPDATE dm_messages SET ${DM_FIELDS.map(k => `${k}=?`).join(',')} WHERE key=?`)
      .run(...DM_FIELDS.map(k => fieldValue(k, m)), old.key)
    for (const alias of new Set([removed, old.key].filter(k => k && k !== m.key))) {
      db.prepare('UPDATE dm_message_aliases SET message_key=? WHERE message_key=?').run(m.key, alias)
      db.prepare('INSERT OR REPLACE INTO dm_message_aliases(alias,message_key) VALUES(?,?)').run(alias, m.key)
    }
    return { inserted: false, old_key: removed || old.key }
  }
  db.prepare(`INSERT INTO dm_messages(${DM_FIELDS.join(',')}) VALUES(${DM_FIELDS.map(() => '?').join(',')})`)
    .run(...DM_FIELDS.map(k => fieldValue(k, m)))
  return { inserted: true }
}

export function dmListMsgs(convId, limit = 200) {
  if (!inAccount(convId)) return []
  const rows = db
    .prepare(
      `SELECT rowid AS seq, ${DM_FIELDS.join(',')}` +
        ' FROM dm_messages WHERE conv_id=? ORDER BY ts DESC, rowid DESC LIMIT ?',
    )
    .all(convId, limit)
  return rows.reverse().map(readMsg)
}

/** 只保留本次扫描到的会话，清掉已消失/换 id 的旧会话及其消息。 */
export function dmPruneConvs(ids) {
  if (!ids || !ids.length) return 0
  const marks = ids.map(() => '?').join(',')
  const stale = db
    .prepare(`SELECT id FROM dm_conversations WHERE id NOT IN (${marks})`)
    .all(...ids)
  if (!stale.length) return 0
  const delMsg = db.prepare('DELETE FROM dm_messages WHERE conv_id=?')
  const delConv = db.prepare('DELETE FROM dm_conversations WHERE id=?')
  db.transaction(() => {
    for (const s of stale) {
      delMsg.run(s.id)
      delConv.run(s.id)
    }
  })()
  return stale.length
}

export function closeDb() {
  if (db) db.close()
  db = null
}

export function dmGetMemory(convId) {
  if (!inAccount(convId)) throw new Error('会话不属于当前账号')
  return db.prepare('SELECT * FROM dm_memory WHERE conv_id=?').get(convId)
    || { conv_id: convId, blocked: 0, summary: '', profile: '', summary_cursor: 0, updated: 0, handled_key: '', last_reply_at: 0 }
}

export function dmSaveMemory(convId, patch) {
  if (!inAccount(convId)) throw new Error('会话不属于当前账号')
  const fields = ['blocked', 'summary', 'profile', 'summary_cursor', 'updated', 'handled_key', 'last_reply_at', 'send_outcome', 'send_text', 'send_started', 'send_before_ids', 'send_partial', 'send_receipt_id'].filter(k => k in patch)
  db.prepare('INSERT OR IGNORE INTO dm_memory(conv_id) VALUES(?)').run(convId)
  if (fields.length) db.prepare(`UPDATE dm_memory SET ${fields.map(k => `${k}=?`).join(',')} WHERE conv_id=?`).run(...fields.map(k => patch[k]), convId)
  return dmGetMemory(convId)
}

export function dmMemoryBatch(convId, cursor, limit = 40) {
  if (!inAccount(convId)) return []
  return db.prepare('SELECT rowid AS seq, * FROM dm_messages WHERE conv_id=? AND rowid>? ORDER BY rowid LIMIT ?')
    .all(convId, cursor, limit).map(readMsg)
}

export function dmPendingMemories() {
  return db.prepare('SELECT m.conv_id FROM dm_messages m LEFT JOIN dm_memory s ON s.conv_id=m.conv_id WHERE m.rowid>COALESCE(s.summary_cursor,0) GROUP BY m.conv_id').all().filter(row => inAccount(row.conv_id))
}

export function dmEditMemory(convId, { summary, profile, clear }) {
  if (!dmGetConv(convId)) throw new Error('会话不存在')
  const memory = dmGetMemory(convId)
  const patch = { summary, profile, updated: Math.max(Date.now(), memory.updated + 1) }
  if (clear) Object.assign(patch, { summary: '', profile: '', summary_cursor: db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM dm_messages WHERE conv_id=?').get(convId).cursor })
  return dmSaveMemory(convId, patch)
}

// 首次确认账号时一次性归属旧数据；此后切换账号按平台、账号、会话隔离。
export function dmUseAccount(account) {
  const prefix = account ? `douyin:${account}:` : 'unverified:'
  if (account && !/^\d+$/.test(account)) throw new Error('账号身份无效')
  if (account) {
    db.transaction(() => {
      const owner = db.prepare("SELECT value FROM dm_meta WHERE key='legacy_owner'").get()
      if (!owner) {
        accountPrefix = null
        for (const row of db.prepare("SELECT id FROM dm_conversations WHERE id NOT LIKE 'douyin:%'").all()) dmMigrateConv(row.id, prefix + row.id)
        db.prepare("INSERT INTO dm_meta(key,value) VALUES('legacy_owner',?)").run(account)
      }
    })()
  }
  accountPrefix = prefix
}

export function dmContact(id) {
  if (!dmGetConv(id)) throw new Error('会话不存在')
  return { relationship: '', address: '', tone: '', boundaries: '', updated: 0, ...db.prepare('SELECT * FROM dm_contacts WHERE conv_id=?').get(id), examples: db.prepare('SELECT * FROM dm_examples WHERE conv_id=? ORDER BY id DESC LIMIT 20').all(id) }
}

export function dmSaveContact(id, patch) {
  if (!dmGetConv(id) || dmGetConv(id).is_group) throw new Error('请选择私聊联系人')
  const keys = ['relationship', 'address', 'tone', 'boundaries']
  for (const k of keys) if (typeof patch[k] !== 'string' || patch[k].length > 500) throw new Error('联系人资料每项最多 500 字')
  db.prepare('INSERT INTO dm_contacts(conv_id,relationship,address,tone,boundaries,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(conv_id) DO UPDATE SET relationship=excluded.relationship,address=excluded.address,tone=excluded.tone,boundaries=excluded.boundaries,updated=excluded.updated').run(id, ...keys.map(k => patch[k].trim()), Date.now())
  return dmContact(id)
}

export function dmAddExample(id, { source_key, original, reply, confirmed }) {
  if (confirmed !== true) throw new Error('请明确确认收录人工改写样例')
  if (!dmGetConv(id) || dmGetConv(id).is_group) throw new Error('请选择私聊联系人')
  const source = dmGetMsg(source_key)
  if (!source || source.conv_id !== id || source.direction !== 'in') throw new Error('样例来源消息无效')
  if (typeof original !== 'string' || typeof reply !== 'string' || !reply.trim() || reply.trim() === original.trim() || Math.max(original.length, reply.length) > 4000) throw new Error('请修改 AI 草稿后再收录，最多 4000 字')
  db.prepare('INSERT INTO dm_examples(conv_id,source_key,original,reply,created) VALUES(?,?,?,?,?)').run(id, source_key, original, reply.trim(), Date.now())
  return dmContact(id)
}

export function dmDeleteExample(id, exampleId) {
  dmContact(id)
  db.prepare('DELETE FROM dm_examples WHERE conv_id=? AND id=?').run(id, exampleId)
  return dmContact(id)
}

export function dmReconcileSend(message) {
  if (message.direction !== 'out' || !message.source_id) return
  const memory = dmGetMemory(message.conv_id)
  if (!['pending', 'unknown'].includes(memory.send_outcome)) return
  let before = []
  try { before = JSON.parse(memory.send_before_ids || '[]') } catch { return }
  const result = deliveryContent(memory.send_text, message.text)
  if (!before.includes(message.source_id) && result && message.ts * 1000 >= memory.send_started - 2000 && message.ts * 1000 <= memory.send_started + 60000) {
    return dmSaveMemory(message.conv_id, { send_outcome: 'confirmed', send_text: '', send_partial: result === 'partial' ? 1 : 0, send_receipt_id: message.source_id })
  }
}
