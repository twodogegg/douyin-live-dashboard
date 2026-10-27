// 本地 HTTP + WebSocket 服务：给看板页面提供同源接口，生产模式同时托管 dist 静态文件。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import * as live from './live.js'
import * as im from './im.js'
import * as db from './db.js'
import * as media from './media.js'
import * as fish from './fish.js'
import { parseMemory } from './dm-context.js'
import { TOOL_DEFINITIONS, listSkills } from './capabilities.js'
import { serveGeneratedImage } from './image-generation.js'
import { createLiveStage } from './live-stage.js'
import { createStageAudio } from './stage-audio.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (tooLarge) return
      if (size > limit) { tooLarge = true; return reject(new Error('上传内容过大')) }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return
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

export function startServer({ port = 0, staticDir, stageFile, showStage }) {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set()
  const send = msg => {
    const data = JSON.stringify(msg)
    for (const ws of [...clients]) {
      try { ws.send(data) } catch { clients.delete(ws) }
    }
  }
  const stageAudio = createStageAudio(fish.streamSpeech)
  const stage = createLiveStage({
    file: stageFile,
    chat: live.chatComplete,
    synthesize: text => stageAudio.prepare(text),
    cancelAudio: stageAudio.clear,
    broadcast: send,
    readiness: () => ({ ai: live.aiConfig().has_key, voice: fish.getConfig().has_key && !!fish.getConfig().reference_id }),
  })

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.send(JSON.stringify(live.statMsg()))
    ws.send(JSON.stringify(stage.snapshot()))
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  live.setBroadcaster((msg) => {
    send(msg)
    stage.observe(msg)
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    try {
      if (p === '/ws') return res.end()

      const stageStream = p.match(/^\/stage\/audio\/([a-f\d-]{36})$/)
      if (stageStream && req.method === 'GET') return await stageAudio.serve(req, res, stageStream[1])

      if (p === '/stage/config' && req.method === 'GET') return json(res, stage.snapshot())
      if (p === '/stage/config' && req.method === 'POST') return json(res, { ok: true, ...stage.configure(await readBody(req)) })
      if (p === '/stage/test' && req.method === 'POST') return json(res, { ok: true, reply: await stage.test(await readBody(req)) })
      if (p === '/stage/window' && req.method === 'POST') {
        if (!showStage) return json(res, { ok: false, msg: '请在桌面端打开播出窗口' })
        await showStage()
        return json(res, { ok: true })
      }

      if (p === '/login/status' && req.method === 'GET') return json(res, { logged_in: await live.loginStatus() })
      if (p === '/login/start' && req.method === 'POST') return json(res, await live.loginStart())
      if (p === '/login/complete' && req.method === 'POST') return json(res, await live.loginComplete())
      if (p === '/login/save' && req.method === 'POST') return json(res, await live.saveLoginState())
      if (p === '/login/clear' && req.method === 'POST') { im.invalidateAccount(); return json(res, await live.clearLoginState()) }

      if (p === '/connect' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await live.connect(body.room_id))
      }
      if (p === '/disconnect' && req.method === 'POST') return json(res, await live.disconnect())

      if (p === '/config' && req.method === 'GET') return json(res, live.getConfig())
      if (p === '/config' && req.method === 'POST') return json(res, live.setConfig(await readBody(req)))

      if (p === '/agent' && req.method === 'GET') return json(res, live.getAgentConfig())
      if (p === '/agent' && req.method === 'POST') return json(res, live.setAgentConfig(await readBody(req)))

      if (p === '/capabilities' && req.method === 'GET') return json(res, { tools: TOOL_DEFINITIONS.map(({ definition, ...tool }) => ({ ...tool, parameters: definition.function.parameters })), skills: listSkills() })

      const generatedImage = p.match(/^\/generated-images\/([\w-]+\.(?:png|jpe?g|webp|gif))$/)
      if (p.startsWith('/generated-images/')) {
        if (generatedImage && req.method === 'GET') return serveGeneratedImage(res, generatedImage[1])
        return json(res, { ok: false, msg: '图片不存在' }, 404)
      }

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
      if (p === '/dm/agent' && req.method === 'POST') return json(res, im.setAgent(await readBody(req), new Set(listSkills().map(skill => skill.id))))
      if (p === '/dm/images/generate' && req.method === 'POST') return json(res, await im.generateDmImages(await readBody(req)))
      if (p === '/dm/images/send' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, await im.sendImage(body.conv_id, body.url))
      }
      if (p === '/dm/block' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, im.setBlocked(body.conv_id, body.blocked))
      }
      const contact = p.match(/^\/dm\/contact\/(.+)$/)
      if (contact && req.method === 'GET') return json(res, db.dmContact(decodeURIComponent(contact[1])))
      if (contact && req.method === 'POST') return json(res, { ok: true, contact: db.dmSaveContact(decodeURIComponent(contact[1]), await readBody(req)) })
      const example = p.match(/^\/dm\/examples\/(.+)$/)
      if (example && req.method === 'POST') return json(res, { ok: true, contact: db.dmAddExample(decodeURIComponent(example[1]), await readBody(req)) })
      if (example && req.method === 'DELETE') return json(res, { ok: true, contact: db.dmDeleteExample(decodeURIComponent(example[1]), Number(url.searchParams.get('id'))) })
      const rebuild = p.match(/^\/dm\/memory\/(.+)\/rebuild$/)
      if (rebuild && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        return json(res, await im.rebuildProfile(decodeURIComponent(rebuild[1]), { reset: body?.reset !== false }))
      }
      if (p === '/dm/debug/memory' && req.method === 'GET') return json(res, { ok: true, raw: im.lastMemoryOutput() })
      const transcript = p.match(/^\/dm\/transcripts\/(.+)$/)
      if (transcript && req.method === 'POST') return json(res, { ok: true, ...await im.backfillTranscripts(decodeURIComponent(transcript[1])) })
      const dmMemory = p.match(/^\/dm\/memory\/(.+)$/)
      if (dmMemory && req.method === 'GET') return json(res, db.dmGetMemory(decodeURIComponent(dmMemory[1])))
      if (dmMemory && req.method === 'POST') {
        const body = await readBody(req)
        const convId = decodeURIComponent(dmMemory[1])
        if (body.clear !== true && body.expected_updated !== db.dmGetMemory(convId).updated) throw new Error('记忆已更新，请取消后重新编辑')
        const patch = body.clear === true ? { clear: true } : parseMemory(JSON.stringify({ summary: body.summary || '（暂无）', profile: body.profile }))
        const memory = db.dmEditMemory(convId, patch)
        live.broadcast({ type: 'dm_memory', conv_id: convId, memory })
        return json(res, { ok: true, memory })
      }
      if (p === '/dm/voice/config' && req.method === 'GET') return json(res, fish.getConfig())
      if (p === '/dm/voice/config' && req.method === 'POST') return json(res, { ok: true, config: fish.setConfig(await readBody(req)) })
      if (p === '/dm/voice/models' && req.method === 'GET') return json(res, { ok: true, ...await fish.listVoices(Object.fromEntries(url.searchParams)) })
      const voice = p.match(/^\/dm\/voice\/models\/([a-f\d]{32})$/i)
      if (voice && req.method === 'GET') return json(res, { ok: true, voice: await fish.getVoice(voice[1]) })
      if (p === '/dm/voice/preview' && req.method === 'POST') {
        const body = await readBody(req)
        return json(res, { ok: true, ...await fish.synthesize(body.text, body.reference_id, body.emotion) })
      }
      if (p === '/dm/voice/design' && req.method === 'POST') return json(res, { ok: true, ...await fish.designVoice(await readBody(req)) })
      if (p === '/dm/voice/create' && req.method === 'POST') return json(res, { ok: true, voice: await fish.createVoice(await readBody(req, 28 * 1024 * 1024)) })
      if (p === '/dm/voice/transcribe' && req.method === 'POST') return json(res, await im.transcribeMessage((await readBody(req)).key))
      const audio = p.match(/^\/dm\/voice\/audio\/([a-f\d]{64}\.(mp3|wav))$/)
      if (audio && req.method === 'GET') {
        const file = fish.audioFile(audio[1])
        res.writeHead(200, { 'Content-Type': audio[2] === 'wav' ? 'audio/wav' : 'audio/mpeg', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=86400' })
        const stream = fs.createReadStream(file)
        stream.on('error', () => res.destroy())
        res.on('close', () => stream.destroy())
        return stream.pipe(res)
      }

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
            stage.close()
            wss.close()
            server.close(() => done())
          }),
      })
    })
  })
}
