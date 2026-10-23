// 调度与页面操作解耦，所有发送前重新检查配置、消息和人工接管状态。
export class DmAutoReply {
  constructor(io) {
    this.io = io
    this.pending = new Map()
    this.dirty = new Map()
    this.reset()
  }

  reset() {
    this.pending.clear()
    this.reads = new Set()
    this.snapshots = new Map()
    this.seen = new Set()
    this.baseline = false
    this.since = this.io.now()
  }

  allowed(id) {
    const c = this.io.conv(id)
    return this.io.running() && this.io.config().enabled && c && !c.is_group && !this.io.memory(id).blocked
  }

  cancel(id) {
    this.pending.delete(id)
  }

  observe(data, inserted) {
    const now = this.io.now()
    for (const m of inserted) this.dirty.set(m.conv_id, this.dirty.get(m.conv_id) ?? now + 5000)
    for (const c of data.conversations || []) {
      const prev = this.snapshots.get(c.id)
      if (c.id !== data.active_id && c.unread > 0
        && (!prev || c.preview !== prev.preview || c.unread > prev.unread || c.time_text !== prev.time_text)) {
        this.reads.add(c.id)
        if (this.baseline) this.enqueue(c.id, now)
      }
      this.snapshots.set(c.id, { ...c })
    }
    const id = data.active_id
    const latest = data.messages?.at(-1)
    if (id && latest) {
      if (latest.direction === 'out') this.cancel(id)
      else if (this.seen.has(id) && inserted.some(m => m.conv_id === id && m.direction === 'in' && m.ts * 1000 >= this.since)) this.enqueue(id, now)
      this.seen.add(id)
    }
    this.baseline = true
  }

  enqueue(id, now) {
    if (!this.allowed(id)) return
    this.pending.set(id, { due: now + this.io.config().reply_delay * 1000 })
  }

  async tick() {
    if (this.busy || !this.io.running() || !this.io.hasKey()) return
    this.busy = true
    try {
      const now = this.io.now()
      for (const [id, item] of this.pending) {
        if (!this.allowed(id)) { this.cancel(id); continue }
        const conf = this.io.config()
        const last = this.io.memory(id).last_reply_at
        if (now < Math.max(item.due, last + conf.reply_interval * 1000, (this.lastSend || 0) + conf.global_interval * 1000)) continue
        const result = await this.io.reply(id, () => this.allowed(id) && this.pending.get(id) === item)
        if (result?.retry && this.pending.get(id) === item && this.allowed(id) && (item.retries || 0) < 3) {
          item.retries = (item.retries || 0) + 1
          item.due = this.io.now() + 5000 * item.retries
          return
        }
        if (result?.retry && this.pending.get(id) === item && (item.retries || 0) >= 3) this.io.error(`${result.msg || '自动回复失败'}；已重试 3 次，暂停本次任务`)
        // 新消息可能已替换此任务，保留下一轮需要回复的内容。
        if (this.pending.get(id) === item) this.cancel(id)
        return
      }
      const readId = this.reads.values().next().value
      if (readId) {
        this.reads.delete(readId)
        await this.io.read(readId)
        return
      }
      const entry = [...this.dirty].find(([, due]) => due <= now)
      if (entry) {
        const [id] = entry
        this.dirty.delete(id)
        try {
          if (await this.io.summarize(id)) this.dirty.set(id, now + 5000)
        } catch (e) {
          this.dirty.set(id, now + 60000)
          this.io.error(`会话记忆更新失败：${e.message || e}`)
        }
      }
    } catch (e) {
      this.io.error(`自动回复失败：${e.message || e}`)
    } finally {
      this.busy = false
    }
  }
}
