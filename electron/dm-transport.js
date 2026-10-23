/**
 * 接入层只负责消息规范化、存储和事件发布。AI 和调度只订阅此层的结果。
 * Message: platform, account_id, conv_id, source_id, sender_id, direction,
 *          ts, kind, text, media_ref。平台 ID 用字符串保留 64 位精度。
 * Transport: start(), stop(), send(convId, text, guard), status(), receive(message)。
 */
export class DmMessageGateway {
  constructor({ save, read, publish, account }) {
    Object.assign(this, { save, read, publish, account })
  }

  receive(message, legacyKey = '') {
    const account = this.account()
    if (!account || !message.conv_id.startsWith(`douyin:${account}:`)) throw new Error('消息账号不匹配')
    if (!['in', 'out'].includes(message.direction)) throw new Error('消息方向未确认')
    let row = { ...message, platform: 'douyin', account_id: account }
    const result = this.save(row, legacyKey)
    row = this.read(row.key) || row
    if (result) this.publish({ type: result.inserted ? 'dm_msg' : 'dm_msg_update', old_key: result.old_key, conv_id: row.conv_id, msg: row })
    return { row, result }
  }
}

export class MessageComparison {
  constructor() { this.reset() }
  reset() { this.ids = new Map(); this.browser = 0; this.protocol = 0; this.matched = 0 }
  observe(key, source) {
    const mask = this.ids.get(key) || 0
    const bit = source === 'browser' ? 1 : 2
    if (mask & bit) return
    this[source]++
    if (mask) this.matched++
    this.ids.set(key, mask | bit)
    if (this.ids.size > 5000) this.ids.delete(this.ids.keys().next().value)
  }
  status() { return { browser: this.browser, protocol: this.protocol, matched: this.matched } }
}
