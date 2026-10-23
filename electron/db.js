// 消息与 AI 摘要落 SQLite，看板刷新/重启后仍可回看历史。
import Database from 'better-sqlite3'
import { mediaIdentity } from './media-data.js'

let db = null

export function initDb(file) {
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
  // 补列保留历史；重新采集到的消息会补齐身份与媒体信息。
  const cols = db.prepare('PRAGMA table_info(dm_messages)').all().map((c) => c.name)
  for (const col of ['kind', 'thumb', 'author', 'source_id', 'sender_id', 'sender_name', 'sender_avatar', 'sender_sec_uid', 'aweme_id', 'video_url', 'media_url', 'images']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE dm_messages ADD COLUMN ${col} TEXT DEFAULT ''`)
  }
  const convCols = db.prepare('PRAGMA table_info(dm_conversations)').all().map((c) => c.name)
  for (const col of ['is_group', 'peer_sec_uid']) {
    if (!convCols.includes(col)) db.exec(`ALTER TABLE dm_conversations ADD COLUMN ${col} ${col === 'is_group' ? 'INTEGER DEFAULT 0' : "TEXT DEFAULT ''"}`)
  }
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
  return db.prepare('SELECT * FROM dm_conversations WHERE id=?').get(id)
}

export function dmListConvs(limit = 80) {
  return db
    .prepare('SELECT c.*, COALESCE(m.blocked,0) AS auto_reply_blocked FROM dm_conversations c LEFT JOIN dm_memory m ON m.conv_id=c.id ORDER BY c.last_ts DESC LIMIT ?')
    .all(limit)
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
      summary_cursor: current.summary ? current.summary_cursor : oldMemory.summary_cursor,
      updated: current.summary ? current.updated : oldMemory.updated,
      handled_key: current.last_reply_at > oldMemory.last_reply_at ? current.handled_key : oldMemory.handled_key || current.handled_key,
      last_reply_at: Math.max(current.last_reply_at, oldMemory.last_reply_at),
    })
    db.prepare('DELETE FROM dm_memory WHERE conv_id=?').run(oldId)
    db.prepare('DELETE FROM dm_conversations WHERE id=?').run(oldId)
  })()
}

const DM_FIELDS = ['key', 'conv_id', 'direction', 'kind', 'text', 'thumb', 'author', 'ts', 'time',
  'source_id', 'sender_id', 'sender_name', 'sender_avatar', 'sender_sec_uid', 'aweme_id', 'video_url', 'media_url', 'images']

function readMsg(row) {
  if (!row) return row
  try { row.images = JSON.parse(row.images || '[]') } catch { row.images = [] }
  return row
}

const fieldValue = (key, message) => key === 'images' ? JSON.stringify(message.images || []) : message[key] ?? ''

export function dmGetMsg(key) {
  return readMsg(db.prepare('SELECT * FROM dm_messages WHERE key=?').get(key)
    || db.prepare('SELECT m.* FROM dm_messages m JOIN dm_message_aliases a ON a.message_key=m.key WHERE a.alias=?').get(key))
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
  return db.prepare('SELECT * FROM dm_memory WHERE conv_id=?').get(convId)
    || { conv_id: convId, blocked: 0, summary: '', summary_cursor: 0, updated: 0, handled_key: '', last_reply_at: 0 }
}

export function dmSaveMemory(convId, patch) {
  const fields = ['blocked', 'summary', 'summary_cursor', 'updated', 'handled_key', 'last_reply_at'].filter(k => k in patch)
  db.prepare('INSERT OR IGNORE INTO dm_memory(conv_id) VALUES(?)').run(convId)
  if (fields.length) db.prepare(`UPDATE dm_memory SET ${fields.map(k => `${k}=?`).join(',')} WHERE conv_id=?`).run(...fields.map(k => patch[k]), convId)
  return dmGetMemory(convId)
}

export function dmMemoryBatch(convId, cursor, limit = 40) {
  return db.prepare('SELECT rowid AS seq, * FROM dm_messages WHERE conv_id=? AND rowid>? ORDER BY rowid LIMIT ?')
    .all(convId, cursor, limit).map(readMsg)
}

export function dmPendingMemories() {
  return db.prepare('SELECT m.conv_id FROM dm_messages m LEFT JOIN dm_memory s ON s.conv_id=m.conv_id WHERE m.rowid>COALESCE(s.summary_cursor,0) GROUP BY m.conv_id').all()
}
