#!/usr/bin/env python3
"""抖音语音直播间 AI 看板后端：FastAPI + WebSocket。

- 启动即待机，不写死直播间；由看板手动填写房号后连接
- 接受已开播的语音直播间和普通视频直播间
- 连接前先校验登录态：未登录则在浏览器里登录，回看板点「我已登录完成」保存登录态
- 随时可断开连接，断开后可重新填写房号
- 分析 Agent 的提示词与参数放在 agent_config.json，可在看板设置里在线修改
- 内部用 Playwright（有头 Chrome，区域1 需要视频解码）持续抓取两路文本
- WebSocket /ws 实时推送：r1 流式上屏、r2 弹幕、AI 摘要卡片、状态

运行（开发时由根目录 `npm run dev` 一并拉起前后端）:
  npm run dev              # 并行启动 Python 后端(18732) 与 Vite 前端(18731)
  python3.10 live_server.py --port 18732    # 只起后端
然后浏览器打开 Vite 提示的地址（默认 http://localhost:18731）
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

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from playwright.async_api import async_playwright

from agent_config import load as load_agent_config, save as save_agent_config, validate as validate_agent_config
from douyin_live_scraper import DEFAULT_STATE, EXTRACT_JS
from douyin_live_ai import collapse_r1, collapse_r2, is_no_change, strip_change_marker

ROOT = os.path.dirname(os.path.abspath(__file__))
LIVE_HOME = "https://live.douyin.com/"

app = FastAPI()
CLIENTS: set[WebSocket] = set()

STATE = {
    "status": "待机",            # 待机 / 等待登录 / 连接中 / 已进房 / 已断开 / 异常
    "room": "",                 # 当前直播间标题
    "room_id": "",              # 当前房号（空 = 未连接）
    "logged_in": False,
    "r1_count": 0,
    "r2_count": 0,
    "ai_count": 0,
    "last_ai": "",
}
AI_CONF = {"base_url": "https://api.darl.cn/v1", "model": "gpt-4o-mini", "key": "", "window": 20}
AGENT_CONF = load_agent_config()   # 分析提示词与参数，全部来自 agent_config.json
OPT = {"settle": 12000, "state": DEFAULT_STATE}

BUF: dict = {}          # 当前分析窗口缓冲，(region, id) -> row
SEEN: dict = {}         # 跨窗口去重，(region, id) -> text
R1_LINES: dict = {}     # 区域1 行号 -> {bid, ts, text}（行号由浏览器端按 DOM 增删时序判定）
PREV_SUMMARY = ""

# 头像：昵称 -> URL。气泡本身不带头像，数据来自页面「观众/麦位」卡片，按昵称给消息配对。
AVATARS: dict = {}
_AV_RANK = re.compile(r"^\d+\s+")
_AV_DASH = re.compile(r"^[-–—]\s*")
_AV_SCORE = re.compile(r"\s+\d+$")

# ---------- Playwright 运行时：一个常驻浏览器上下文，登录态与连接共用 ----------
PW = None
BROWSER = None
CTX = None
AUX_PAGE = None         # 停在直播首页的辅助页：用于登录弹窗与查询房间信息
ROOM_PAGE = None        # 当前连接的房间页
SCRAPER_TASK = None
RUNNING = False


def norm_name(s: str) -> str:
    """昵称归一化（与 EXTRACT_JS / 前端一致）：去名次前缀、徽章占位、尾部分数。"""
    s = re.sub(r"\s+", " ", s or "").strip()
    s = _AV_SCORE.sub("", _AV_DASH.sub("", _AV_RANK.sub("", s)))
    return s.strip()


# ---------- 登录态：以 douyin.com 域的 sessionid cookie 是否存在且未过期判断 ----------
def _has_session(cookies) -> bool:
    now = time.time()
    for c in cookies:
        if c.get("name") == "sessionid":
            exp = c.get("expires", -1)
            return exp in (-1, None) or exp > now
    return False


def _state_file_has_session() -> bool:
    if not os.path.exists(OPT["state"]):
        return False
    try:
        with open(OPT["state"], encoding="utf-8") as f:
            return _has_session(json.load(f).get("cookies", []))
    except Exception:
        return False


async def login_status() -> bool:
    """浏览器已启动就以浏览器 cookie 为准，否则读登录态文件。"""
    ok = _has_session(await CTX.cookies()) if CTX is not None else _state_file_has_session()
    STATE["logged_in"] = ok
    return ok


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


def db_open_window(now: float, stamp: str, n: int, keys=None) -> int:
    """开一个分析窗口，并只把本窗口实际缓冲的消息划进来。
    不能按 ts 兜底，否则会把历史会话里尚未归属窗口的旧消息全部吞进当前窗口。"""
    cur = DB.execute(
        "INSERT INTO windows(ts, time, n, model, summary) VALUES(?,?,?,?,?)",
        (now, stamp, n, AI_CONF["model"], ""),
    )
    wid = cur.lastrowid
    if keys:
        DB.executemany("UPDATE messages SET window_id=? WHERE key=? AND window_id IS NULL",
                       [(wid, k) for k in keys])
    else:
        DB.execute("UPDATE messages SET window_id=? WHERE window_id IS NULL AND ts<=?", (wid, now))
    DB.commit()
    return wid


def db_close_window(wid: int, summary: str):
    DB.execute("UPDATE windows SET summary=? WHERE id=?", (summary, wid))
    DB.commit()


# ---------- 浏览器与页面 ----------
async def ensure_browser():
    """懒启动常驻浏览器；首次连接/登录时才打开有头 Chrome。"""
    global PW, BROWSER, CTX
    if CTX is not None:
        return CTX
    PW = await async_playwright().start()
    BROWSER = await PW.chromium.launch(
        channel="chrome", headless=False,
        args=["--autoplay-policy=no-user-gesture-required", "--mute-audio",
              "--disable-blink-features=AutomationControlled"],
    )
    kw = dict(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    if os.path.exists(OPT["state"]):
        kw["storage_state"] = OPT["state"]
    CTX = await BROWSER.new_context(**kw)
    return CTX


async def aux_page():
    """辅助页：停在直播首页，用于登录弹窗和查询房间信息。"""
    global AUX_PAGE
    await ensure_browser()
    if AUX_PAGE is None or AUX_PAGE.is_closed():
        AUX_PAGE = await CTX.new_page()
        await AUX_PAGE.goto(LIVE_HOME, wait_until="domcontentloaded", timeout=60000)
        await AUX_PAGE.wait_for_timeout(2000)
    return AUX_PAGE


async def close_room_page():
    global ROOM_PAGE
    if ROOM_PAGE is not None and not ROOM_PAGE.is_closed():
        try:
            await ROOM_PAGE.close()
        except Exception:
            pass
    ROOM_PAGE = None


OPEN_LOGIN_JS = r"""
() => {
  const clean = s => (s || '').replace(/\s+/g, '').trim();
  const btn = [...document.querySelectorAll('div,span,button,a')]
    .find(e => e.children.length <= 2 && /^(登录|立即登录|登录\/注册)$/.test(clean(e.innerText)));
  if (btn) { btn.click(); return true; }
  return false;
}
"""

# 查询房间信息：用直播首页同源页发请求，cookies 自然带上；返回房间类型与状态
FETCH_ROOM_JS = r"""
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
"""

# 观众侧头像补采：进房后一次性打开「在线观众」面板并滚到底，把没上麦的观众也扫进头像池。
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


def reset_buffers():
    """新连接开始时清空上一场房间的抓取缓冲与轮播状态。"""
    global PREV_SUMMARY
    BUF.clear()
    SEEN.clear()
    R1_LINES.clear()
    AVATARS.clear()
    PREV_SUMMARY = ""
    for k in ("r1_count", "r2_count", "ai_count"):
        STATE[k] = 0
    STATE["last_ai"] = ""


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
    keys = ("status", "room", "room_id", "r1_count", "r2_count", "ai_count", "last_ai")
    return {"type": "stat", **{k: STATE[k] for k in keys}, "logged_in": STATE["logged_in"],
            "model": AI_CONF["model"], "window": AI_CONF["window"],
            "has_key": bool(AI_CONF["key"])}


def call_llm(transcript: str, prev_summary: str) -> str:
    max_chars = int(AGENT_CONF["max_chars"])
    if len(transcript) > max_chars:
        transcript = "（较早内容已截断）\n" + transcript[-max_chars:]
    user = f"本时段直播间文本：\n{transcript}"
    if AGENT_CONF["keep_prev_summary"] and prev_summary:
        user = f"上一时段摘要（供衔接参考）：\n{prev_summary}\n\n{user}"
    payload = {
        "model": AI_CONF["model"],
        "temperature": AGENT_CONF["temperature"],
        "max_tokens": AGENT_CONF["max_tokens"],
        "messages": [{"role": "system", "content": AGENT_CONF["system_prompt"]},
                     {"role": "user", "content": user}],
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
    if not AI_CONF["key"] or len(BUF) < AGENT_CONF["min_messages"]:
        return now if AI_CONF["key"] else last_flush  # 没 key 时不推进窗口，配好后立即能分析

    r1_rows = collapse_r1([r for r in BUF.values() if r["region"] == "r1"], AGENT_CONF["r1_gap"])
    r2_rows = [r for r in BUF.values() if r["region"] != "r1"]
    if AGENT_CONF["merge_repeats"]:
        r2_rows = collapse_r2(r2_rows, AGENT_CONF["repeat_max_chars"], AGENT_CONF["repeat_min_count"])
    rows = r1_rows + r2_rows
    keys = [r["db_key"] for r in BUF.values() if r.get("db_key")]
    n = len(BUF)
    BUF.clear()
    lines = []
    for r in sorted(rows, key=lambda r: r["ts"]):
        name = f"{r['user']}：" if r["user"] else ""
        label = AGENT_CONF["region_labels"].get(r["region"], r["region"])
        lines.append(f"[{label}] {name}{r['text']}")
    transcript = "\n".join(lines)

    stamp = time.strftime("%H:%M:%S")
    wid = db_open_window(now, stamp, n, keys)
    await broadcast({"type": "ai_pending", "time": stamp, "count": n})
    ok = True
    try:
        summary = await asyncio.to_thread(call_llm, transcript, PREV_SUMMARY)
    except urllib.error.HTTPError as e:
        summary = f"模型请求失败 HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}"
        ok = False
    except Exception as e:
        summary = f"模型请求失败: {e}"
        ok = False
    if ok:
        summary = strip_change_marker(summary) or AGENT_CONF["no_change_marker"]
    no_change = ok and is_no_change(summary, AGENT_CONF["no_change_marker"])
    db_close_window(wid, summary)

    # 没有实质变化：留档但不上屏，也不覆盖上一份有效摘要，避免连续雷同卡片
    if no_change and AGENT_CONF["suppress_no_change"]:
        await broadcast({"type": "ai_drop", "time": stamp})
        return time.time()

    if ok:
        PREV_SUMMARY = summary
    STATE["ai_count"] += 1
    STATE["last_ai"] = stamp
    await broadcast({"type": "ai", "time": stamp, "count": n, "summary": summary,
                     "model": AI_CONF["model"]})
    await broadcast(stat_msg())
    return time.time()


async def scraper_task(rid: str):
    """连接直播间：开一个房间页，持续抓取直到断开。"""
    global RUNNING, ROOM_PAGE
    RUNNING = True
    try:
        await ensure_browser()
        ROOM_PAGE = await CTX.new_page()
        page = ROOM_PAGE
        await page.goto(f"{LIVE_HOME}{rid}", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(OPT["settle"])
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
        while RUNNING:
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
                    # 键里带会话号：浏览器端节点 id 每次进房都从 1 重排，若只用 region:id，
                    # 重启后新消息会覆盖上一场同 id 的旧行，历史就被写花了。
                    db_key = f"{session}:{region}:{m['id']}"
                    BUF[key] = {"ts": now, "region": region, "user": m["user"],
                                "text": m["text"], "db_key": db_key}
                    avatar = AVATARS.get(norm_name(m["user"]))
                    db_upsert_msg(db_key, now, region, m["user"], m["text"], avatar)
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
    except Exception as e:
        STATE["status"] = f"异常: {e}"
        await broadcast(stat_msg())
    finally:
        await close_room_page()


class Config(BaseModel):
    base_url: str | None = None
    model: str | None = None
    key: str | None = None
    window: int | None = None


class Connect(BaseModel):
    room_id: str


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


@app.get("/agent")
async def get_agent_config():
    """当前分析 Agent 配置（来自 agent_config.json）。"""
    return AGENT_CONF


@app.post("/agent")
async def set_agent_config(c: dict = Body(...)):
    """保存分析 Agent 配置：校验后写回 agent_config.json 并即时生效。"""
    global AGENT_CONF
    err = validate_agent_config(c)
    if err:
        return {"ok": False, "msg": err}
    save_agent_config(c)
    AGENT_CONF = c
    return {"ok": True, "config": AGENT_CONF}


@app.get("/login/status")
async def get_login_status():
    ok = await login_status()
    return {"logged_in": ok}


@app.post("/login/start")
async def login_start():
    """打开抖音登录页（直播首页弹窗），让用户在浏览器里扫码/登录。"""
    page = await aux_page()
    opened = await page.evaluate(OPEN_LOGIN_JS)
    STATE["status"] = "等待登录"
    await broadcast(stat_msg())
    return {"ok": True, "opened": opened}


@app.post("/login/complete")
async def login_complete():
    """用户登录完成后回调：确认登录态并保存到登录态文件，供下次直接复用。"""
    if CTX is None:
        return {"ok": False, "logged_in": False, "msg": "还没有打开浏览器，请先点「去登录」"}
    if await login_status():
        await CTX.storage_state(path=OPT["state"])
        STATE["status"] = "待机"
        await broadcast(stat_msg())
        return {"ok": True, "logged_in": True}
    return {"ok": False, "logged_in": False, "msg": "还没检测到登录，请在浏览器里完成登录后再点"}


@app.post("/connect")
async def connect(c: Connect):
    global SCRAPER_TASK
    rid = (c.room_id or "").strip()
    if not re.fullmatch(r"\d{4,20}", rid):
        return {"ok": False, "msg": "房号必须是纯数字"}
    if SCRAPER_TASK and not SCRAPER_TASK.done():
        return {"ok": False, "msg": "已连接，请先断开再换房号"}
    if not await login_status():
        return {"ok": False, "msg": "未登录，请先完成登录"}
    page = await aux_page()
    info = await page.evaluate(FETCH_ROOM_JS, rid)
    if not info or not info.get("ok"):
        return {"ok": False, "msg": "房间不存在或查询失败，请检查房号"}
    if info.get("status") != 2:
        return {"ok": False, "msg": "该房间当前未开播"}
    reset_buffers()
    STATE.update(status="连接中", room=info.get("title") or "", room_id=rid)
    await broadcast({"type": "reset"})
    await broadcast(stat_msg())
    SCRAPER_TASK = asyncio.create_task(scraper_task(rid))
    return {"ok": True, "room_id": rid, "room": STATE["room"]}


@app.post("/disconnect")
async def disconnect():
    global SCRAPER_TASK, RUNNING
    if SCRAPER_TASK is None or SCRAPER_TASK.done():
        await close_room_page()
        STATE.update(status="待机", room="", room_id="")
        await broadcast(stat_msg())
        return {"ok": True}
    RUNNING = False
    try:
        await SCRAPER_TASK
    except Exception:
        pass
    SCRAPER_TASK = None
    await close_room_page()
    STATE.update(status="待机", room="", room_id="")
    await broadcast(stat_msg())
    return {"ok": True}


@app.websocket("/ws")
async def ws(ws: WebSocket):
    await ws.accept()
    CLIENTS.add(ws)
    STATE["logged_in"] = STATE["logged_in"] or _state_file_has_session()
    await ws.send_text(json.dumps(stat_msg(), ensure_ascii=False))
    try:
        while True:
            await ws.receive_text()     # 目前前端不主动发消息，只为保持连接
    except WebSocketDisconnect:
        pass
    finally:
        CLIENTS.discard(ws)


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
    ap.add_argument("--state", default=DEFAULT_STATE)
    ap.add_argument("--settle", type=int, default=12000)
    ap.add_argument("--port", type=int, default=18732)
    args = ap.parse_args()

    OPT["state"] = args.state
    OPT["settle"] = args.settle
    db_init()

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
