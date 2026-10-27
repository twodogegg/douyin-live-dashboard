// 注入到抖音私信页执行的脚本：读取会话列表与当前对话、打开会话、发送消息。
// 从页面组件读取稳定 ID，昵称与头像取实际显示内容；失配时可用 /dm/dump 校准。
import { currentAccount } from './dm-identity.js'
import { confirmedOutgoing, deliveryContent } from './dm-delivery.js'
import { setEditorText } from './dm-editor.js'
import { mediaIdentity } from './media-data.js'

const MODEL_HELPERS = String.raw`
  const prop = (el, name) => {
    if (!el) return null;
    let fiber = el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))];
    for (let n = 0; fiber && n < 12; n++, fiber = fiber.return) {
      if (fiber.memoizedProps && fiber.memoizedProps[name] != null) return fiber.memoizedProps[name];
    }
    return null;
  };
`

// 共用：会话列表定位。左侧、子项重复、每项带头像。
const LIST_HELPERS = String.raw`
  ${MODEL_HELPERS}
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const vw = innerWidth, vh = innerHeight;
  const vis = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh;
  };
  const rectOf = el => el.getBoundingClientRect();
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  const legacyId = el => {
    const img = el.querySelector('img');
    const avatar = img ? (img.currentSrc || img.src || '') : '';
    const name = clean(el.querySelector('.conversationConversationItemtitle')?.innerText || img?.alt || el.innerText?.split('\n')[0]);
    return el.getAttribute('data-conversation-id') || el.getAttribute('data-id') || el.getAttribute('data-e2e-id')
      || 'c' + hash(avatar.split('?')[0] || name);
  };
  const convId = el => String(prop(el, 'conversation')?.id || legacyId(el));
  // 抖音私信是微前端，可能渲染在 shadow root 里：查询要穿透
  const deep = (root, sel) => {
    const out = [];
    const walk = r => {
      r.querySelectorAll(sel).forEach(e => out.push(e));
      r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); });
    };
    walk(root);
    return out;
  };
  const findItems = () => {
    const els = deep(document, 'div, ul, li');
    let listEl = null, best = 0;
    for (const el of els) {
      if (!vis(el)) continue;
      const r = rectOf(el);
      if (r.left > vw * 0.5 || r.width < 200 || r.width > 620 || r.height < 140) continue;
      const kids = [...el.children];
      if (kids.length < 2 || kids.length > 80) continue;
      let score = 0;
      for (const k of kids) {
        const kr = rectOf(k);
        if (kr.height < 36 || kr.height > 180) continue;
        if (!k.querySelector('img')) continue;
        if (clean(k.innerText).length < 2) continue;
        score++;
      }
      if (score >= 2 && score > best) { best = score; listEl = el; }
    }
    if (!listEl) return { items: [], score: 0 };
    const items = [...listEl.children].filter(k => {
      const kr = rectOf(k);
      return kr.height >= 36 && kr.height <= 180 && clean(k.innerText).length >= 2;
    });
    return { items, score: best };
  };
`

