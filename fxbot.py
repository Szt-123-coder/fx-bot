#!/usr/bin/env python3
"""汇率机器人：查询汇率、监控提醒线、每日总结并推送到微信。

只用 Python 标准库（3.11+），无需安装依赖。

用法：
  python fxbot.py rate AUD CNY [金额] [--push]   查询任意汇率
  python fxbot.py check                          检查提醒线，到点发每日总结（定时任务调用这个）
  python fxbot.py summary [--push]               立即生成每日总结
  python fxbot.py test-push                      发一条测试消息到微信
  python fxbot.py loop [分钟]                    常驻运行，每隔 N 分钟执行一次 check（默认 15）

推送凭证从环境变量读取（不要写进配置文件）：
  PUSHPLUS_TOKEN   PushPlus 的 token（微信公众号"pushplus 推送加"）
  SERVERCHAN_KEY   或者 Server酱 的 SendKey（二选一）
"""

from __future__ import annotations

import json
import os
import sys
import time
import tomllib
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("FXBOT_CONFIG", ROOT / "config.toml"))
STATE_PATH = Path(os.environ.get("FXBOT_STATE", ROOT / "state" / "state.json"))

UA = "Mozilla/5.0 (fxbot)"
HISTORY_DAYS = 35
SUMMARY_GRACE = timedelta(hours=3)  # 定时任务延迟时，多久内仍补发总结


# ---------------------------------------------------------------- 工具

