import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initImageGeneration, generateImages, generatedImageFile, serveGeneratedImage } from './image-generation.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dy-images-'))
}

function mockFetch(handler) {
  const original = global.fetch
  global.fetch = handler
  return () => { global.fetch = original }
}

test('b64_json 结果校验图片魔数、落盘并返回本地 URL；路径不允许跳出目录', async () => {
  const dir = tempDir()
  initImageGeneration(dir)
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }),
  }))
  try {
    const images = await generateImages({ baseUrl: 'https://api.example.test/v1', apiKey: 'sk-test', model: 'gpt-image-2.5-flare', prompt: '一张图', size: '1024x1024', quality: 'medium', n: 1 })
    assert.equal(images.length, 1)
    assert.match(images[0].url, /^\/generated-images\//)
    const file = generatedImageFile(images[0].url)
    assert.equal(fs.readFileSync(file).length, PNG.length)
    assert.throws(() => generatedImageFile('/generated-images/../secret.png'), /只能发送本地生成的图片|生成图片已不存在/)
  } finally { restore() }
})

test('非图片内容（魔数不符）被拒绝，不会留下半成品文件', async () => {
  const dir = tempDir()
  initImageGeneration(dir)
  const restore = mockFetch(async () => ({
    ok: true,
    json: async () => ({ data: [{ b64_json: Buffer.from('not an image at all').toString('base64') }] }),
  }))
  try {
    await assert.rejects(generateImages({ baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', prompt: 'x', size: 'auto', quality: 'auto' }), /不是 PNG、JPEG、WebP 或 GIF/)
    assert.equal(fs.readdirSync(dir).length, 0)
  } finally { restore() }
})

test('供应商 HTTP 错误会隐藏密钥并带上状态码', async () => {
  const dir = tempDir()
  initImageGeneration(dir)
  const restore = mockFetch(async () => ({ ok: false, status: 401, text: async () => 'Unauthorized key sk-secret123' }))
  try {
    await assert.rejects(
      generateImages({ baseUrl: 'https://api.example.test/v1', apiKey: 'sk-secret123', model: 'm', prompt: 'x', size: 'auto', quality: 'auto' }),
      (error) => {
        assert.match(error.message, /HTTP 401/)
        assert.match(error.message, /\[密钥已隐藏\]/)
        assert.doesNotMatch(error.message, /sk-secret123/)
        return true
      },
    )
  } finally { restore() }
})

test('空 data 数组和缺少密钥都是明确错误', async () => {
  const dir = tempDir()
  initImageGeneration(dir)
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ data: [] }) }))
  try {
    await assert.rejects(generateImages({ baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', prompt: 'x', size: 'auto', quality: 'auto' }), /没有返回图片/)
    await assert.rejects(generateImages({ baseUrl: 'https://api.example.test/v1', apiKey: '', model: 'm', prompt: 'x', size: 'auto', quality: 'auto' }), /还没配置模型 Key/)
  } finally { restore() }
})

test('serveGeneratedImage 拒绝非法文件名并以正确的 MIME 输出', async () => {
  const dir = tempDir()
  initImageGeneration(dir)
  const restore = mockFetch(async () => ({ ok: true, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) }))
  let url
  try {
    ;({ 0: { url } } = await generateImages({ baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'm', prompt: 'x', size: 'auto', quality: 'auto' }))
  } finally { restore() }
  const name = decodeURIComponent(url.split('/').pop())

  const res404 = { code: 0, writeHead(code) { this.code = code }, end() {} }
  await serveGeneratedImage(res404, '../secret.png')
  assert.equal(res404.code, 404)

  const chunks = []
  const resOk = new (await import('node:stream')).Writable({
    write(chunk, _enc, callback) { chunks.push(chunk); callback() },
  })
  resOk.writeHead = (code, headers) => { resOk.code = code; resOk.headers = headers }
  await serveGeneratedImage(resOk, name)
  assert.equal(resOk.code, 200)
  assert.equal(resOk.headers['Content-Type'], 'image/png')
  assert.equal(Buffer.concat(chunks).length, PNG.length)
})
