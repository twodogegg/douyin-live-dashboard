import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
let directory = ''

export function initImageGeneration(outputDirectory) {
  directory = outputDirectory
  fs.mkdirSync(directory, { recursive: true })
}

function imageType(data) {
  if (data[0] === 0x89 && data.subarray(1, 4).toString() === 'PNG') return { ext: '.png', mime: 'image/png' }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' }
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return { ext: '.webp', mime: 'image/webp' }
  if (data.subarray(0, 6).toString() === 'GIF89a' || data.subarray(0, 6).toString() === 'GIF87a') return { ext: '.gif', mime: 'image/gif' }
  throw new Error('供应商返回的内容不是 PNG、JPEG、WebP 或 GIF 图片')
}

async function save(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 20 MiB')
  const type = imageType(data)
  const name = `${Date.now()}-${randomUUID()}${type.ext}`
  const file = path.join(directory, name)
  await fs.promises.writeFile(file, data, { flag: 'wx' })
  return { name, url: `/generated-images/${encodeURIComponent(name)}`, size: data.length }
}

async function download(url) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('图片结果 URL 无效')
  const response = await fetch(parsed, { signal: AbortSignal.timeout(60000), redirect: 'follow' })
  if (!response.ok) throw new Error(`下载生成图片失败 HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new Error('生成图片超过 20 MiB') }
  const data = Buffer.from(await response.arrayBuffer())
  return save(data)
}

function dataImage(value) {
  const match = value.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/s)
  if (!match) return null
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || data.length > MAX_IMAGE_BYTES || data.toString('base64') !== match[2].replace(/\s/g, '')) throw new Error('图片 Base64 无效')
  return { mime: match[1], data }
}

async function reference(value) {
  if (typeof value !== 'string') throw new Error('参考图片无效')
  const inline = dataImage(value)
  if (inline) return inline
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') throw new Error('参考图片必须来自 HTTPS 或本地图片数据')
  const response = await fetch(parsed, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`读取参考图片失败 HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  imageType(data)
  if (data.length > MAX_IMAGE_BYTES) throw new Error('参考图片超过 20 MiB')
  return { data, mime: response.headers.get('content-type')?.split(';')[0] || imageType(data).mime }
}

function endpoint(baseUrl, name) {
  return `${String(baseUrl).replace(/\/$/, '')}/${name}`
}

async function providerError(response) {
  const text = (await response.text()).replace(/sk-[\w-]+/g, '[密钥已隐藏]').slice(0, 800)
  const error = new Error(`生图服务 HTTP ${response.status}：${text}`)
  error.httpStatus = response.status
  throw error
}

export async function generateImages({ baseUrl, apiKey, model, prompt, size, quality, n = 1, referenceImage = '' }) {
  if (!directory) throw new Error('图片存储尚未初始化')
  if (!apiKey) throw new Error('还没配置模型 Key，请先到「模型连接」里填写')
  if (!prompt?.trim() || prompt.length > 8000) throw new Error('生图提示词为空或超过 8000 字符')
  const count = Math.max(1, Math.min(4, Number(n) || 1))
  const ref = referenceImage ? await reference(referenceImage) : null
  let response
  if (ref) {
    const form = new FormData()
    form.set('model', model)
    form.set('prompt', prompt.trim())
    form.set('n', String(count))
    if (size && size !== 'auto') form.set('size', size)
    if (quality && quality !== 'auto') form.set('quality', quality)
    form.set('image', new Blob([ref.data], { type: ref.mime }), `reference${imageType(ref.data).ext}`)
    response = await fetch(endpoint(baseUrl, 'images/edits'), { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(240000) })
  } else {
    response = await fetch(endpoint(baseUrl, 'images/generations'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt: prompt.trim(), n: count, ...(size !== 'auto' ? { size } : {}), ...(quality !== 'auto' ? { quality } : {}) }),
      signal: AbortSignal.timeout(240000),
    })
  }
  if (!response.ok) await providerError(response)
  let payload
  try { payload = await response.json() } catch { throw new Error('生图服务返回的不是 JSON') }
  if (!Array.isArray(payload.data) || !payload.data.length) throw new Error(`生图服务没有返回图片：${JSON.stringify(payload).slice(0, 500)}`)
  const images = []
  for (const [index, item] of payload.data.entries()) {
    if (typeof item?.url === 'string' && item.url) images.push(await download(item.url))
    else if (typeof item?.b64_json === 'string' && item.b64_json) images.push(await save(Buffer.from(item.b64_json, 'base64')))
    else throw new Error(`第 ${index + 1} 张图片缺少 url 或 b64_json`)
  }
  return images
}

export async function serveGeneratedImage(res, name) {
  if (!/^[\w-]+\.(png|jpe?g|webp|gif)$/.test(name)) { res.writeHead(404); return res.end() }
  const file = path.join(directory, name)
  if (path.dirname(file) !== directory || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
  const stat = fs.statSync(file)
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
  await pipeline(fs.createReadStream(file), res)
}

export function generatedImageFile(url) {
  const match = String(url).match(/^\/generated-images\/([\w-]+\.(?:png|jpe?g|webp|gif))$/)
  if (!match) throw new Error('只能发送本地生成的图片')
  const file = path.resolve(directory, decodeURIComponent(match[1]))
  if (path.dirname(file) !== path.resolve(directory) || !fs.existsSync(file)) throw new Error('生成图片已不存在，请重新生成')
  return file
}
