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

export function closeDb() {
  if (db) db.close()
  db = null
}
