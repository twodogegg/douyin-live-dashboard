#!/usr/bin/env python3
"""抖音直播间 AI 看板后端：FastAPI + WebSocket。

- 内部用 Playwright（有头 Chrome，区域1 需要视频解码）持续抓取两路文本
- WebSocket /ws 实时推送：r1 流式上屏（按节点 id 更新）、r2 弹幕、AI 摘要卡片、状态
- POST /config 由浏览器端设置 base_url / model / key / 分析窗口（key 只在内存，不落盘）

运行:
  python3 live_server.py --port 8321
然后浏览器打开 http://localhost:8321
"""
import argparse
import asyncio
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
from playwright.async_api import async_playwright

from douyin_live_scraper import DEFAULT_STATE, DEFAULT_URL, EXTRACT_JS
from douyin_live_ai import SYSTEM_PROMPT, collapse_r1

ROOT = os.path.dirname(os.path.abspath(__file__))
REGION_LABEL = {"r1": "主播侧", "r2": "观众侧"}

app = FastAPI()
CLIENTS: set[WebSocket] = set()

STATE = {
    "status": "启动中",          # 启动中 / 已进房 / 异常
    "room": "",
    "started": time.time(),
    "r1_count": 0,
    "r2_count": 0,
    "ai_count": 0,
    "last_ai": "",
}
AI_CONF = {"base_url": "https://api.darl.cn/v1", "model": "gpt-4o-mini", "key": "", "window": 20}

BUF: dict = {}          # 当前分析窗口缓冲，(region, id) -> row
SEEN: dict = {}         # 跨窗口去重，(region, id) -> text
R1_LINES: dict = {}     # 区域1 行号 -> {bid, ts, text}（行号由浏览器端按 DOM 增删时序判定）
PREV_SUMMARY = ""

# 头像：昵称 -> URL。气泡本身不带头像，数据来自页面「观众/麦位」卡片，按昵称给消息配对。
AVATARS: dict = {}
_AV_RANK = re.compile(r"^\d+\s+")
_AV_DASH = re.compile(r"^[-–—]\s*")
_AV_SCORE = re.compile(r"\s+\d+$")


def norm_name(s: str) -> str:
    """昵称归一化（与 EXTRACT_JS / 前端一致）：去名次前缀、徽章占位、尾部分数。"""
    s = re.sub(r"\s+", " ", s or "").strip()
    s = _AV_SCORE.sub("", _AV_DASH.sub("", _AV_RANK.sub("", s)))
    return s.strip()


# ---------- 持久化：消息与 AI 摘要落 SQLite，看板刷新后仍可回看历史 ----------
DB_PATH = os.path.join(ROOT, "live_data.db")
DB: sqlite3.Connection | None = None


def db_init():
    global DB
    DB = sqlite3.connect(DB_PATH, check_same_thread=False)
    DB.execute(
        "CREATE TABLE IF NOT EXISTS messages("
        "  key TEXT PRIMARY KEY, ts REAL, time TEXT, region TEXT,"
        "  user TEXT, text TEXT, avatar TEXT, window_id INTEGER)"
    )
    DB.execute("CREATE INDEX IF NOT EXISTS idx_msg_window ON messages(window_id)")
    DB.execute(
        "CREATE TABLE IF NOT EXISTS windows("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, time TEXT,"
        "  n INTEGER, model TEXT, summary TEXT)"
    )
    DB.commit()


def db_upsert_msg(key: str, now: float, region: str, user: str, text: str, avatar):
    """按 (区域, 节点/行号) 落库：区域1 的逐字改写会更新同一行，而不是新增记录。"""
    DB.execute(
        "INSERT INTO messages(key, ts, time, region, user, text, avatar) VALUES(?,?,?,?,?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET text=excluded.text, avatar=excluded.avatar",
        (key, now, time.strftime("%H:%M:%S"), region, user, text, avatar),
    )


def db_open_window(now: float, stamp: str, n: int) -> int:
    """开一个分析窗口，并把「尚未归属窗口」的消息划进来（即本时段新增的那些）。"""
    cur = DB.execute(
        "INSERT INTO windows(ts, time, n, model, summary) VALUES(?,?,?,?,?)",
        (now, stamp, n, AI_CONF["model"], ""),
    )
    DB.execute("UPDATE messages SET window_id=? WHERE window_id IS NULL AND ts<=?", (cur.lastrowid, now))
    DB.commit()
    return cur.lastrowid


def db_close_window(wid: int, summary: str):
    DB.execute("UPDATE windows SET summary=? WHERE id=?", (summary, wid))
    DB.commit()


# 观众侧头像补采：进房后一次性打开「在线观众」面板并滚到底，把没上麦的观众也扫进头像池。
# 只做一次（池子只增不减，之后靠麦位列表持续补充），避免反复开合面板干扰抓取。
HARVEST_JS = r"""
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
"""
CLOSE_PANEL_JS = r"""() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"""


