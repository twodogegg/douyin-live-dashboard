#!/usr/bin/env python3
"""抖音直播间 AI 实时分析：抓取 区域1(主播侧上屏) + 区域2(观众侧弹幕)，
按时间窗把两路文本交给 LLM 生成滚动摘要，终端实时输出并落盘。

抓取逻辑复用 douyin_live_scraper.py（同一套区域选择器与登录态）。

运行示例（key 只经环境变量传入，不要写进命令行）:
  /newapi exec-token <token_id> -- env NEWAPI_KEY=__NEWAPI_TOKEN_<token_id>__ \
      python3 douyin_live_ai.py --duration 120 --model gpt-4o-mini

  # 不调用模型，只验证抓取+拼装出的 prompt
  python3 douyin_live_ai.py --dry-run --window 10 --duration 20
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

from douyin_live_scraper import DEFAULT_STATE, DEFAULT_URL, EXTRACT_JS, build_context, enter_room

REGION_LABEL = {"r1": "主播侧", "r2": "观众侧"}

SYSTEM_PROMPT = """你是抖音语音直播间的实时内容分析助手。
输入是某个时间窗内该直播间的两路文本，已按来源标注：
- [主播侧] 视频区上屏内容，多为麦上用户/主播的发言或唱词，文字是逐字上屏的，同一句话可能被合并成一条
- [观众侧] 右侧聊天室弹幕，含观众发言、进场欢迎、送礼、点赞等

