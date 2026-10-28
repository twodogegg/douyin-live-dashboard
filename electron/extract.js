// 注入到抖音直播页执行的脚本。逻辑与 douyin_live_scraper.py / live_server.py 保持一致。

// 给 DOM 节点分配稳定 id，用于判断「同一条消息是否更新」（流式输出 / 节点复用）
export const EXTRACT_JS = String.raw`
() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  // 昵称归一化：去掉榜单名次前缀（"5 "）、徽章占位（"- "）、尾部分数（" 734"），
  // 让「观众/麦位」卡片上的昵称能跟消息里的昵称对上
  const norm = s => clean(s).replace(/^\d+\s+/, '').replace(/^[-–—]\s*/, '').replace(/\s+\d+$/, '').trim();
  const parse = el => {
    const c = Array.from(el.children);
    if (c.length === 2 && /[:：]\s*$/.test(clean(c[0].textContent)) && clean(c[1].textContent))
      return { user: clean(c[0].textContent).replace(/[:：]$/, ''), text: clean(c[1].textContent) };
    return { user: '', text: clean(el.textContent) };
  };

  if (!window.__dy) window.__dy = {
    seq: 0, ids: new WeakMap(),                 // 区域2 元素 -> 稳定 id
    line: new WeakMap(), lineSeq: 0,           // 区域1 元素 -> 行号
    freed: {},                                 // 用户 -> [{line, b}] 刚被删掉、等待被同批次新元素继承的行
    users: new WeakMap(), batch: 0, container: null, obs: null,
  };
  const S = window.__dy;

  // 动态定位公屏浮层容器：子节点形如 <div>用户名:</div><div>内容</div>
  const findContainer = () => {
    const lm = document.querySelector('#LinkMicLayout');
    if (!lm) return null;
    let best = null, bestScore = 0;
    lm.querySelectorAll('div').forEach(el => {
      const kids = Array.from(el.children);
      if (!kids.length || kids.length > 80) return;
      let score = 0;
      kids.forEach(k => {
        const c = Array.from(k.children);
        if (c.length === 2 && /[:：]\s*$/.test(clean(c[0].textContent)) && clean(c[1].textContent)) score++;
      });
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return best;
  };

  // 监听容器的增删。实测（探针）：抖音改写「同一行」时，会在**同一次变更**里
  // 删掉旧元素、插入承载新文本的元素；而「换一句」时旧行先被删除，新行在**之后的变更**里
  // 才出现。所以「删掉的旧行」与「新元素」同批次 ⇒ 同一行继承行号，否则 ⇒ 新的一行。
  const attach = () => {
    const c = findContainer();
    if (!c || c === S.container) return;
    S.container = c;
    if (S.obs) S.obs.disconnect();
    S.obs = new MutationObserver(muts => {
      S.batch++;
      // 只保留上一批之后的候配项，避免久置的旧行被后来的新句误继承
      for (const u in S.freed) S.freed[u] = S.freed[u].filter(x => x.b >= S.batch - 1);
      muts.forEach(m => {
        m.removedNodes.forEach(n => {
          const ln = S.line.get(n);
          if (ln == null) return;                      // 挂观察之前就存在的元素，忽略
          const u = S.users.get(n) || '';
          (S.freed[u] || (S.freed[u] = [])).push({ line: ln, b: S.batch });
        });
        m.addedNodes.forEach(n => {
          // 必须在这里当场配对：元素存活时间常短于一次轮询，
          // 等到轮询时它已经从 S.line 里消失，就再也继承不到行号了。
          const p = parse(n);                          // 实测插入瞬间内容已填好，可直接取昵称
          S.users.set(n, p.user);
          const pool = S.freed[p.user] || [];
          // 同一次变更优先；少数改写会把「删旧」和「插新」分成相邻两次变更，故再放宽一批
          let k = pool.findIndex(x => x.b === S.batch);
          if (k < 0) k = pool.findIndex(x => x.b === S.batch - 1);
          let ln;
          if (k >= 0) { ln = pool[k].line; pool.splice(k, 1); }
          else ln = ++S.lineSeq;
          S.line.set(n, ln);
        });
      });
    });
    S.obs.observe(c, { childList: true });
  };
  attach();

  const idOf = el => {
    let v = S.ids.get(el);
    if (!v) { v = ++S.seq; S.ids.set(el, v); }
    return v;
  };

  // 礼物只从直播连接的结构化消息识别，不能把观众手打的文字当成真实礼物。
  const eventSelector = '.webcast-chatroom___item, .webcast-chatroom___bottom-message, .webcast-chatroom___bottom_message';
  const eventPattern = /^(.*?)\s*(进入了直播间|进入直播间|来到了直播间|来了|关注了主播|关注了你|关注了直播间|成为粉丝|加入了粉丝团)[！!。]?$/;
  const roomEvent = el => {
    // 平台公告与主播本人消息都不是观众事件。
    if (el.querySelector('.webcast-chatroom__room-message, img[src*="webcast_anchor_badge"]')) return null;
    // 普通聊天即使提到关注或送礼，也不是平台发出的事件提示。
    if (el.querySelector('.cL385mHb')) return null;
    const full = clean(el.innerText || el.textContent);
    if (!full) return null;
    const match = full.match(eventPattern);
    if (!match) return null;
    const verb = match[2];
    const name = el.querySelector('.v8LY0gZF, [data-e2e="user-name"], [class*="nickname"], [class*="userName"]');
    const user = clean(name?.textContent || match[1]).replace(/[:：]$/, '');
    if (!user || user.length > 80) return null;
    return { kind: verb.startsWith('关注') || verb === '成为粉丝' || verb === '加入了粉丝团' ? 'follow' : 'join', user: user, text: full };
  };
  if (!S.eventQueue) {
    S.eventQueue = [];
    S.eventValues = new WeakMap();
    S.eventRecent = new Map();
    const scan = (node, emit = true) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return;
      const roots = new Set([el.closest(eventSelector), ...el.querySelectorAll(eventSelector)]);
      roots.forEach(root => {
        if (!root) return;
        const event = roomEvent(root);
        const signature = event ? JSON.stringify([event.kind, event.user]) : '';
        if (S.eventValues.get(root) === signature) return;
        S.eventValues.set(root, signature);
        if (!event) return;
        const now = Date.now();
        const duplicate = now - (S.eventRecent.get(signature) || 0) < 3000;
        S.eventRecent.set(signature, now);
        if (S.eventRecent.size > 1000) S.eventRecent.delete(S.eventRecent.keys().next().value);
        if (emit && !duplicate) {
          S.eventQueue.push({ ...event, id: 'event:' + (++S.seq), time: new Date(now).toTimeString().slice(0, 8) });
          S.eventQueue = S.eventQueue.slice(-200);
        }
      });
    };
    scan(document.body, false); // 已存在的历史提示只建立基线，不算本次的新事件。
    S.eventObserver = new MutationObserver(mutations => mutations.forEach(m => {
      scan(m.target);
      m.addedNodes.forEach(node => scan(node));
    }));
    S.eventObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // 行号已在 MutationObserver 里定好；这里只为「挂观察之前就存在的元素」补一个行号。
  const lineOf = el => {
    let ln = S.line.get(el);
    if (ln == null) { ln = ++S.lineSeq; S.line.set(el, ln); }
    return ln;
  };

  // ---------- 区域1：视频区公屏浮层（同一行 = 同一 id，前端据此就地追加） ----------
  const r1 = [];
  if (S.container && S.container.isConnected) {
    Array.from(S.container.children).forEach(k => {
      const p = parse(k);
      if (!p.text) return;
      S.users.set(k, p.user);
      r1.push({ id: lineOf(k), user: p.user, text: p.text });
    });
  } else if (S.container) {
    S.container = null;      // 容器被换掉了，下一轮重新定位并挂观察
  }

  // ---------- 区域2：右侧聊天室消息列表 ----------
  const r2 = [];
  const list = document.querySelector('.webcast-chatroom___list');
  if (list) {
    list.querySelectorAll('.webcast-chatroom___item').forEach(it => {
      if (it.closest('.webcast-chatroom___bottom-message, .webcast-chatroom___bottom_message')) return;
      if (it.querySelector('.webcast-chatroom__room-message')) return; // 平台公告不是聊天消息
      // 礼物、关注、进房由事件通道单独处理，不能再当作普通弹幕回一次。
      if (roomEvent(it)) return;
      const full = clean(it.innerText);
      if (!full) return;
      const userEl = it.querySelector('.v8LY0gZF');
      let user = userEl ? clean(userEl.textContent).replace(/[:：]$/, '') : '';
      if (!user) return;
      const content = it.querySelector('.cL385mHb');
      const text = content ? clean(content.innerText) : clean(full.slice(full.indexOf(user) + user.length).replace(/^[:：]\s*/, ''));
      if (!text) return;
      if (it.querySelector('img[src*="webcast_anchor_badge"]')) {
        r1.push({ id: 'chat-host:' + idOf(it), user: user, text: text });
      } else r2.push({ id: idOf(it), user: user, text: text });
    });
  }

  // ---------- 头像：昵称 -> 头像URL ----------
  // 气泡本身不带头像，但页面上的「观众 / 麦位」卡片是大圆头像（aweme-avatar 源）且带昵称，
  // 正好可以按昵称给两侧消息配头像。大图统一降成 100x100（约 3KB，实测无防盗链）。
  const avatars = {};
  document.querySelectorAll('img').forEach(im => {
    const r = im.getBoundingClientRect();
    if (r.width < 20 || r.height < 20 || !/aweme-avatar/.test(im.src)) return;
    let box = im, label = '';
    for (let i = 0; i < 6 && box; i++) {
      const t = clean(box.innerText);
      if (t && t.length < 50) { label = t; break; }
      box = box.parentElement;
    }
    const name = norm(label);
    if (name && !avatars[name]) avatars[name] = im.src.replace('/1080x1080/', '/100x100/');
  });
  return { r1: r1, r2: r2, avatars: avatars, events: S.eventQueue.splice(0) };
}
`

