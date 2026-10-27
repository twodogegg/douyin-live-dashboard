import { useCallback, useEffect, useRef, useState } from 'react'
import type { StageReply } from '../types'

type RoutedAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
const DEVICE_KEY = 'live-stage-audio-output'

export function useStagePlayback(reply: StageReply | null, enabled: boolean) {
  const [armed, setArmed] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [current, setCurrent] = useState<StageReply | null>(null)
  const [error, setError] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState(() => localStorage.getItem(DEVICE_KEY) || 'default')
  const audio = useRef<RoutedAudio | null>(null)
  const queue = useRef<StageReply[]>([])
  const running = useRef(false)
  const generation = useRef(0)
  const config = useRef({ armed, device })
  const seen = useRef(new Set<string>())
  const kick = useRef<() => void>(() => {})
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
    if (audio.current) {
      audio.current.onended = null
      audio.current.onerror = null
      audio.current.pause()
      audio.current.removeAttribute('src')
      audio.current.load()
      audio.current = null
    }
    running.current = false
    setSpeaking(false)
    setCurrent(null)
  }, [])

  const playNext = useCallback(async () => {
    if (running.current || !queue.current.length || !config.current.armed) return
    const next = queue.current.shift()!
    const token = generation.current
    setCurrent(next)
    if (!next.audio_url) { kick.current(); return }
    running.current = true
    const player = new Audio(next.audio_url) as RoutedAudio
    audio.current = player
    const finish = (message = '') => {
      if (token !== generation.current) return
      if (message) setError(message)
      running.current = false
      audio.current = null
      setSpeaking(false)
      kick.current()
    }
    player.onended = () => finish()
    player.onerror = () => finish('音频加载失败，请重新试播。')
    try {
      const selected = config.current.device
      if (selected !== 'default' && !player.setSinkId) throw new Error('当前浏览器不支持选择播放设备，请使用桌面端或 Chrome。')
      if (player.setSinkId) await player.setSinkId(selected)
      if (token !== generation.current) return
      await player.play()
      if (token !== generation.current) { player.pause(); return }
      setError('')
      setSpeaking(true)
    } catch (e) {
      if (token !== generation.current) return
      player.pause()
      running.current = false
      audio.current = null
      setArmed(false)
      setSpeaking(false)
      setError(e instanceof Error ? `播放失败：${e.message}` : '播放失败，请检查输出设备并重新启用语音。')
    }
  }, [])
  kick.current = () => { void playNext() }

  useEffect(() => {
    if (!reply) { stop(); return }
    if (seen.current.has(reply.id)) return
    seen.current.add(reply.id)
    if (seen.current.size > 300) seen.current.delete(seen.current.values().next().value!)
    // 语音关闭期间只更新气泡，重新开启时不追播旧回复。
    if (!reply.audio_url || !config.current.armed) { setCurrent(reply); return }
    queue.current = [...queue.current, reply].slice(-5)
    kick.current()
  }, [reply, stop])

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
      audio.current?.pause()
      queue.current = []
    }
  }, [])

  const chooseDevice = async (id: string) => {
    try {
      if (audio.current?.setSinkId) await audio.current.setSinkId(id)
      setDevice(id)
      localStorage.setItem(DEVICE_KEY, id)
      setError('')
    } catch { setError('切换播放设备失败，请检查虚拟声卡是否可用。') }
  }

  return { armed, setArmed, speaking, current, error, devices, device, chooseDevice, refreshDevices }
}
