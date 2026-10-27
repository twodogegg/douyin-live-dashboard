#!/usr/bin/env python3
"""抖音直播间文本抓取：区域1（视频区公屏浮层）+ 区域2（右侧聊天室消息列表）

用法:
  # 一次性抓取当前两个区域的内容
  python3 douyin_live_scraper.py

  # 持续抓取 30 秒，并写入 jsonl
  python3 douyin_live_scraper.py --watch --duration 30 --out capture.jsonl

注意:
  - 区域1 依赖视频正常渲染（Playwright 自带 Chromium 缺少 H.264/H.265 解码器，
    必须用 --channel chrome），因此默认使用本机 Chrome + 有头模式。
  - 登录态复用 .auth/state.json。
"""
import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_URL = "https://live.douyin.com/198492564053"
DEFAULT_STATE = os.path.join(ROOT, ".auth", "state.json")

# 给 DOM 节点分配稳定 id，用于判断「同一条消息是否更新」（流式输出 / 节点复用）
EXTRACT_JS = r"""
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

  // 进房/关注是独立事件。普通聊天即使写着「关注了主播」，也不能被当成关注。
  const eventSelector = '.webcast-chatroom___item, .webcast-chatroom___bottom-message, .webcast-chatroom___bottom_message';
  const roomEvent = el => {
    if (el.querySelector('.webcast-chatroom__room-message, img[src*="webcast_anchor_badge"], .cL385mHb')) return null;
    const full = clean(el.innerText || el.textContent);
    const match = full.match(/^(.*?)\s*(进入了直播间|进入直播间|来到了直播间|来了|关注了主播|关注了你|关注了直播间)[！!。]?$/);
    if (!match) return null;
    const name = el.querySelector('.v8LY0gZF, [data-e2e="user-name"], [class*="nickname"], [class*="userName"]');
    const user = clean(name?.textContent || match[1]).replace(/[:：]$/, '');
    if (!user || user.length > 80) return null;
    return { kind: match[2].startsWith('关注') ? 'follow' : 'join', user: user };
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
"""


def build_context(p, args):
    browser = p.chromium.launch(
        channel=args.channel,
        headless=args.headless,
        args=["--autoplay-policy=no-user-gesture-required", "--mute-audio",
              "--disable-blink-features=AutomationControlled"],
    )
    kw = dict(viewport={"width": args.width, "height": args.height}, locale="zh-CN")
    if os.path.exists(args.state):
        kw["storage_state"] = args.state
    else:
        print(f"[warn] 未找到登录态 {args.state}，将以未登录状态运行", file=sys.stderr)
    return browser, browser.new_context(**kw)


def enter_room(page, url, settle):
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(settle)
    return page.title()


def show_snapshot(data):
    for region, key in (("区域1 视频区公屏浮层", "r1"), ("区域2 右侧聊天室列表", "r2")):
        items = data[key]
        print(f"\n===== {region}（{len(items)} 条）=====")
        if not items:
            print("  <空>")
        for m in items:
            name = f"{m['user']}：" if m["user"] else ""
            print(f"  {name}{m['text']}")


def watch(page, args, sink):
    seen = {}          # node_id -> 上次文本
    count = 0
    t0 = time.time()
    print(f"开始持续抓取（每 {args.interval}s 轮询，共 {args.duration}s）...\n")
    while time.time() - t0 < args.duration:
        data = page.evaluate(EXTRACT_JS)
        for region, key in (("R1", "r1"), ("R2", "r2")):
            for m in data[key]:
                sig = f"{m['user']}\u0000{m['text']}"
                if seen.get((key, m["id"])) == sig:
                    continue
                seen[(key, m["id"])] = sig
                count += 1
                rec = {"time": time.strftime("%H:%M:%S"), "region": region,
                       "user": m["user"], "text": m["text"]}
                name = f"{m['user']}：" if m["user"] else ""
                print(f"[{rec['time']}] {region}  {name}{m['text']}")
                if sink:
                    sink.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    sink.flush()
        time.sleep(args.interval)
    return count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--state", default=DEFAULT_STATE)
    ap.add_argument("--channel", default="chrome", help="chrome / chromium（chromium 无法渲染视频，区域1 会为空）")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--settle", type=int, default=12000, help="进房后等待渲染的毫秒数")
    ap.add_argument("--watch", action="store_true", help="持续抓取新消息")
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--duration", type=int, default=30, help="watch 模式抓取时长（秒）")
    ap.add_argument("--out", default=None, help="watch 模式下写入的 jsonl 文件")
    args = ap.parse_args()

    sink = open(args.out, "w", encoding="utf-8") if args.out else None
    with sync_playwright() as p:
        browser, ctx = build_context(p, args)
        page = ctx.new_page()
        title = enter_room(page, args.url, args.settle)
        print("直播间:", title)

        data = page.evaluate(EXTRACT_JS)
        if not data["r1"]:
            print("[warn] 区域1 为空：可能视频未渲染或该房间没有视频公屏浮层", file=sys.stderr)
        if not data["r2"]:
            print("[warn] 区域2 为空：检查登录态或页面是否加载完成", file=sys.stderr)

        if args.watch:
            n = watch(page, args, sink)
            print(f"\n共抓到 {n} 条更新" + (f"，已写入 {args.out}" if args.out else ""))
        else:
            show_snapshot(data)

        if sink:
            sink.close()
        browser.close()


if __name__ == "__main__":
    main()
