#!/usr/bin/env python3
"""分析 Agent 配置：提示词与参数统一放在 agent_config.json，不写死在代码里。"""
import json
import os
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(ROOT, "agent_config.json")

REQUIRED = ("system_prompt", "temperature", "max_tokens", "max_chars",
            "min_messages", "r1_gap", "keep_prev_summary", "merge_repeats",
            "repeat_max_chars", "repeat_min_count", "no_change_marker",
            "suppress_no_change", "region_labels")


def validate(conf: dict) -> str | None:
    """返回错误信息；通过时返回 None。"""
    if not isinstance(conf, dict):
        return "配置必须是 JSON 对象"
    missing = [k for k in REQUIRED if k not in conf]
    if missing:
        return f"缺少字段: {', '.join(missing)}"
    if not isinstance(conf["system_prompt"], str) or not conf["system_prompt"].strip():
        return "system_prompt 不能为空"
    if len(conf["system_prompt"]) > 20000:
        return "system_prompt 不能超过 20000 字符"
    if not 0 <= float(conf["temperature"]) <= 2:
        return "temperature 需要在 0-2 之间"
    if not 1 <= int(conf["max_tokens"]) <= 8000:
        return "max_tokens 需要在 1-8000 之间"
    if not 100 <= int(conf["max_chars"]) <= 50000:
        return "max_chars 需要在 100-50000 之间"
    if not 1 <= int(conf["min_messages"]) <= 500:
        return "min_messages 需要在 1-500 之间"
    if not 0 <= float(conf["r1_gap"]) <= 120:
        return "r1_gap 需要在 0-120 秒之间"
    if not isinstance(conf["keep_prev_summary"], bool):
        return "keep_prev_summary 必须是布尔值"
    if not isinstance(conf["merge_repeats"], bool):
        return "merge_repeats 必须是布尔值"
    if not 1 <= int(conf["repeat_max_chars"]) <= 100:
        return "repeat_max_chars 需要在 1-100 之间"
    if not 2 <= int(conf["repeat_min_count"]) <= 100:
        return "repeat_min_count 需要在 2-100 之间"
    if not isinstance(conf["no_change_marker"], str) or not conf["no_change_marker"].strip():
        return "no_change_marker 不能为空"
    if not isinstance(conf["suppress_no_change"], bool):
        return "suppress_no_change 必须是布尔值"
    labels = conf["region_labels"]
    if not isinstance(labels, dict) or not all(isinstance(labels.get(k), str) and labels[k].strip()
                                               for k in ("r1", "r2")):
        return "region_labels 需要包含 r1 和 r2 的非空名称"
    return None


def load(path: str = DEFAULT_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        conf = json.load(f)
    err = validate(conf)
    if err:
        raise ValueError(f"{path}: {err}")
    return conf


def save(conf: dict, path: str = DEFAULT_PATH) -> None:
    err = validate(conf)
    if err:
        raise ValueError(err)
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(conf, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