export const IM_SCAN_JS = String.raw`
() => {
  ${LIST_HELPERS}
  const out = {
    account_id: (${currentAccount})(window.userInfoStore),
    url: location.href, ok: false, conversations: [], active_idx: -1,
    active_id: '', messages: [], diag: {},
  };
  if (!/(^|\.)douyin\.com$/.test(location.hostname)) return out;

  // ---- 会话列表 ----
  // 优先用抖音自己的 data-e2e / 语义 class，失配时回落到结构化启发式
  let items = [...document.querySelectorAll('[data-e2e="conversation-item"]')];
  const exact = items.length > 0;
  if (!exact) items = findItems().items;
  out.diag.exact = exact;
  out.diag.listItems = items.length;

  const isTime = s => /^(\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d{1,2}月\d{1,2}日|\d{1,2}-\d{1,2})$/.test(s);
  const txt = (k, sel) => {
    const el = k.querySelector(sel);
    return el ? clean(el.innerText) : '';
  };

  items.forEach((k, idx) => {
    const img = k.querySelector('img');
    const avatar = img ? (img.currentSrc || img.src || '') : '';
    const cls = typeof k.className === 'string' ? k.className : '';
    let name = '';
    let preview = '';
    let timeText = '';
    let unread = 0;
    let active = false;

    if (exact) {
      name = txt(k, '.conversationConversationItemtitle');
      preview = txt(k, '.ConversationItemHinttextBox');
      timeText = txt(k, '.ConversationItemTagNextToTitletimeStr');
      const badge = k.querySelector('.ConversationItemUnReadCountim-saas-unreadCountBadge');
      unread = badge ? parseInt(clean(badge.innerText), 10) || 0 : 0;
      active = /curConversation/i.test(cls);
    } else {
      const lines = (k.innerText || '').split('\n').map(clean).filter(Boolean);
      if (!lines.length) return;
      name = img && img.alt ? clean(img.alt) : '';
      if (!name || name.length > 24) name = lines[0];
      const rest = lines.slice(1).filter(s => !isTime(s) && !/^\d{1,3}\+?$/.test(s));
      preview = rest.length ? rest[rest.length - 1] : '';
      timeText = lines.find(isTime) || '';
      active = /(active|selected|current|checked)/i.test(cls) || k.getAttribute('aria-selected') === 'true';
      for (const e of k.querySelectorAll('span, div, i, em')) {
        const t = clean(e.innerText);
        if (!/^\d{1,3}\+?$/.test(t)) continue;
        const m = (getComputedStyle(e).backgroundColor || '').match(/\d+/g);
        if (m && +m[0] > 170 && +m[1] < 130 && +m[2] < 130) { unread = parseInt(t, 10); break; }
      }
    }

    const model = prop(k, 'conversation');
    const id = convId(k);
    if (active) out.active_idx = idx;
    out.conversations.push({ idx, id, legacy_id: legacyId(k), name, avatar, preview,
      time_text: timeText, unread, is_group: model?.type === 2,
      peer_sec_uid: model?.toParticipantSecUserId || '' });
  });
  if (out.active_idx >= 0) out.active_id = out.conversations[out.active_idx].id;

  // ---- 当前对话的消息 ----
  const listEl = document.querySelector('.messageMessageListlist');
  const seen = {};
  if (listEl) {
    out.diag.exactMsgs = true;
    const lr = rectOf(listEl);
    const mid = lr.left + lr.width / 2;
    const rows = [];

    for (const b of listEl.querySelectorAll('.messageMessageBoxmessageBox')) {
      // 加入群聊/时间分隔等整行居中的系统消息，不算对话内容
      if (/isFullRowCenterMessage/.test(String(b.className || ''))) continue;

      const content = b.querySelector('[data-e2e="msg-item-content"]');
      const share = b.querySelector('.MessageItemShareAwemecontainer');
      const imageBox = b.querySelector('.MessageItemImageImageBox');
      const audioBox = b.querySelector('.MessageItemAudioaudioBoxWrapper');
      const unsupported = b.querySelector('.MessageItemUnsuportunsupport');
      const model = prop(b, 'message');
      if (model?.conversationId && out.active_id && model.conversationId !== out.active_id) continue;
      const data = model?.parsedContent || {};
      const avatar = b.querySelector('.commonIMAvataravatarContainer img');
      const sender = {
        sender_id: String(model?.sender || ''),
        sender_sec_uid: String(model?.secSender || ''),
        sender_name: clean(b.querySelector('.MessageBoxMessageTitleavatarName')?.innerText),
        sender_avatar: avatar ? (avatar.currentSrc || avatar.src || '') : '',
      };
      let kind = 'text';
      let text = '';
      let thumb = '';
      let author = '';
      let aweme_id = '';
      let video_url = '';
      let media_url = '';
      let images = [];
      let anchor = content || b;

      if (audioBox) {
        kind = 'audio';
        text = '[语音]';
        anchor = audioBox;
      } else if (share) {
        kind = Number(data.awemeType) === 68 || Number(model?.type) === 77 ? 'note' : 'video';
        const img = share.querySelector('img.MessageItemShareAwemeawemeContainer') || share.querySelector('img');
        const a = share.querySelector('.MessageItemShareAwemeauthorName');
        author = a ? clean(a.innerText) : '';
        thumb = img ? (img.currentSrc || img.src || '') : '';
        text = clean(data.content_title) || (author ? (kind === 'note' ? '分享图文 · ' : '分享视频 · ') + author : '分享作品');
        aweme_id = String(data.itemId || model?.ext?.['a:share_item_id'] || '');
        if (/^\d+$/.test(aweme_id)) video_url = 'https://www.douyin.com/' + (kind === 'note' ? 'note/' : 'video/') + aweme_id;
        anchor = share;
      } else if (b.querySelector('video, [class*="MessageItemVideo"]')) {
        const video = b.querySelector('video');
        kind = 'video';
        text = '[视频]';
        media_url = video?.currentSrc || video?.src || data.play_url?.url_list?.[0] || data.video?.play_addr?.url_list?.[0] || '';
        thumb = video?.poster || data.cover_url?.url_list?.[0] || '';
        anchor = video || content || b;
      } else if (imageBox) {
        kind = 'image';
        const img = imageBox.querySelector('img');
        const src = img ? (img.currentSrc || img.src || '') : '';
        // data URL 太大就不入库，避免每秒轮询搬运几百 KB
        thumb = src.length > 120000 ? '' : src;
        const resource = data.resource_url || {};
        media_url = [resource.origin_url_list, resource.large_url_list, resource.url_list, resource.medium_url_list, resource.thumb_url_list]
          .flatMap(urls => urls || []).find(url => /^https?:\/\//.test(url)) || (/^https?:\/\//.test(src) ? src : '');
        images = media_url ? [media_url] : [];
        text = '[图片]';
        anchor = imageBox;
      } else if (unsupported) {
        kind = 'unsupported';
        const tip = unsupported.querySelector('.MessageItemUnsuporttips') || unsupported;
        text = clean(tip.innerText) || '[暂不支持的消息]';
        anchor = unsupported;
      } else {
        text = clean(content ? content.innerText : b.innerText);
        if (!text) continue;
      }

      const r = rectOf(anchor);
      const dir = (r.left + r.width / 2) > mid ? 'out' : 'in';
      const timeEl = b.querySelector('.MessageBoxTimetimeLayout');
      const ts = model?.createdAt ? new Date(model.createdAt).getTime() / 1000 : 0;
      rows.push({ dir, kind, text, thumb, author, ...sender, aweme_id, video_url, media_url, images,
        server_confirmed: /^\d+$/.test(String(model?.serverId || '')) && String(model?.serverId) !== '0',
        client_id: String(model?.clientId || ''),
        source_id: String(model?.serverId || model?.clientId || ''), ts: Number.isFinite(ts) ? ts : 0,
        time: timeEl ? clean(timeEl.innerText) : '' });
    }

    rows.reverse(); // DOM 顺序是新→旧，反转成旧→新
    rows.forEach(r => {
      const basis = r.kind + '|' + r.text + '|' + (r.thumb ? hash(r.thumb) : '') + '|' + r.author;
      seen[basis] = (seen[basis] || 0) + 1;
      const legacy_key = r.dir + ':' + hash(basis) + ':' + seen[basis];
      out.messages.push({
        ...r,
        key: r.source_id ? 'm:' + r.source_id : legacy_key,
        legacy_key,
        fp: r.source_id || basis,
        direction: r.dir,
        kind: r.kind,
        text: r.text,
        thumb: r.thumb,
        author: r.author,
        time: r.time,
      });
    });
  } else {
    // 兜底：按气泡外观（背景色 + 圆角）识别
    const divs = deep(document, 'div').filter(el => {
      if (!vis(el)) return false;
      const r = rectOf(el);
      return r.width > 20 && r.height > 18;
    });
    let pane = null, bestPane = 0;
    for (const el of divs) {
      const r = rectOf(el);
      if (r.left < vw * 0.4 || r.width < 280 || r.height < 200) continue;
      const score = el.querySelectorAll('div').length + (el.scrollHeight > el.clientHeight + 20 ? 5 : 0);
      if (score > bestPane) { bestPane = score; pane = el; }
    }
    const paneEl = pane || document.body;
    const pr = rectOf(paneEl);
    const raw = [];
    for (const el of deep(paneEl, 'div')) {
      const r = rectOf(el);
      if (r.width < 20 || r.height < 18) continue;
      if (r.width > pr.width * 0.92) continue;
      if (el.children.length > 4) continue;
      const t = clean(el.innerText);
      if (!t || t.length > 1000) continue;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor || '';
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
      if ((parseFloat(cs.borderTopLeftRadius) || 0) < 6) continue;
      raw.push({ el, r, t });
    }
    const bubbles = raw.filter(x => !raw.some(y => y !== x && x.el.contains(y.el)));
    const mid = pr.left + pr.width / 2;
    bubbles.forEach(x => {
      const cx = x.r.left + x.r.width / 2;
      const dir = cx > mid + 16 ? 'out' : 'in';
      const basis = 'text|' + x.t + '||';
      seen[basis] = (seen[basis] || 0) + 1;
      out.messages.push({
        key: dir + ':' + hash(basis) + ':' + seen[basis],
        fp: basis,
        direction: dir,
        kind: 'text',
        text: x.t,
        thumb: '',
        author: '',
        time: '',
      });
    });
  }

  out.ok = out.conversations.length > 0 || out.messages.length > 0;
  return out;
}
`