def track_r1_line(m, now):
    """区域1 是逐字上屏，同一行会被反复改写。行号（m["id"]）由 douyin_live_scraper.py 的
    EXTRACT_JS 依据 DOM 增删时序判定：抖音改写同一行时会在**同一次变更**里删掉旧元素、插入
    承载新文本的元素（新元素继承旧行号）；而换一句是跨变更出现，拿到新行号。
    所以这里只需按行号维护最新文本，前端据此在同一条记录上就地追加，不做任何文本猜测。

    返回 (bid, 展示文本)；文本没变时返回 (None, None)。
    """
    key = m["id"]
    line = R1_LINES.get(key)
    if line is not None:
        line["ts"] = now
        if line["text"] == m["text"]:
            return None, None
        line["text"] = m["text"]
        return line["bid"], m["text"]
    bid = f"{m['user']}\u0000{key}"
    R1_LINES[key] = {"bid": bid, "ts": now, "text": m["text"]}
    STATE["r1_count"] += 1
    return bid, m["text"]


async def broadcast(msg: dict):
    data = json.dumps(msg, ensure_ascii=False)
    dead = []
    for ws in list(CLIENTS):
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        CLIENTS.discard(ws)


def stat_msg():
    return {"type": "stat", **{k: STATE[k] for k in ("status", "room", "r1_count", "r2_count", "ai_count", "last_ai")}}