请用中文输出 3-6 条要点式摘要，覆盖：主播侧此刻在做什么内容、观众侧的整体反应与代表性言论。
要求：只基于给定文本，不要编造；不要逐句复述；每条一句话，可带代表性昵称做例子。"""


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--state", default=DEFAULT_STATE)
    ap.add_argument("--channel", default="chrome")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--settle", type=int, default=12000)
    ap.add_argument("--interval", type=float, default=0.5, help="DOM 轮询间隔（秒）")
    ap.add_argument("--duration", type=int, default=120, help="总运行时长（秒）")

    ap.add_argument("--window", type=int, default=20, help="每隔多少秒做一次 AI 分析")
    ap.add_argument("--r1-gap", type=float, default=3.0, help="区域1 上屏内容的 burst 间隔（秒），超过则视为新的一句")
    ap.add_argument("--min-messages", type=int, default=4, help="窗口内少于该条数则跳过本次分析")
    ap.add_argument("--max-chars", type=int, default=4000, help="送模型的文本上限，超出保留最近部分")
    ap.add_argument("--keep-context", action="store_true", default=True, help="把上一轮摘要作为上下文传入")

    ap.add_argument("--base-url", default="https://api.darl.cn/v1")
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--api-key", default=None, help="默认取环境变量 NEWAPI_KEY")
    ap.add_argument("--dry-run", action="store_true", help="不调用模型，只打印将要发送的 prompt")

    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_analysis.jsonl"))
    ap.add_argument("--report", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "live_report.md"))
    return ap.parse_args()


def log(msg):
    print(msg, flush=True)


def collect(page, seen, buf, now):
    """seen 记录每个节点已见过的文本（跨窗口保留），buf 只装本时间窗的内容。
    区域1 逐字上屏的多帧更新因此被自动合并成该节点在当前窗口内的最新文本。"""
    fresh = []
    for region in ("r1", "r2"):
        for m in page.evaluate(EXTRACT_JS)[region]:
            key = (region, m["id"])
            if seen.get(key) == m["text"]:
                continue
            if key not in seen:
                fresh.append((region, m))
            seen[key] = m["text"]
            buf[key] = {"ts": now, "region": region, "user": m["user"], "text": m["text"]}
    return fresh


def collapse_r1(rows, gap):
    """区域1 是逐字上屏，且每次修正都会渲染成新节点（同一句会出现多个不同长度的修订版）。
    按「同一用户 + 时间连续」切成 burst，每个 burst 只保留最长的那版，即该次上屏的最终形态。"""
    by_user = {}
    for r in rows:
        by_user.setdefault(r["user"], []).append(r)
    out = []
    for rs in by_user.values():
        cur = []
        for r in sorted(rs, key=lambda x: x["ts"]):
            if cur and r["ts"] - cur[-1]["ts"] > gap:
                out.append(max(cur, key=lambda x: len(x["text"])))
                cur = []
            cur.append(r)
        if cur:
            out.append(max(cur, key=lambda x: len(x["text"])))
    return out


def build_transcript(buf, gap):
    """区域2 是独立弹幕，逐条保留。"""
    rows = collapse_r1([r for r in buf.values() if r["region"] == "r1"], gap) + \
           [r for r in buf.values() if r["region"] != "r1"]
    lines = []
    for r in sorted(rows, key=lambda r: r["ts"]):
        name = f"{r['user']}：" if r["user"] else ""
        lines.append(f"[{REGION_LABEL[r['region']]}] {name}{r['text']}")
    return "\n".join(lines)


def call_llm(args, key, transcript, prev_summary):
    if args.max_chars and len(transcript) > args.max_chars:
        transcript = "（较早内容已截断）\n" + transcript[-args.max_chars:]
    user = f"本时段直播间文本：\n{transcript}"
    if args.keep_context and prev_summary:
        user = f"上一时段摘要（供衔接参考）：\n{prev_summary}\n\n{user}"

    payload = {
        "model": args.model,
        "temperature": 0.3,
        "max_tokens": 500,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        args.base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"].strip()


def main():
    args = parse_args()
    key = args.api_key or os.environ.get("NEWAPI_KEY")
    if not args.dry_run and not key:
        sys.exit("缺少 API key：请设置环境变量 NEWAPI_KEY（推荐用 /newapi exec-token 注入），或用 --dry-run 先验证抓取")

    jsonl = open(args.out, "a", encoding="utf-8")
    report = open(args.report, "a", encoding="utf-8")

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser, ctx = build_context(p, args)
        page = ctx.new_page()
        log(f"直播间: {enter_room(page, args.url, args.settle)}")
        log(f"模型: {args.model} @ {args.base_url} | 每 {args.window}s 分析一次 | 共 {args.duration}s\n")

        start = last_flush = time.time()
        seen, buf, prev_summary, analyses = {}, {}, "", 0

        def flush():
            nonlocal prev_summary, last_flush
            last_flush = time.time()
            if len(buf) < args.min_messages:
                return          # 条数太少，留到下一个窗口一起分析
            transcript = build_transcript(buf, args.r1_gap)
            n = len(buf)
            buf.clear()
            log("─" * 72)
            if args.dry_run:
                log(f"[{time.strftime('%H:%M:%S')}] 本时段 {n} 条（dry-run，未调用模型）\n{transcript}")
                return
            t0 = time.time()
            try:
                summary = call_llm(args, key, transcript, prev_summary)
            except urllib.error.HTTPError as e:
                log(f"[warn] 模型请求失败 HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:300]}")
                return
            except Exception as e:
                log(f"[warn] 模型请求失败: {e}")
                return
            stamp = time.strftime("%H:%M:%S")
            log(f"[{stamp}] 本时段 {n} 条 · {time.time() - t0:.1f}s\n{summary}")
            prev_summary = summary
            analyses += 1
            jsonl.write(json.dumps({"time": stamp, "count": n, "model": args.model,
                                    "transcript": transcript, "summary": summary}, ensure_ascii=False) + "\n")
            jsonl.flush()
            report.write(f"## {stamp}　本时段 {n} 条\n\n{summary}\n\n")
            report.flush()

        while time.time() - start < args.duration:
            now = time.time()
            for region, m in collect(page, seen, buf, now):
                if region == "r2":      # 区域1 逐字上屏的碎帧不逐条刷屏，折叠后的内容在每次分析里呈现
                    name = f"{m['user']}：" if m["user"] else ""
                    log(f"[{time.strftime('%H:%M:%S')}] 观众侧  {name}{m['text']}")
            if now - last_flush >= args.window:
                flush()
            time.sleep(args.interval)

        flush()
        log(f"\n完成：共 {analyses} 次分析。原始消息+结论 → {args.out}；可读报告 → {args.report}")
        browser.close()
        jsonl.close()
        report.close()


if __name__ == "__main__":
    main()