// 按稳定 ID 查找会话，滚动虚拟列表时不依赖旧下标。
export const IM_OPEN_JS = String.raw`
async (id) => {
  ${LIST_HELPERS}
  const list = document.querySelector('.conversationConversationListwrapper');
  const original = list?.scrollTop || 0;
  if (document.querySelector('.conversationConversationInfoopen')) {
    const btn = document.querySelector('#ei-conversation-header-title-bar');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise(r => setTimeout(r, 350));
  }
  let previous = -1;
  for (let n = 0; n < 100; n++) {
    const exact = [...document.querySelectorAll('[data-e2e="conversation-item"]')];
    const el = (exact.length ? exact : findItems().items).find(e => convId(e) === id);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      return { ok: true };
    }
    if (!list) break;
    if (n === 0) list.scrollTop = 0;
    else {
      if (list.scrollTop === previous) break;
      previous = list.scrollTop;
      list.scrollTop += list.clientHeight * 0.8;
    }
    await new Promise(r => setTimeout(r, 80));
  }
  if (list) list.scrollTop = original;
  return { ok: false, msg: '没有找到这个会话，请同步后重试' };
}
`

export const IM_OPEN_MEDIA_JS = String.raw`
async (sourceId) => {
  ${MODEL_HELPERS}
  const list = document.querySelector('.messageMessageListlist');
  if (!list) return { ok: false, msg: '没有找到消息列表' };
  const reverse = getComputedStyle(list).flexDirection === 'column-reverse';
  for (let n = 0; n < 40; n++) {
    const row = [...list.querySelectorAll('.messageMessageBoxmessageBox')].find(el => {
      const message = prop(el, 'message');
      return String(message?.serverId || message?.clientId || '') === sourceId;
    });
    if (row) {
      const target = row.querySelector('.MessageItemShareAwemecontainer, .MessageItemImageImageBox, [class*="MessageItemVideo"], video, [data-e2e="msg-item-content"]');
      if (!target) break;
      target.click();
      return { ok: true };
    }
    const previous = list.scrollTop;
    list.scrollTop += Math.max(200, list.clientHeight * 0.75) * (reverse ? -1 : 1);
    await new Promise(r => setTimeout(r, 150));
    if (n > 2 && list.scrollTop === previous) break;
  }
  return { ok: false, msg: '没有找到原消息，请在抖音窗口加载这段历史后重试' };
}
`

