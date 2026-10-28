import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { createStageAudioQueue } from '../lib/stage-audio-queue'
import type { StageReply } from '../types'

type RoutedAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
const DEVICE_KEY = 'live-stage-audio-output'

// 一句播完到下一句开口之间的气口。太短会显得抢话，太长就有明显的"卡一下"。
const GAP_MS = 180

/**
 * 播出窗口的语音播放。
 *
 * 逐句播放而不是整段播：每播完一句就向后端上报 stage_played，
 * 后端在主播说话期间就开始生成并合成下一批回复，所以下一句往往是"已经在缓冲里"的。
 */
export function useStagePlayback(reply: StageReply | null, enabled: boolean) {
  const [armed, setArmed] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [current, setCurrent] = useState<StageReply | null>(null)
  // 当前播到第几句，用于在画面上显示进度。
  const [progress, setProgress] = useState({ index: 0, total: 1 })
  const [error, setError] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState(() => localStorage.getItem(DEVICE_KEY) || 'default')
  const audio = useRef<RoutedAudio | null>(null)
  const queue = useRef<StageReply[]>([])
  const [queuedAudio] = useState(() => createStageAudioQueue())
  const running = useRef(false)
  const generation = useRef(0)
  const config = useRef({ armed, device })
  const seen = useRef(new Set<string>())
  const kick = useRef<() => void>(() => {})
  // 逐句播放状态：当前回复、句序与已取到的音频地址。
  const plan = useRef<{ reply: StageReply | null; index: number; audio: Map<number, { url: string; error: string }> }>({
    reply: null, index: 0, audio: new Map(),
  })
  const gapTimer = useRef<number | undefined>(undefined)
  config.current = { armed, device }

  const refreshDevices = useCallback(async (requestPermission = false) => {
    try {
      if (requestPermission) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(track => track.stop())
      }
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audiooutput' && item.deviceId))
    } catch { setError('无法读取音频设备，请允许麦克风权限后重试。') }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const changed = () => { void refreshDevices() }
    navigator.mediaDevices?.addEventListener('devicechange', changed)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', changed)
  }, [refreshDevices])

  const stop = useCallback(() => {
    generation.current++
    queue.current = []
    queuedAudio.clear()
    window.clearTimeout(gapTimer.current)
    if (audio.current) {
      audio.current.onended = null
      audio.current.onerror = null
      audio.current.pause()
      audio.current.removeAttribute('src')
      audio.current.load()
      audio.current = null
    }
    running.current = false
    plan.current = { reply: null, index: 0, audio: new Map() }
    setSpeaking(false)
    setCurrent(null)
    setProgress({ index: 0, total: 1 })
  }, [queuedAudio])

  // 取第 index 句的音频：第一句随回复下发，后面按需向后端要。
  const loadSentence = async (target: StageReply, index: number): Promise<{ url: string; error: string }> => {
    const cached = plan.current.audio.get(index)
    if (cached) return cached
    const queued = index === 0 && queuedAudio.get(target.id)
    if (queued) {
      const value = await queued
      plan.current.audio.set(index, value)
      return value
    }
    const inline = target.sentences?.[index]?.audio_url
    if (inline) {
      plan.current.audio.set(index, { url: inline, error: '' })
      return { url: inline, error: '' }
    }
    if (!target.sentences?.length) {
      const fallback = index === 0 ? { url: target.audio_url, error: target.audio_error } : { url: '', error: '' }
      plan.current.audio.set(index, fallback)
      return fallback
    }
    try {
      const result = await api.stageAudio({ id: target.id, index })
      const value = { url: result?.audio_url || '', error: result?.audio_error || result?.msg || '' }
      plan.current.audio.set(index, value)
      return value
    } catch {
      return { url: '', error: '获取下一句语音失败' }
    }
  }

  const playSentence = useCallback(async () => {
    if (running.current || !config.current.armed) return
    const target = plan.current.reply
    if (!target) {
      // 当前回复播完了：取队列里下一条继续。队列最多 5 条，超出的旧回复直接丢弃。
      const next = queue.current.shift()
      if (next) {
        plan.current = { reply: next, index: 0, audio: new Map() }
        kick.current()
      }
      return
    }
    const index = plan.current.index
    const total = target.sentences?.length || 1
    const token = generation.current
    if (index >= total) return
    running.current = true
    setCurrent(target)
    setProgress({ index, total })

    let finished = false
    const finish = (message = '') => {
      if (finished || token !== generation.current) return
      finished = true
      if (message) setError(message)
      if (index === 0) queuedAudio.discard(target.id)
      running.current = false
      audio.current = null
      setSpeaking(false)
      plan.current.index += 1
      const done = plan.current.index >= total
      // 每播完一句就上报：后端据此打开"说话窗口"，提前把下一批回复准备好。
      void api.stagePlayed({ id: target.id, index, final: done })
      if (done) plan.current = { reply: null, index: 0, audio: new Map() }
      setCurrent(null)
      // 句与句之间留一点气口；整条播完则立刻看队列里有没有下一条。
      gapTimer.current = window.setTimeout(() => kick.current(), done ? 0 : GAP_MS)
    }

    const sentence = await loadSentence(target, index)
    if (token !== generation.current) return
    if (!sentence.url) {
      if (sentence.error) setError(sentence.error)
      finish(sentence.error)
      return
    }
    const player = new Audio(sentence.url) as RoutedAudio
    audio.current = player
    player.onended = () => finish()
    player.onerror = () => finish('语音加载失败，已跳过当前句。')
    let sinkReady = false
    try {
      const selected = config.current.device
      if (selected !== 'default' && !player.setSinkId) throw new Error('当前浏览器不支持选择播放设备，请使用桌面端或 Chrome。')
      if (player.setSinkId) await player.setSinkId(selected)
      if (finished || token !== generation.current) return
      sinkReady = true
      // 气口由 finish 统一控制，这里直接开口，避免两句之间多等一倍。
      await player.play()
      if (finished || token !== generation.current) { player.pause(); return }
      setError('')
      setSpeaking(true)
    } catch (e) {
      if (finished || token !== generation.current) return
      player.onerror = null
      player.pause()
      if (sinkReady && (!(e instanceof DOMException) || e.name !== 'NotAllowedError')) {
        finish('语音加载失败，已跳过当前句。')
        return
      }
      running.current = false
      audio.current = null
      setArmed(false)
      setSpeaking(false)
      setError(e instanceof Error ? `播放失败：${e.message}` : '播放失败，请检查输出设备并重新启用语音。')
    }
  }, [queuedAudio])
  kick.current = () => { void playSentence() }

  useEffect(() => {
    if (!reply) { stop(); return }
    if (seen.current.has(reply.id)) return
    seen.current.add(reply.id)
    if (seen.current.size > 300) seen.current.delete(seen.current.values().next().value!)
    // 语音关闭期间只更新气泡，重新开启时不追播旧回复。
    if (!config.current.armed) { setCurrent(reply); return }
    if (!reply.audio_url && !reply.sentences?.[0]?.audio_url) {
      setCurrent(reply)
      setProgress({ index: 0, total: reply.sentences?.length || 1 })
      // 没有音频也要把"整条播完"上报出去，让后端继续后续调度。
      void api.stagePlayed({ id: reply.id, index: (reply.sentences?.length || 1) - 1, final: true })
      return
    }
    // 正在播上一条时不打断：排到队列里，播完自然接上。
    if (plan.current.reply) {
      // 语音在上一条播放时就取到本地，避免排队超过一次性地址的有效期。
      queuedAudio.preload(reply.id, reply.sentences?.[0]?.audio_url || reply.audio_url)
      const next = [...queue.current, reply]
      for (const dropped of next.slice(0, -5)) queuedAudio.discard(dropped.id)
      queue.current = next.slice(-5)
      return
    }
    plan.current = { reply, index: 0, audio: new Map() }
    kick.current()
  }, [reply, stop, queuedAudio])

  useEffect(() => {
    if (!enabled) stop()
  }, [enabled, stop])

  useEffect(() => {
    if (armed) kick.current()
    else stop()
  }, [armed, stop])

  useEffect(() => {
    return () => {
      generation.current++
      window.clearTimeout(gapTimer.current)
      audio.current?.pause()
      queuedAudio.clear()
      queue.current = []
    }
  }, [queuedAudio])

  const chooseDevice = async (id: string) => {
    try {
      if (audio.current?.setSinkId) await audio.current.setSinkId(id)
      setDevice(id)
      localStorage.setItem(DEVICE_KEY, id)
      setError('')
    } catch { setError('切换播放设备失败，请检查虚拟声卡是否可用。') }
  }

  return { armed, setArmed, speaking, current, currentIndex: progress.index, total: progress.total, error, devices, device, chooseDevice, refreshDevices }
}
