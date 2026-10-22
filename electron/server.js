// 本地 HTTP + WebSocket 服务：给看板页面提供同源接口，生产模式同时托管 dist 静态文件。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import * as live from './live.js'
import * as im from './im.js'
import * as db from './db.js'
import * as media from './media.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) return reject(new Error('body too large'))
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function serveStatic(res, staticDir, pathname) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(staticDir, safe)
  if (!file.startsWith(staticDir)) file = path.join(staticDir, 'index.html')
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html')
  if (!fs.existsSync(file)) {
    res.writeHead(404)
    return res.end('Not Found')
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
}

export function startServer({ port = 0, staticDir }) {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.send(JSON.stringify(live.statMsg()))
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  live.setBroadcaster((msg) => {
    const data = JSON.stringify(msg)
    for (const ws of [...clients]) {
      try {
        ws.send(data)
      } catch {
        clients.delete(ws)
      }
    }
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    try {
      if (p === '/ws') return res.end()

      if (p === '/login/status' && req.method === 'GET') return json(res, { logged_in: await live.loginStatus() })
      if (p === '/login/start' && req.method === 'POST') return json(res, await live.loginStart())
      if (p === '/login/complete' && req.method === 'POST') return json(res, await live.loginComplete())
      if (p === '/login/save' && req.method === 'POST') return json(res, await live.saveLoginState())
      if (p === '/login/clear' && req.method === 'POST') return json(res, await live.clearLoginState())

      if (p === '/connect' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await live.connect(body.room_id))
      }
      if (p === '/disconnect' && req.method === 'POST') return json(res, await live.disconnect())

      if (p === '/config' && req.method === 'GET') return json(res, live.getConfig())
      if (p === '/config' && req.method === 'POST') return json(res, live.setConfig(await readBody(req)))

      if (p === '/agent' && req.method === 'GET') return json(res, live.getAgentConfig())
      if (p === '/agent' && req.method === 'POST') return json(res, live.setAgentConfig(await readBody(req)))

      if (p === '/window/show' && req.method === 'POST') return json(res, await live.showLiveWindow())
      if (p === '/window/hide' && req.method === 'POST') return json(res, live.hideLiveWindow())

      // ---- 私信 ----
      if (p === '/dm/status' && req.method === 'GET') return json(res, im.dmStat())
      if (p === '/dm/start' && req.method === 'POST') return json(res, await im.start())
      if (p === '/dm/stop' && req.method === 'POST') return json(res, im.stop())
      if (p === '/dm/open' && req.method === 'POST') return json(res, await im.showWindow())
      if (p === '/dm/sync' && req.method === 'POST') return json(res, await im.syncOnce())
      if (p === '/dm/dump' && req.method === 'GET') return json(res, await im.dumpPage())
      if (p === '/dm/select' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.select(body.conv_id))
      }
      if (p === '/dm/group' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.groupInfo(body.conv_id))
      }
      if (p === '/dm/member' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.memberChat(body.conv_id, body.member_id))
      }
      if (p === '/dm/member-follow' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.followMember(body.conv_id, body.member_id))
      }
      if (p === '/dm/media/resolve' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await media.prepareMedia(await im.mediaMessage(body.key), !!body.refresh))
      }
      if (p === '/dm/media/open' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.openMedia(body.key))
      }
      const video = p.match(/^\/dm\/media\/(.+)$/)
      if (video && req.method === 'GET') {
        const index = url.searchParams.get('image')
        if (index !== null && !/^\d+$/.test(index)) return json(res, { ok: false, msg: '图片序号无效' }, 400)
        return await media.streamMedia(db.dmGetMsg(decodeURIComponent(video[1])), req, res, index === null ? null : Number(index))
      }
      if (p === '/dm/attach' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.attachFiles(body.conv_id))
      }
      if (p === '/dm/agent' && req.method === 'GET') return json(res, im.getAgent())
      if (p === '/dm/agent' && req.method === 'POST') return json(res, im.setAgent(await readBody(req)))

      if (p === '/dm/conversations' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 80, 300)
        return json(res, { conversations: db.dmListConvs(limit) })
      }
      const dmMsg = p.match(/^\/dm\/messages\/(.+)$/)
      if (dmMsg && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500)
        return json(res, { messages: db.dmListMsgs(decodeURIComponent(dmMsg[1]), limit) })
      }
      if (p === '/dm/draft' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.draft(body.conv_id))
      }
      if (p === '/dm/send' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.send(body.conv_id, body.text))
      }

      if (p === '/history' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 500)
        return json(res, { windows: db.history(limit) })
      }
      const m = p.match(/^\/history\/(\d+)$/)
      if (m && req.method === 'GET') return json(res, { messages: db.windowMessages(Number(m[1])) })

      if (staticDir && req.method === 'GET') return serveStatic(res, staticDir, p)

      json(res, { ok: false, msg: 'Not Found' }, 404)
    } catch (e) {
      if (res.headersSent) return res.destroy()
      json(res, { ok: false, msg: String(e.message || e) }, 500)
    }
  })

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        port: actual,
        close: () =>
          new Promise((done) => {
            wss.close()
            server.close(() => done())
          }),
      })
    })
  })
}