// 旧库只有缩略图时，在原会话加载历史，按资源 ID 找回作品或原图信息。
export const IM_FIND_MEDIA_JS = String.raw`
async (message, readImage = false) => {
  ${MODEL_HELPERS}
  const identity = ${mediaIdentity.toString()};
  const scan = (${IM_SCAN_JS});
  const list = document.querySelector('.messageMessageListlist');
  if (!list) return null;
  const top = list.scrollTop;
  const reverse = getComputedStyle(list).flexDirection === 'column-reverse';
  let stalled = 0;
  try {
    list.scrollTop = 0;
    await new Promise(r => setTimeout(r, 160));
    for (let n = 0; n < 80; n++) {
      const data = scan();
      const matches = data.messages.filter(m => (message.source_id && m.source_id === message.source_id)
        || (identity(message.thumb) && identity(m.thumb) === identity(message.thumb)));
      const assets = new Set(matches.map(m => m.aweme_id || identity(m.media_url)).filter(Boolean));
      const media = (message.source_id && matches.find(m => m.source_id === message.source_id))
        || (assets.size === 1 && matches.find(m => m.aweme_id || m.media_url));
      if (media) {
        if (!readImage) return { data, media };
        if (readImage === 'audio') {
          const box = [...list.querySelectorAll('.messageMessageBoxmessageBox')].find(el => {
            const model = prop(el, 'message');
            return String(model?.serverId || model?.clientId || '') === media.source_id;
          })?.querySelector('.MessageItemAudioaudioBoxWrapper');
          if (!box) throw new Error('没有找到原语音气泡');
          box.scrollIntoView({ block: 'nearest' });
          const originalPlay = HTMLMediaElement.prototype.play;
          let player, timer;
          try {
            const source = new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error('原语音加载失败，请在抖音打开原消息后重试')), 15000);
              HTMLMediaElement.prototype.play = function () {
                if (!player && this.tagName === 'AUDIO') { player = this; resolve(this.currentSrc || this.src); }
                return Promise.resolve();
              };
              box.click();
            });
            const url = await source;
            if (!url.startsWith('blob:')) throw new Error('未取得抖音解密后的原语音');
            const blob = await (await fetch(url)).blob();
            if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error('语音为空或超过 20 MB');
            const inline = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            return { data, media, inline };
          } finally {
            clearTimeout(timer);
            HTMLMediaElement.prototype.play = originalPlay;
            if (player) player.pause();
            box.click();
          }
        }
        const findBox = () => [...list.querySelectorAll('.messageMessageBoxmessageBox')].find(el => {
          const model = prop(el, 'message');
          return String(model?.serverId || model?.clientId || '') === media.source_id;
        })?.querySelector('.MessageItemImageImageBox');
        findBox()?.scrollIntoView({ block: 'nearest' });
        // 私信图片由抖音原生组件解密，不能把加密 CDN 文件直接交给浏览器显示。
        // 滚动后虚拟列表可能重建节点，每次等待都按消息 ID 重新查找。
        for (let i = 0; i < 100; i++) {
          const image = findBox()?.querySelector('img');
          if (image?.loading === 'lazy') image.loading = 'eager';
          const src = image?.currentSrc || image?.src || '';
          if (image?.complete && image.naturalWidth && /^https?:\/\//.test(src)) return { data, media, inline: src };
          if (image?.complete && image.naturalWidth && /^(data:image\/|blob:)/.test(src)) {
            const blob = await (await fetch(src)).blob();
            const inline = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            return { data, media, inline };
          }
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('原图片尚未加载，将稍后重试');
      }
      const previous = list.scrollTop;
      list.scrollTop += Math.max(200, list.clientHeight * 0.8) * (reverse ? -1 : 1);
      await new Promise(r => setTimeout(r, 160));
      stalled = previous === list.scrollTop ? stalled + 1 : 0;
      if (stalled >= 8) break;
    }
    return null;
  } finally { list.scrollTop = top; }
}
`