def call_llm(transcript: str, prev_summary: str) -> str:
    if len(transcript) > 4000:
        transcript = "（较早内容已截断）\n" + transcript[-4000:]
    user = f"本时段直播间文本：\n{transcript}"
    if prev_summary:
        user = f"上一时段摘要（供衔接参考）：\n{prev_summary}\n\n{user}"
    payload = {
        "model": AI_CONF["model"],
        "temperature": 0.3,
        "max_tokens": 500,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        AI_CONF["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {AI_CONF['key']}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"].strip()


async def maybe_analyze(last_flush: float) -> float:
    """到窗口且配好 key 就做一次分析并广播。返回新的 last_flush。"""
    global PREV_SUMMARY
    now = time.time()
    if now - last_flush < AI_CONF["window"]:
        return last_flush
    if not AI_CONF["key"] or len(BUF) < 4:
        return now if AI_CONF["key"] else last_flush  # 没 key 时不推进窗口，配好后立即能分析

    rows = collapse_r1([r for r in BUF.values() if r["region"] == "r1"], 3.0) + \
           [r for r in BUF.values() if r["region"] != "r1"]
    n = len(BUF)
    BUF.clear()
    lines = []
    for r in sorted(rows, key=lambda r: r["ts"]):
        name = f"{r['user']}：" if r["user"] else ""
        lines.append(f"[{REGION_LABEL[r['region']]}] {name}{r['text']}")
    transcript = "\n".join(lines)

    stamp = time.strftime("%H:%M:%S")
    wid = db_open_window(now, stamp, n)
    await broadcast({"type": "ai_pending", "time": stamp, "count": n})
    try:
        summary = await asyncio.to_thread(call_llm, transcript, PREV_SUMMARY)
    except urllib.error.HTTPError as e:
        summary = f"模型请求失败 HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}"
    except Exception as e:
        summary = f"模型请求失败: {e}"
    else:
        PREV_SUMMARY = summary
    db_close_window(wid, summary)
    STATE["ai_count"] += 1
    STATE["last_ai"] = stamp
    await broadcast({"type": "ai", "time": stamp, "count": n, "summary": summary,
                     "model": AI_CONF["model"]})
    await broadcast(stat_msg())
    return time.time()


async def scraper_task(url: str, state_path: str, settle: int):
    STATE["status"] = "启动浏览器"
    await broadcast(stat_msg())
    try:
        await _scraper_loop(url, state_path, settle)
    except Exception as e:
        STATE["status"] = f"异常: {e}"
        await broadcast(stat_msg())


async def _scraper_loop(url: str, state_path: str, settle: int):
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            channel="chrome", headless=False,
            args=["--autoplay-policy=no-user-gesture-required", "--mute-audio",
                  "--disable-blink-features=AutomationControlled"],
        )
        kw = dict(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        if os.path.exists(state_path):
            kw["storage_state"] = state_path
        ctx = await browser.new_context(**kw)
        page = await ctx.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(settle)
        STATE["room"] = await page.title()
        STATE["status"] = "已进房"
        await broadcast(stat_msg())

        # 补采一次观众面板（失败不影响抓取），4 秒后收起
        harvest_until = 0.0
        if await page.evaluate(HARVEST_JS):
            harvest_until = time.time() + 4

        last_flush = time.time()
        last_prune = time.time()
        last_av_push = 0.0
        av_dirty = False
        wrote = False
        session = str(int(time.time()))    # 本次抓取会话号，用于区分重启前后的库内主键
        while True:
            now = time.time()
            try:
                data = await page.evaluate(EXTRACT_JS)
            except Exception as e:
                STATE["status"] = f"页面异常: {e}"
                await broadcast(stat_msg())
                await asyncio.sleep(3)
                continue
            for name, url in (data.get("avatars") or {}).items():
                if AVATARS.get(name) != url:
                    AVATARS[name] = url
                    av_dirty = True
            for region in ("r1", "r2"):
                for m in data[region]:
                    key = (region, m["id"])
                    if SEEN.get(key) == m["text"]:
                        continue
                    is_new = key not in SEEN
                    SEEN[key] = m["text"]
                    BUF[key] = {"ts": now, "region": region, "user": m["user"], "text": m["text"]}
                    avatar = AVATARS.get(norm_name(m["user"]))
                    # 键里带会话号：浏览器端节点 id 每次进房都从 1 重排，若只用 region:id，
                    # 重启后新消息会覆盖上一场同 id 的旧行，历史就被写花了。
                    db_upsert_msg(f"{session}:{region}:{m['id']}", now, region, m["user"], m["text"], avatar)
                    wrote = True
                    if region == "r1":
                        bid, text = track_r1_line(m, now)
                        if bid is None:           # 同行的重渲染帧，跳过
                            continue
                        # 同一行的 bid 不变 → 前端在同一条记录上就地追加
                        await broadcast({"type": "r1", "id": bid, "user": m["user"],
                                         "text": text, "time": time.strftime("%H:%M:%S"),
                                         "avatar": avatar})
                    elif is_new:      # r2 只推新消息，不推更新
                        STATE["r2_count"] += 1
                        await broadcast({"type": "r2", "id": m["id"], "user": m["user"],
                                         "text": m["text"], "time": time.strftime("%H:%M:%S"),
                                         "avatar": avatar})
            if wrote:
                DB.commit()
                wrote = False
            if harvest_until and now > harvest_until:    # 面板补采结束，收起
                try:
                    await page.evaluate(CLOSE_PANEL_JS)
                except Exception:
                    pass
                harvest_until = 0.0
            if av_dirty and now - last_av_push > 5:
                await broadcast({"type": "avatars", "map": AVATARS})
                av_dirty = False
                last_av_push = now
            if now - last_prune > 10:      # 清理已结束的行，并顺带刷新一次统计
                for k in [k for k, l in R1_LINES.items() if now - l["ts"] > 60]:
                    R1_LINES.pop(k, None)
                await broadcast(stat_msg())
                last_prune = now
            last_flush = await maybe_analyze(last_flush)
            await asyncio.sleep(0.5)


class Config(BaseModel):
    base_url: str | None = None
    model: str | None = None
    key: str | None = None
    window: int | None = None


@app.post("/config")
async def set_config(c: Config):
    if c.base_url:
        AI_CONF["base_url"] = c.base_url
    if c.model:
        AI_CONF["model"] = c.model
    if c.key is not None:
        AI_CONF["key"] = c.key
    if c.window and 5 <= c.window <= 300:
        AI_CONF["window"] = c.window
    return {"ok": True, "base_url": AI_CONF["base_url"], "model": AI_CONF["model"],
            "window": AI_CONF["window"], "has_key": bool(AI_CONF["key"])}


@app.get("/config")
async def get_config():
    return {"base_url": AI_CONF["base_url"], "model": AI_CONF["model"],
            "window": AI_CONF["window"], "has_key": bool(AI_CONF["key"])}


@app.websocket("/ws")
async def ws(ws: WebSocket):
    await ws.accept()
    CLIENTS.add(ws)
    await ws.send_text(json.dumps(stat_msg(), ensure_ascii=False))
    try:
        while True:
            await ws.receive_text()     # 目前前端不主动发消息，只为保持连接
    except WebSocketDisconnect:
        pass
    finally:
        CLIENTS.discard(ws)


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(ROOT, "live_dashboard.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/history")
async def history(limit: int = 60):
    """历史 AI 摘要（新→旧）。"""
    cur = DB.execute("SELECT id, time, n, model, summary FROM windows ORDER BY id DESC LIMIT ?", (limit,))
    cols = ("id", "time", "n", "model", "summary")
    return {"windows": [dict(zip(cols, r)) for r in cur.fetchall()]}


@app.get("/history/{wid}")
async def history_window(wid: int):
    """某个摘要窗口覆盖到的原始消息。"""
    cur = DB.execute(
        "SELECT time, region, user, text, avatar FROM messages WHERE window_id=? ORDER BY ts", (wid,))
    cols = ("time", "region", "user", "text", "avatar")
    return {"messages": [dict(zip(cols, r)) for r in cur.fetchall()]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--state", default=DEFAULT_STATE)
    ap.add_argument("--settle", type=int, default=12000)
    ap.add_argument("--port", type=int, default=8321)
    args = ap.parse_args()

    db_init()

    @app.on_event("startup")
    async def _startup():
        asyncio.create_task(scraper_task(args.url, args.state, args.settle))

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
