// 注入到抖音私信页执行的脚本：读取会话列表与当前对话、打开会话、发送消息。
// 抖音 web 私信的 class 名是混淆的，这里全部用「结构 + 几何」启发式定位，
// 不依赖具体 class；失配时由 /dm/dump 导出页面结构再校准。

// 共用：会话列表定位。左侧、子项重复、每项带头像。
const LIST_HELPERS = String.raw`
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const vw = innerWidth, vh = innerHeight;
  const vis = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh;
  };
  const rectOf = el => el.getBoundingClientRect();
  const hash = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
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

    const raw = k.getAttribute('data-conversation-id') || k.getAttribute('data-id')
      || k.getAttribute('data-e2e-id') || '';
    // 头像 URL 的签名参数会过期，去掉 query 后再做哈希，保证同一会话 id 稳定
    const id = raw || 'c' + hash(((avatar || '').split('?')[0] || name));
    if (active) out.active_idx = idx;
    out.conversations.push({ idx, id, name, avatar, preview, time_text: timeText, unread });
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
      const unsupported = b.querySelector('.MessageItemUnsuportunsupport');
      let kind = 'text';
      let text = '';
      let thumb = '';
      let author = '';
      let anchor = content || b;

      if (share) {
        kind = 'video';
        const img = share.querySelector('img.MessageItemShareAwemeawemeContainer') || share.querySelector('img');
        const a = share.querySelector('.MessageItemShareAwemeauthorName');
        author = a ? clean(a.innerText) : '';
        thumb = img ? (img.currentSrc || img.src || '') : '';
        text = author ? '分享视频 · ' + author : '分享视频';
        anchor = share;
      } else if (imageBox) {
        kind = 'image';
        const img = imageBox.querySelector('img');
        const src = img ? (img.currentSrc || img.src || '') : '';
        // data URL 太大就不入库，避免每秒轮询搬运几百 KB
        thumb = src.length > 120000 ? '' : src;
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
      rows.push({ dir, kind, text, thumb, author, time: timeEl ? clean(timeEl.innerText) : '' });
    }

    rows.reverse(); // DOM 顺序是新→旧，反转成旧→新
    rows.forEach(r => {
      const basis = r.kind + '|' + r.text + '|' + (r.thumb ? hash(r.thumb) : '') + '|' + r.author;
      seen[basis] = (seen[basis] || 0) + 1;
      out.messages.push({
        key: r.dir + ':' + hash(basis) + ':' + seen[basis],
        fp: basis,
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

// 点击第 idx 个会话，切到对应对话
export const IM_OPEN_JS = String.raw`
(idx) => {
  ${LIST_HELPERS}
  const exact = [...document.querySelectorAll('[data-e2e="conversation-item"]')];
  const el = (exact.length ? exact : findItems().items)[idx];
  if (!el) return { ok: false, msg: '会话列表项不存在，页面可能还没加载完' };
  el.scrollIntoView({ block: 'nearest' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return { ok: true, count: exact.length, cls: String(el.className || '').slice(0, 60) };
}
`

// 写入并发送。发送后校验文本确实出现在页面上。
export const IM_SEND_JS = String.raw`
async (text) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter(e => e.offsetParent !== null && !e.disabled && !e.readOnly);
  const box = boxes.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!box) return { ok: false, msg: '没找到私信输入框' };

  box.focus();
  if (box.tagName === 'TEXTAREA') {
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

  await wait(800);
  const left = box.tagName === 'TEXTAREA' ? box.value : (box.innerText || '');
  const appeared = (document.body.innerText || '').includes(text);
  if (!appeared) {
    return { ok: false, msg: clean(left) ? '文本还在输入框里，发送未成功' : '没有检测到发送成功' };
  }
  return { ok: true };
}
`

// 校准用：导出私信页面上可见的结构骨架
export const IM_DUMP_JS = String.raw`
() => {
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
  return { url: location.href, title: document.title, tree: lines.join('\n') };
}
`

// 群信息：打开右侧群资料面板
export const IM_OPEN_INFO_JS = String.raw`
() => {
  const panel = document.querySelector('.conversationConversationInfowrapper');
  if (panel && panel.getBoundingClientRect().width > 100) return { ok: true, already: true };
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
() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const panel = document.querySelector('.conversationConversationInfowrapper');
  if (!panel || panel.getBoundingClientRect().width < 100) return { ok: false, group: false, msg: '群信息面板未打开' };

  const countEl = panel.querySelector('.GroupParticipantsoverviewcount');
  const titleEl = document.querySelector('.RightPanelHeadertitle');
  let name = titleEl ? clean(titleEl.innerText) : '';
  name = name.replace(/[（(]\d+[)）]\s*$/, '').trim();

  const members = [];
  panel.querySelectorAll('.GroupParticipantsoverviewcontentArea .overviewitemcontainer').forEach((el, idx) => {
    const nm = el.querySelector('.overviewitemname');
    const img = el.querySelector('img');
    members.push({
      idx,
      name: nm ? clean(nm.innerText) : '',
      avatar: img ? (img.currentSrc || img.src || '') : '',
    });
  });

  return {
    ok: true,
    group: !!countEl || members.length > 0,
    name,
    count: countEl ? clean(countEl.innerText) : '',
    members,
  };
}
`

// 点击群成员头像（会在独立窗口打开其主页）
export const IM_MEMBER_DM_JS = String.raw`
(idx) => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const items = [...document.querySelectorAll('.GroupParticipantsoverviewcontentArea .overviewitemcontainer')];
  const el = items[idx];
  if (!el) return { ok: false, msg: '成员不存在' };
  const nm = el.querySelector('.overviewitemname');
  const target = el.querySelector('.semi-avatar') || el.querySelector('[data-apm-action]') || el;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return { ok: true, name: nm ? clean(nm.innerText) : '' };
}
`