// 写入并发送。发送后校验文本确实出现在页面上。
export const IM_SEND_UPLOADED_JS = String.raw`
async (expectedId, beforeCount) => {
  const scan = () => (${IM_SCAN_JS})();
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clickSend = () => {
    const btn = document.querySelector('.messageMsgInputpublishBtn, .e2e-send-msg-btn')
      || [...document.querySelectorAll('button, div, span')].find(e => {
        const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
        return (t === '发送' || t === 'Send') && e.offsetParent !== null && e.children.length <= 3;
      });
    if (!btn) return false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  };
  const before = scan();
  if (!before.ok || before.active_id !== expectedId) return { ok: false, outcome: 'failed', msg: '会话已切换，已取消发送图片' };
  if ((before.messages || []).length < beforeCount) return { ok: false, outcome: 'failed', msg: '图片还未出现在待发送区，请稍后重试' };
  if (!clickSend()) return { ok: false, outcome: 'unknown', msg: '没有找到发送按钮，图片已放入输入框，请在抖音窗口确认发送' };
  for (let n = 0; n < 12; n++) {
    await wait(500);
    const after = scan();
    if (after.active_id !== expectedId) break;
    if ((after.messages || []).length > beforeCount) {
      const added = after.messages.slice(beforeCount);
      if (added.some(m => m.direction === 'out' && m.kind === 'image')) return { ok: true, outcome: 'confirmed' };
    }
  }
  return { ok: false, outcome: 'unknown', msg: '图片发送结果未确认，请在抖音窗口核对；不会自动重发' };
}
`