def http_get_json(url: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, data: bytes, content_type: str, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        url, data=data, headers={"User-Agent": UA, "Content-Type": content_type}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def split_pair(pair: str) -> tuple[str, str]:
    base, quote = pair.upper().replace("-", "/").split("/")
    return base.strip(), quote.strip()


def fmt(x: float) -> str:
    return f"{x:.4f}"


def pct(a: float, b: float) -> float:
    """b 相对 a 的涨跌百分比。"""
    return (b - a) / a * 100


# ---------------------------------------------------------------- 配置与状态

def load_config() -> dict:
    with open(CONFIG_PATH, "rb") as f:
        cfg = tomllib.load(f)
    cfg.setdefault("timezone", "Australia/Sydney")
    cfg.setdefault("summary_times", ["08:00", "23:00"])
    cfg.setdefault("pairs", ["USD/CNY", "AUD/CNY"])
    cfg.setdefault("approach_percent", 0.5)
    cfg.setdefault("alerts", [])
    return cfg


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except json.JSONDecodeError:
            pass
    return {"history": {}, "alerts": {}, "last_summary_slot": None}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    tmp.replace(STATE_PATH)


# ---------------------------------------------------------------- 汇率数据源

@dataclass
class Quote:
    pair: str
    price: float
    source: str
    daily: list[tuple[int, float]]  # 近一个月日收盘 (unix 秒, 价格)
    intraday: list[tuple[int, float]]  # 近 24 小时 (unix 秒, 价格)


def _yahoo(base: str, quote: str, rng: str, interval: str) -> tuple[float, list]:
    sym = urllib.parse.quote(f"{base}{quote}=X")
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?range={rng}&interval={interval}")
    res = http_get_json(url)["chart"]["result"][0]
    closes = res["indicators"]["quote"][0]["close"]
    points = [(t, c) for t, c in zip(res.get("timestamp", []), closes) if c]
    return float(res["meta"]["regularMarketPrice"]), points


def _er_api(base: str, quote: str) -> float:
    data = http_get_json(f"https://open.er-api.com/v6/latest/{base}")
    return float(data["rates"][quote])


def _fawaz(base: str, quote: str) -> float:
    b, q = base.lower(), quote.lower()
    url = f"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{b}.json"
    return float(http_get_json(url)[b][q])


def fetch_quote(pair: str, with_history: bool = True) -> Quote:
    """先用 Yahoo Finance（盘中实时），失败时退到 open.er-api.com / fawazahmed0（每日更新）。"""
    base, quote = split_pair(pair)
    name = f"{base}/{quote}"
    errors = []
    try:
        daily, intraday = [], []
        if with_history:
            price, daily = _yahoo(base, quote, "1mo", "1d")
            _, intraday = _yahoo(base, quote, "2d", "15m")
        else:
            price, _ = _yahoo(base, quote, "1d", "1d")
        return Quote(name, price, "Yahoo Finance", daily, intraday)
    except Exception as e:  # noqa: BLE001
        errors.append(f"Yahoo: {e}")
    for label, fn in (("open.er-api.com", _er_api), ("fawazahmed0", _fawaz)):
        try:
            return Quote(name, fn(base, quote), label, [], [])
        except Exception as e:  # noqa: BLE001
            errors.append(f"{label}: {e}")
    raise RuntimeError(f"{name} 获取失败：" + "；".join(errors))


# ---------------------------------------------------------------- 推送

def push(title: str, content: str) -> None:
    pp = os.environ.get("PUSHPLUS_TOKEN", "").strip()
    sc = os.environ.get("SERVERCHAN_KEY", "").strip()
    if pp:
        body = json.dumps({"token": pp, "title": title, "content": content,
                           "template": "markdown"}).encode()
        r = http_post("https://www.pushplus.plus/send", body, "application/json")
        if r.get("code") != 200:
            raise RuntimeError(f"PushPlus 推送失败：{r}")
    elif sc:
        body = urllib.parse.urlencode({"title": title, "desp": content}).encode()
        r = http_post(f"https://sctapi.ftqq.com/{sc}.send", body,
                      "application/x-www-form-urlencoded")
        if r.get("code") != 0:
            raise RuntimeError(f"Server酱 推送失败：{r}")
    else:
        print("（未设置 PUSHPLUS_TOKEN / SERVERCHAN_KEY，只打印不推送）")
    print(f"=== {title} ===\n{content}\n")


# ---------------------------------------------------------------- 历史记录

def record(state: dict, q: Quote, now: datetime) -> None:
    """把每次检查到的价格存下来，Yahoo 不可用时用它算日内波动和月度区间。"""
    hist = state["history"].setdefault(q.pair, [])
    ts = int(now.timestamp())
    if not hist or ts - hist[-1][0] >= 600:
        hist.append([ts, q.price])
    cutoff = ts - HISTORY_DAYS * 86400
    state["history"][q.pair] = [p for p in hist if p[0] >= cutoff]


def series(state: dict, q: Quote, now: datetime) -> tuple[list[float], list[float]]:
    """返回 (近 30 天价格序列, 近 24 小时价格序列)。"""
    ts = now.timestamp()
    own = state["history"].get(q.pair, [])
    month = [p for _, p in q.daily] or [p for t, p in own if t >= ts - 30 * 86400]
    day = [p for t, p in q.intraday if t >= ts - 86400] or [p for t, p in own if t >= ts - 86400]
    month = month + [q.price]
    day = day + [q.price]
    return month, day


def price_ago(state: dict, q: Quote, now: datetime, hours: float) -> float | None:
    target = now.timestamp() - hours * 3600
    pts = q.daily if hours >= 48 else q.intraday
    pts = pts or [tuple(x) for x in state["history"].get(q.pair, [])]
    before = [p for t, p in pts if t <= target]
    return before[-1] if before else None


# ---------------------------------------------------------------- 提醒线

def check_alerts(cfg: dict, state: dict, quotes: dict[str, Quote]) -> list[tuple[str, str]]:
    band = float(cfg["approach_percent"])
    msgs = []
    for a in cfg["alerts"]:
        base, quote = split_pair(a["pair"])
        pair = f"{base}/{quote}"
        target = float(a["target"])
        q = quotes.get(pair)
        if q is None:
            continue
        key = f"{pair}@{target}"
        st = state["alerts"].setdefault(key, {})
        direction = a.get("direction") or st.get("direction")
        if direction not in ("up", "down"):
            direction = "up" if q.price < target else "down"
        st["direction"] = direction

        price = q.price
        reached = price >= target if direction == "up" else price <= target
        gap = abs(target - price) / target * 100
        arrow = "涨到" if direction == "up" else "跌到"
        if reached:
            if not st.get("reached_sent"):
                msgs.append((f"✅ {pair} 已{arrow} {target}",
                             f"**{pair} 当前 {fmt(price)}，已{arrow}你设的提醒线 {target}。**\n\n"
                             f"1 {base} = {fmt(price)} {quote}\n\n数据源：{q.source}"))
                st["reached_sent"] = True
                st["approach_sent"] = True
        elif gap <= band:
            if not st.get("approach_sent"):
                msgs.append((f"⏳ {pair} 接近 {target}",
                             f"**{pair} 当前 {fmt(price)}，距离提醒线 {target} 只差 {gap:.2f}%。**\n\n"
                             f"等{arrow} {target} 时会再提醒你。\n\n数据源：{q.source}"))
                st["approach_sent"] = True
        elif gap > band * 2:
            # 汇率明显离开提醒线后重新布防，下次接近/到达还会再提醒
            st["approach_sent"] = False
            st["reached_sent"] = False
    return msgs


# ---------------------------------------------------------------- 每日总结与建议

def advice(q: Quote, month: list[float], chg_24h: float | None) -> str:
    base, quote = split_pair(q.pair)
    lo, hi = min(month), max(month)
    pos = 0.5 if hi == lo else (q.price - lo) / (hi - lo)
    avg = sum(month) / len(month)
    if pos <= 0.25:
        s = f"★★★ 处于近 30 天低位，用{quote}换{base}较划算，可考虑分批买入"
    elif q.price <= avg:
        s = f"★★ 低于近 30 天均值，可小额分批买入{base}"
    elif pos < 0.75:
        s = f"★ 高于近 30 天均值，不急的话建议观望"
    else:
        s = f"☆ 接近近 30 天高位，{base}偏贵，建议等回落"
    if chg_24h is not None:
        if chg_24h <= -0.3:
            s += f"；{base}还在走弱，可以再等等或分批"
        elif chg_24h >= 0.3:
            s += f"；{base}短期走强，急用可先换一部分"
    return s


def build_summary(cfg: dict, state: dict, quotes: dict[str, Quote], now: datetime) -> str:
    tz = ZoneInfo(cfg["timezone"])
    lines = [f"**{now.astimezone(tz):%Y-%m-%d %H:%M}（{cfg['timezone']}）**", ""]
    alert_map = {}
    for a in cfg["alerts"]:
        b, qq = split_pair(a["pair"])
        alert_map.setdefault(f"{b}/{qq}", []).append(float(a["target"]))
    for pair, q in quotes.items():
        base, quote = split_pair(pair)
        month, day = series(state, q, now)
        p24 = price_ago(state, q, now, 24)
        p7d = price_ago(state, q, now, 24 * 7)
        c24 = pct(p24, q.price) if p24 else None
        c7 = pct(p7d, q.price) if p7d else None
        lines.append(f"### {pair}　1 {base} = {fmt(q.price)} {quote}")
        if c24 is not None:
            lines.append(f"- 24 小时：{c24:+.2f}%（区间 {fmt(min(day))} ~ {fmt(max(day))}，"
                         f"振幅 {pct(min(day), max(day)):.2f}%）")
        if c7 is not None:
            lines.append(f"- 7 天：{c7:+.2f}%")
        if len(month) >= 3:
            lines.append(f"- 30 天区间 {fmt(min(month))} ~ {fmt(max(month))}，"
                         f"均值 {fmt(sum(month) / len(month))}")
        for t in alert_map.get(pair, []):
            lines.append(f"- 提醒线 {t}：还差 {pct(q.price, t):+.2f}%")
        if len(month) >= 3:
            lines.append(f"- 建议：{advice(q, month, c24)}")
        else:
            lines.append("- 建议：历史数据还不够，运行几天后会给出")
        lines.append(f"- 数据源：{q.source}")
        lines.append("")
    lines.append("> 建议仅根据近期走势自动生成，不构成投资建议；银行实际换汇价会有点差。")
    return "\n".join(lines)


def due_summary_slot(cfg: dict, state: dict, now: datetime) -> str | None:
    """找出最近一个已到但还没发过的总结时间点（允许定时任务延迟 3 小时内补发）。"""
    tz = ZoneInfo(cfg["timezone"])
    local = now.astimezone(tz)
    best = None
    for day in (local.date() - timedelta(days=1), local.date()):
        for hm in cfg["summary_times"]:
            h, m = map(int, hm.split(":"))
            slot = datetime(day.year, day.month, day.day, h, m, tzinfo=tz)
            if slot <= local and local - slot <= SUMMARY_GRACE:
                if best is None or slot > best:
                    best = slot
    if best is None:
        return None
    key = best.isoformat()
    return None if state.get("last_summary_slot") == key else key


# ---------------------------------------------------------------- 命令

def fetch_all(cfg: dict) -> dict[str, Quote]:
    pairs = {f"{b}/{q}" for b, q in map(split_pair, cfg["pairs"])}
    pairs |= {f"{b}/{q}" for b, q in (split_pair(a["pair"]) for a in cfg["alerts"])}
    quotes = {}
    for p in sorted(pairs, key=lambda x: cfg["pairs"].index(x) if x in cfg["pairs"] else 99):
        try:
            quotes[p] = fetch_quote(p)
        except Exception as e:  # noqa: BLE001
            print(e, file=sys.stderr)
    return quotes


def cmd_check(now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    cfg, state = load_config(), load_state()
    quotes = fetch_all(cfg)
    if not quotes:
        raise SystemExit("所有汇率都获取失败")
    for q in quotes.values():
        record(state, q, now)
    for title, body in check_alerts(cfg, state, quotes):
        push(title, body)
    slot = due_summary_slot(cfg, state, now)
    if slot:
        push("📊 每日汇率总结", build_summary(cfg, state, quotes, now))
        state["last_summary_slot"] = slot
    save_state(state)
    print(f"{now.isoformat()} 检查完成：" +
          "，".join(f"{p} {fmt(q.price)}" for p, q in quotes.items()))


def cmd_summary(do_push: bool) -> None:
    now = datetime.now(timezone.utc)
    cfg, state = load_config(), load_state()
    quotes = fetch_all(cfg)
    text = build_summary(cfg, state, quotes, now)
    if do_push:
        push("📊 每日汇率总结", text)
    else:
        print(text)


def cmd_rate(base: str, quote: str, amount: float | None, do_push: bool) -> None:
    q = fetch_quote(f"{base}/{quote}", with_history=False)
    b, qq = split_pair(q.pair)
    text = f"1 {b} = {fmt(q.price)} {qq}\n1 {qq} = {fmt(1 / q.price)} {b}"
    if amount is not None:
        text += f"\n{amount:g} {b} = {amount * q.price:,.2f} {qq}"
    text += f"\n（数据源：{q.source}）"
    if do_push:
        push(f"💱 {q.pair} {fmt(q.price)}", text.replace("\n", "\n\n"))
    else:
        print(text)


def main(argv: list[str]) -> None:
    do_push = "--push" in argv
    args = [a for a in argv if a != "--push"]
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd == "rate" and len(args) >= 3:
        cmd_rate(args[1], args[2], float(args[3]) if len(args) > 3 else None, do_push)
    elif cmd == "check":
        cmd_check()
    elif cmd == "summary":
        cmd_summary(do_push)
    elif cmd == "test-push":
        push("🔔 汇率机器人测试", "收到这条消息，说明微信推送已经配置好了。")
    elif cmd == "loop":
        minutes = float(args[1]) if len(args) > 1 else 15
        while True:
            try:
                cmd_check()
            except Exception as e:  # noqa: BLE001
                print(f"本轮失败：{e}", file=sys.stderr)
            time.sleep(minutes * 60)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
