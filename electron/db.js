// 消息与 AI 摘要落 SQLite，看板刷新/重启后仍可回看历史。
import Database from 'better-sqlite3'

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
  // 富媒体字段：老库补列；旧消息没有 kind，直接清掉重新采集
  const cols = db.prepare('PRAGMA table_info(dm_messages)').all().map((c) => c.name)
  if (!cols.includes('kind')) {
    db.exec('ALTER TABLE dm_messages ADD COLUMN kind TEXT')
    db.exec('ALTER TABLE dm_messages ADD COLUMN thumb TEXT')
    db.exec('ALTER TABLE dm_messages ADD COLUMN author TEXT')
    db.exec('DELETE FROM dm_messages')
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
    'INSERT INTO dm_conversations(id, name, avatar, preview, last_ts, last_time, unread, updated)' +
      ' VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET' +
      ' name=excluded.name, avatar=excluded.avatar,' +
      ' preview=CASE WHEN excluded.last_ts >= dm_conversations.last_ts THEN excluded.preview ELSE dm_conversations.preview END,' +
      ' last_ts=MAX(dm_conversations.last_ts, excluded.last_ts),' +
      ' last_time=CASE WHEN excluded.last_ts >= dm_conversations.last_ts THEN excluded.last_time ELSE dm_conversations.last_time END,' +
      ' unread=excluded.unread, updated=excluded.updated',
  ).run(
    c.id,
    c.name || '',
    c.avatar || null,
    c.preview || '',
    c.last_ts || 0,
    c.last_time || '',
    c.unread || 0,
    Date.now() / 1000,
  )
}

export function dmGetConv(id) {
  return db.prepare('SELECT * FROM dm_conversations WHERE id=?').get(id)
}

export function dmListConvs(limit = 80) {
  return db
    .prepare('SELECT id, name, avatar, preview, last_ts, last_time, unread FROM dm_conversations ORDER BY last_ts DESC LIMIT ?')
    .all(limit)
}

export function dmInsertMsg(m) {
  const info = db
    .prepare(
      'INSERT OR IGNORE INTO dm_messages(key, conv_id, direction, kind, text, thumb, author, ts, time)' +
        ' VALUES(?,?,?,?,?,?,?,?,?)',
    )
    .run(m.key, m.conv_id, m.direction, m.kind || 'text', m.text, m.thumb || '', m.author || '', m.ts, m.time)
  return info.changes > 0
}

export function dmListMsgs(convId, limit = 200) {
  const rows = db
    .prepare(
      'SELECT key, conv_id, direction, kind, text, thumb, author, ts, time' +
        ' FROM dm_messages WHERE conv_id=? ORDER BY ts DESC LIMIT ?',
    )
    .all(convId, limit)
  return rows.reverse()
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