export const IM_SEND_JS = String.raw`
async (text, expectedId, account) => {
  ${MODEL_HELPERS}
  const writeEditor = ${setEditorText};
  const deliveryContent = ${deliveryContent};
  const scan = () => {
    const snapshot = (${IM_SCAN_JS})();
    snapshot.messages = snapshot.messages.map(m => ({ ...m, direction: m.sender_id ? String(m.sender_id) === account ? 'out' : 'in' : m.direction }));
    return snapshot;
  };
  const before = scan();
  if (!before.ok || before.active_id !== expectedId) return { ok: false, outcome: 'failed', msg: '会话已切换，已取消发送' };
  const receipt = ${confirmedOutgoing};
  const started = Date.now();
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(e => e.offsetParent !== null && !e.disabled && !e.readOnly);
  const box = boxes.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!box) return { ok: false, outcome: 'failed', msg: '没找到私信输入框' };

  box.focus();
  const editor = prop(box, 'editor');
  if (box.hasAttribute('data-slate-editor')) {
    if (!writeEditor(editor, text)) return { ok: false, outcome: 'failed', msg: '原生编辑器未完整写入回复，已取消发送' };
  } else if (box.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, text);
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  await wait(300);

  const latest = scan();
  if (latest.active_id !== expectedId || latest.messages.at(-1)?.key !== before.messages.at(-1)?.key) return { ok: false, outcome: 'failed', msg: '对话已更新，已取消旧回复' };

  // 优先点私信的发送按钮，找不到再用回车
  const btn = document.querySelector('.messageMsgInputpublishBtn, .e2e-send-msg-btn')
    || [...document.querySelectorAll('button, div, span')].find(e => {
      const t = clean(e.innerText);
      return (t === '发送' || t === 'Send') && e.offsetParent !== null && e.children.length <= 3;
    });
  if (btn) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  } else {
    for (const type of ['keydown', 'keyup']) {
      box.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
  }

  for (let n = 0; n < 10; n++) {
    await wait(400);
    const after = scan();
    if (after.active_id !== expectedId) break;
    const confirmed = receipt(before, after, text, started);
    if (confirmed) return { ok: true, outcome: 'confirmed', source_id: confirmed.source_id, partial: !!confirmed.partial };
  }
  return { ok: false, outcome: 'unknown', msg: '发送结果未确认，请在抖音窗口核对；不会自动重发' };
}
`

