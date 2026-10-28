// 礼物、关注与进房事件的统一解析层。
// 抖音网页的礼物提示文案会随版本变化，这里用「可配置的文案模式表」解析，
// 而不是写死某一段选择器：抓到的原文先归一化，再按模式表匹配出礼物名和数量。
// 任何匹配不上的候选会作为 unknown 原样交给调用方记录，便于开播后校准。

// 常见礼物的价值档位（抖币）。只用于判断「是否大礼物」，不影响是否感谢。
// 未收录的礼物按 1 处理，仍会感谢，只是不会触发聚光状态。
const GIFT_VALUE = {
  小心心: 1,
  玫瑰: 1,
  棒棒糖: 1,
  点赞: 1,
  大拇哥: 1,
  比心: 1,
  爱心: 1,
  鼓掌: 1,
  音符: 1,
  繁星: 1,
  小酌: 1,
  粉丝团灯牌: 1,
  干杯: 2,
  鲜花: 5,
  拥抱: 5,
  告白: 10,
  加油鸭: 10,
  吃蛋糕: 20,
  甜甜圈: 20,
  爱心星球: 52,
  跑车: 1200,
  火箭: 3000,
  飞机: 3000,
  皇冠: 5000,
  热气球: 520,
  人气票: 1,
  抖音1号: 10001,
  嘉年华: 30000,
  至尊礼炮: 30000,
  宇宙之心: 18888,
  马车: 12000,
  星辰大海: 15000,
}

// 文案模式表。顺序有意义：越具体的排前面，避免「关注了主播」被当成普通消息，
// 也要把「送出了」排在「送出」前面，否则「了」会被当成礼物名。
// name 组是礼物名，count 组是「×N」「xN」中的数量。
export const DEFAULT_PATTERNS = [
  // 常见：海盐 送出了 小心心 ×5
  { kind: 'gift', re: /^(?<user>.{1,60}?)\s*(?:送出了|送出|送给主播|赠送了|赠送|送上了|送上)\s*(?<name>[^\s×xX*]{1,20})\s*(?:[×xX*]\s*(?<count>\d{1,4}))?\s*(?:个)?\s*$/ },
  // 海盐 投喂了 小心心 ×5
  { kind: 'gift', re: /^(?<user>.{1,60}?)\s*(?:投喂了|投喂)\s*(?<name>[^\s×xX*]{1,20})\s*(?:[×xX*]\s*(?<count>\d{1,4}))?\s*$/ },
  // 榜单形态：海盐的 小心心 ×5
  { kind: 'gift', re: /^(?<user>.{1,60}?)的\s*(?<name>[^\s×xX*]{1,20})\s*[×xX*]\s*(?<count>\d{1,4})\s*$/ },
  // 兜底形态：海盐 送出了小心心
  { kind: 'gift', re: /^(?<user>.{1,60}?)\s*(?:送出|送给主播|赠送|送上)\s*(?<name>[^\s×xX*]{1,20})\s*(?:[×xX*]\s*(?<count>\d{1,4}))?\s*$/ },
  { kind: 'follow', re: /^(?<user>.{1,60}?)\s*(?:关注了主播|关注了你|关注了直播间|成为粉丝|加入了粉丝团)/ },
  { kind: 'join', re: /^(?<user>.{1,60}?)\s*(?:进入了直播间|进入直播间|来到了直播间|来了)/ },
]

const clean = value => String(value || '').replace(/\s+/g, ' ').trim()

// 昵称不可能包含这些成分：出现就说明匹配到的是普通聊天句子，不是事件提示。
// 抖音的事件提示总是「昵称 + 事件短语」的短结构，句子很少超过 24 个字。
const NOT_A_NAME = /[，,。！？!?、；;：:]|我觉得|刚才|好像|是不是|然后|所以|因为|如果|他说|她说/
const MAX_NAME = 24

// 抖音在礼物名后面常带「×1」以外的后缀，以及粉丝团/等级徽章占位，这里一并清掉。
const tidyName = value => clean(value).replace(/[，,。.!！]+$/, '').replace(/^["'“”]|["'“”]$/g, '').trim()

export function giftValue(name) {
  return GIFT_VALUE[name] ?? 1
}

/**
 * 解析一条房间事件的文本。
 * @param {string} text 页面上的原始提示文案
 * @param {object} options
 * @param {Array} options.patterns 自定义模式表，默认使用 DEFAULT_PATTERNS
 * @param {string} options.user 页面上单独取到的昵称，优先于文案里解析出的名字
 * @returns {{kind:'gift'|'follow'|'join', user:string, gift:string, count:number, value:number, text:string} | null}
 */
export function parseRoomEvent(text, { patterns = DEFAULT_PATTERNS, user = '' } = {}) {
  const full = clean(text)
  if (!full) return null
  for (const pattern of patterns) {
    if (!pattern || typeof pattern.re !== 'string' && !(pattern.re instanceof RegExp)) continue
    const re = pattern.re instanceof RegExp ? pattern.re : new RegExp(pattern.re)
    const match = full.match(re)
    if (!match?.groups) continue
    const nick = clean(user || match.groups.user || '').replace(/[:：]$/, '')
    // 昵称要像一个昵称：长度受限，且不含句子成分，否则说明命中的是普通聊天。
    if (!nick || nick.length > MAX_NAME || NOT_A_NAME.test(nick)) return null
    if (pattern.kind === 'gift') {
      const gift = tidyName(match.groups.name)
      if (!gift || gift.length > 30) return null
      const raw = Number.parseInt(match.groups.count || '1', 10)
      const count = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 9999) : 1
      return { kind: 'gift', user: nick, gift, count, value: giftValue(gift) * count, text: full }
    }
    if (pattern.kind === 'follow') return { kind: 'follow', user: nick, gift: '', count: 1, value: 0, text: full }
    if (pattern.kind === 'join') return { kind: 'join', user: nick, gift: '', count: 1, value: 0, text: full }
  }
  return null
}

// 事件优先级：数值越大越先处理。礼物与关注可以打断普通聊天与正在进行的回复。
export function eventPriority(event) {
  if (!event) return 0
  if (event.kind === 'gift') return event.value >= 1000 ? 40 : event.value >= 100 ? 30 : 20
  if (event.kind === 'follow') return 15
  if (event.kind === 'join') return 5
  return 0
}

// 同一观众的连续礼物合并：5 秒内同一个人连刷，合并成一次感谢并累加数量，
// 避免「谢谢小心心」「谢谢小心心」「谢谢小心心」三连。
export function mergeGift(previous, event, now, windowMs = 5000) {
  if (!previous || previous.kind !== 'gift' || event.kind !== 'gift') return null
  if (previous.user !== event.user) return null
  if (previous.gift !== event.gift) return null
  if (now - previous.last_ts > windowMs) return null
  return { ...previous, count: previous.count + event.count, value: previous.value + event.value, last_ts: now }
}
