import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { serveStatic } from './static.js'

test('桌面端正确提供 MP4 和分段请求', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-static-'))
  const content = Buffer.from('0123456789')
  fs.writeFileSync(path.join(dir, 'action.mp4'), content)
  const server = http.createServer((req, res) => serveStatic(req, res, dir, req.url))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.address().port}/action.mp4`
  const whole = await fetch(url)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('content-type'), 'video/mp4')
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), content)
  const partial = await fetch(url, { headers: { Range: 'bytes=2-5' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(await partial.text(), '2345')
  const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } })
  assert.equal(await suffix.text(), '789')
  const invalid = await fetch(url, { headers: { Range: 'bytes=10-' } })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), 'bytes */10')
})