// 校准用：导出私信页面上可见的结构骨架
export const IM_DUMP_JS = String.raw`
() => {
  ${MODEL_HELPERS}
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  const walk = (el, depth) => {
    if (depth > 14 || lines.length > 900) return;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const own = clean(el.childElementCount ? '' : el.textContent).slice(0, 40);
    lines.push(
      '  '.repeat(depth) + '<' + el.tagName.toLowerCase() + '> '
      + 'cls=' + (typeof el.className === 'string' ? el.className.slice(0, 60) : '')
      + ' box=' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height)
      + (own ? ' text=' + own : '')
    );
    for (const c of el.children) walk(c, depth + 1);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  const images = [...document.querySelectorAll('.MessageItemImageImageBox')].map(box => {
    const model = prop(box.closest('.messageMessageBoxmessageBox'), 'message');
    const image = box.querySelector('img');
    return { source_id: String(model?.serverId || model?.clientId || ''),
      complete: image?.complete, width: image?.naturalWidth, loading: image?.loading,
      source_type: (image?.currentSrc || image?.src || '').split(':')[0],
      children: [...box.children].map(el => el.tagName) };
  });
  return { url: location.href, title: document.title, tree: lines.join('\n'), images };
}
`

// 群信息：打开右侧群资料面板
export const IM_OPEN_INFO_JS = String.raw`
() => {
  const panel = document.querySelector('.conversationConversationInfowrapper');
  if (panel?.classList.contains('conversationConversationInfoopen')) return { ok: true, already: true };
  const btn = document.querySelector('#ei-conversation-header-title-bar')
    || document.querySelector('.RightPanelHeadertitleBarContainer');
  if (!btn) return { ok: false, msg: '没找到群信息入口' };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return { ok: true, already: false };
}
`

// 读取群名、人数与成员列表
export const IM_GROUP_JS = String.raw`
async () => {
  ${MODEL_HELPERS}
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const panel = document.querySelector('.conversationConversationInfowrapper');
  if (!panel?.classList.contains('conversationConversationInfoopen')) return { ok: false, group: false, msg: '群信息面板未打开' };

  const countEl = panel.querySelector('.GroupParticipantsoverviewcount');
  const titleEl = document.querySelector('.RightPanelHeadertitle');
  let name = titleEl ? clean(titleEl.innerText) : '';
  name = name.replace(/[（(]\d+[)）]\s*$/, '').trim();

  if (!countEl) return { ok: true, group: false, name, members: [] };
  const count = clean(countEl.innerText);
  const total = parseInt(count, 10) || 0;
  if (!panel.querySelector('.GroupParticipantsdetailparticipantsArea')) {
    panel.querySelector('.GroupParticipantsoverviewheaderArea')?.click();
  }
  let list;
  for (let n = 0; n < 20; n++) {
    list = panel.querySelector('.GroupParticipantsdetailparticipantsArea');
    if (list) break;
    await wait(100);
  }
  if (!list) return { ok: false, msg: '无法展开全部群成员，请在抖音窗口检查群权限' };
  await wait(350);
  const members = new Map();
  for (let pass = 0; pass < 2; pass++) {
    list.scrollTop = 0;
    let stalled = 0;
    for (let n = 0; n < 200; n++) {
      await wait(pass === 0 ? 120 : 180);
      if (pass === 1) {
        for (let retry = 0; retry < 10; retry++) {
          if ([...list.querySelectorAll('.detailitemcontainer')].every(el => clean(el.querySelector('.detailitemname')?.innerText))) break;
          await wait(100);
        }
      }
      for (const el of list.querySelectorAll('.detailitemcontainer')) {
        const member = prop(el, 'participant');
        const img = el.querySelector('img');
        if (!member?.userId || !member.secUid) continue;
        const id = String(member.userId);
        members.set(id, { id, sec_uid: member.secUid,
          name: clean(el.querySelector('.detailitemname')?.innerText) || members.get(id)?.name || '',
          avatar: img ? (img.currentSrc || img.src || '') : '', role: member.role });
    }
    if (total && members.size >= total && [...members.values()].every(m => m.name)) break;
    const previous = list.scrollTop;
    list.scrollTop += Math.max(100, list.clientHeight * 0.75);
    stalled = list.scrollTop === previous ? stalled + 1 : 0;
    if (stalled >= 10) break;
    }
    if (total && members.size >= total && [...members.values()].every(m => m.name)) break;
  }
  list.scrollTop = 0;
  return { ok: true, group: true, name, count, total, complete: members.size >= total,
    members: [...members.values()] };
}
`

