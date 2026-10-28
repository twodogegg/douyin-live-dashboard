import fs from 'node:fs'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

export function serveStatic(req, res, staticDir, pathname) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(staticDir, safe)
  if (!file.startsWith(staticDir)) file = path.join(staticDir, 'index.html')
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html')
  if (!fs.existsSync(file)) {
    res.writeHead(404)
    return res.end('Not Found')
  }
  const contentType = MIME[path.extname(file)] || 'application/octet-stream'
  if (path.extname(file) !== '.mp4') {
    res.writeHead(200, { 'Content-Type': contentType })
    return res.end(fs.readFileSync(file))
  }

  const size = fs.statSync(file).size
  const range = req.headers.range
  let start = 0
  let end = size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    const first = match?.[1]
    const last = match?.[2]
    if (!match || (!first && !last)) return invalidRange(res, size)
    if (!first) {
      const suffix = Number(last)
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalidRange(res, size)
      start = Math.max(0, size - suffix)
    } else {
      start = Number(first)
      if (last) end = Math.min(Number(last), end)
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return invalidRange(res, size)
  }
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(range ? 206 : 200, headers)
  const stream = fs.createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  return stream.pipe(res)
}

function invalidRange(res, size) {
  res.writeHead(416, { 'Content-Range': `bytes */${size}` })
  return res.end()
}