export const OPEN_LOGIN_JS = String.raw`
() => {
  const clean = s => (s || '').replace(/\s+/g, '').trim();
  const btn = [...document.querySelectorAll('div,span,button,a')]
    .find(e => e.children.length <= 2 && /^(登录|立即登录|登录\/注册)$/.test(clean(e.innerText)));
  if (btn) { btn.click(); return true; }
  return false;
}
`

// 查询房间信息：用直播首页同源页发请求，cookies 自然带上；返回房间类型与状态
export const FETCH_ROOM_JS = String.raw`
async (rid) => {
  const url = 'https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web'
    + '&live_id=1&device_platform=web&language=zh-CN&enter_from=web_live&cookie_enabled=true'
    + '&web_rid=' + encodeURIComponent(rid);
  try {
    const r = await fetch(url, { credentials: 'include' });
    const j = await r.json();
    const rm = (j.data && j.data.data && j.data.data[0]) || null;
    if (!rm) return { ok: false };
    return { ok: true, mode: rm.live_room_mode, status: rm.status, title: rm.title };
  } catch (e) { return { ok: false, err: String(e) }; }
}
`

// 观众侧头像补采：进房后一次性打开「在线观众」面板并滚到底，把没上麦的观众也扫进头像池。
export const HARVEST_JS = String.raw`
async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('div,span,button,a')]
    .find(e => e.children.length <= 3 && (e.innerText || '').replace(/\s+/g, '').trim() === '在线观众');
  if (!btn) return false;
  btn.click();
  await wait(1500);      // 面板渲染完，随后的轮询就能扫到里面的头像
  const sc = [...document.querySelectorAll('div')]
    .filter(d => d.clientHeight > 150 && d.scrollHeight > d.clientHeight + 40)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (sc) for (let i = 0; i < 3; i++) { sc.scrollTop = sc.scrollHeight; await wait(600); }
  return true;
}
`

export const CLOSE_PANEL_JS = String.raw`() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
