// 离线测试：node --test worker/
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, { checkMoves, parseBOC, parseAIJson, webChat, chunks, normPair, checkAlerts, dueSummarySlot, handleText, buildSummary, runCheck } from "./worker.js";

const kv = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, m }; };
const env = () => ({ FX: kv(), WX_TOKEN: "tok" });
const NOW = Date.UTC(2026, 9, 4);
const quoteOf = (pair, price) => ({
  pair, price, source: "test",
  daily: Array.from({ length: 30 }, (_, i) => [NOW / 1000 - (30 - i) * 86400, 4.5 + 0.01 * (i % 10)]),
  intraday: Array.from({ length: 96 }, (_, i) => [NOW / 1000 - 86400 + i * 900, price - 0.01 + 0.0002 * i]),
});
const fakeQuote = async (pair) => quoteOf(pair, pair.startsWith("AUD") ? 4.52 : 7.1);
const CFG = { timezone: "Australia/Sydney", summary_times: ["08:00", "23:00"], pairs: ["AUD/CNY"], approach_percent: 0.5, alerts: [{ pair: "AUD/CNY", target: 4.6 }] };

test("长消息分段", () => {
  const parts = chunks(Array.from({ length: 200 }, (_, i) => `第 ${i} 行汇率数据`).join("\n"));
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(new TextEncoder().encode(p).length <= 1800);
});

test("货币名解析", () => {
  assert.equal(normPair("澳元"), "AUD/CNY");
  assert.equal(normPair("aud"), "AUD/CNY");
  assert.equal(normPair("欧元 美元"), "EUR/USD");
  assert.equal(normPair("人民币"), "CNY/AUD");
  assert.equal(normPair("你好"), null);
});

test("提醒线：接近、到达、不重复、重新布防", () => {
  const st = { alerts: {} };
  const run = (p) => checkAlerts(CFG, st, { "AUD/CNY": quoteOf("AUD/CNY", p) });
  assert.deepEqual(run(4.5), []);
  assert.match(run(4.585)[0][0], /接近/);
  assert.deepEqual(run(4.59), []);
  assert.match(run(4.601)[0][0], /已涨到/);
  assert.deepEqual(run(4.62), []);
  assert.deepEqual(run(4.5), []);
  assert.match(run(4.58)[0][0], /接近/);
});

test("总结时间点（悉尼夏令时）", () => {
  const st = { last_summary_slot: null };
  const slot = dueSummarySlot(CFG, st, new Date(Date.UTC(2026, 9, 3, 22, 30))); // 悉尼 09:30
  assert.equal(slot, "2026-10-04 08:00");
  st.last_summary_slot = slot;
  assert.equal(dueSummarySlot(CFG, st, new Date(Date.UTC(2026, 9, 3, 22, 30))), null);
  assert.equal(dueSummarySlot(CFG, st, new Date(Date.UTC(2026, 9, 4, 2))), null); // 13:00
  assert.equal(dueSummarySlot(CFG, st, new Date(Date.UTC(2026, 9, 4, 12, 5))), "2026-10-04 23:00");
});

test("总结内容", () => {
  const s = buildSummary(CFG, { history: {} }, { "AUD/CNY": quoteOf("AUD/CNY", 4.52) }, NOW / 1000);
  assert.match(s, /1 AUD = 4\.5200 CNY/);
  assert.match(s, /建议：★★★/);
  assert.match(s, /提醒线 4\.6/);
});

test("聊天指令", async () => {
  const e = env(), d = { fetchQuote: fakeQuote };
  assert.match(await handleText(e, "澳元", d), /1 AUD = 4\.5200 CNY/);
  assert.match(await handleText(e, "1000 澳元", d), /1000 AUD = 4520\.00 CNY/);
  assert.match(await handleText(e, "提醒 美元 7.0 跌", d), /USD\/CNY 到 7/);
  assert.match(await handleText(e, "列表", d), /USD\/CNY 7（跌到）/);
  assert.match(await handleText(e, "删除提醒 1", d), /AUD\/CNY 4\.6/);
  assert.match(await handleText(e, "关注 欧元", d), /EUR\/CNY/);
  assert.match(await handleText(e, "时间 7:30 22点", d), /07:30、22:00/);
  assert.match(await handleText(e, "接近 0.3", d), /0\.3%/);
  const cfg = JSON.parse(await e.FX.get("config"));
  assert.deepEqual(cfg.alerts, [{ pair: "USD/CNY", target: 7, direction: "down" }]);
  assert.deepEqual(cfg.pairs, ["USD/CNY", "AUD/CNY", "EUR/CNY"]);
  assert.match(await handleText(e, "随便说点什么", d), /没看懂/);
  const pushed = [];
  assert.match(await handleText(e, "总结", { ...d, push: async (_e, t, b) => pushed.push(b) }), /马上发给你/);
  assert.match(pushed[0], /EUR\/CNY/);
});

test("定时检查：接近提醒 + 08:00 总结，下一轮不重复", async () => {
  const e = env(), sent = [];
  await e.FX.put("config", JSON.stringify(CFG));
  const fetcher = async () => ({ "AUD/CNY": quoteOf("AUD/CNY", 4.599) });
  const pusher = async (_e, t) => sent.push(t);
  await runCheck(e, new Date(Date.UTC(2026, 9, 3, 21, 5)), fetcher, pusher);
  assert.equal(sent.length, 2);
  await runCheck(e, new Date(Date.UTC(2026, 9, 3, 21, 20)), fetcher, pusher);
  assert.equal(sent.length, 2);
});

test("微信接入：签名校验、主人锁定、回复 XML", async () => {
  const e = env();
  const sig = (ts, n) => crypto.createHash("sha1").update(["tok", ts, n].sort().join("")).digest("hex");
  const q = `?signature=${sig("1", "2")}&timestamp=1&nonce=2`;
  let r = await worker.fetch(new Request(`https://x${q}&echostr=hello`), e);
  assert.equal(await r.text(), "hello");
  r = await worker.fetch(new Request(`https://x?signature=bad&timestamp=1&nonce=2&echostr=x`), e);
  assert.equal(r.status, 403);
  const msg = (from, text) => new Request(`https://x${q}`, { method: "POST", body:
    `<xml><ToUserName><![CDATA[bot]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content></xml>` });
  r = await worker.fetch(msg("me", "帮助"), e);
  assert.match(await r.text(), /<ToUserName><!\[CDATA\[me\]\]>.*简短指令/s);
  assert.equal(await e.FX.get("owner"), "me");
  r = await worker.fetch(msg("stranger", "删除提醒 1"), e);
  assert.match(await r.text(), /私人机器人/);
});

test("自检页", async () => {
  const e = env();
  const r = await worker.fetch(new Request("https://x/status"), e);
  const t = await r.text();
  assert.match(t, /✅ 存储 FX/);
  assert.match(t, /✅ WX_TOKEN/);
  assert.match(t, /❌ WX_APPID/);
});

test("网页聊天：页面、密码、指令", async () => {
  const e = { ...env(), WEB_PASSWORD: "pw" };
  let r = await worker.fetch(new Request("https://x/"), e);
  assert.match(await r.text(), /汇率机器人/);
  const call = (pw, text) => webChat(new Request("https://x/api/chat", { method: "POST",
    headers: { Authorization: `Bearer ${pw}` }, body: JSON.stringify({ text }) }), e, { fetchQuote: fakeQuote });
  r = await call("wrong", "帮助");
  assert.equal(r.status, 401);
  r = await call("pw", "1000 澳元");
  assert.match((await r.json()).reply, /4520\.00 CNY/);
  r = await call("pw", "提醒 澳元 4.7");
  assert.match((await r.json()).reply, /AUD\/CNY 到 4\.7/);
  r = await call("pw", "总结");
  assert.match((await r.json()).reply, /【AUD\/CNY】/);
  const noPw = await webChat(new Request("https://x/api/chat", { method: "POST", body: "{}" }), env());
  assert.equal(noPw.status, 503);
});

test("AI 对话：自然语言 → 指令 + 回答", async () => {
  const calls = [];
  const e = { ...env(), AI: { run: async (model, input) => {
    calls.push(input.messages);
    const q = input.messages.at(-1).content;
    if (q.includes("提醒我")) return { response: '好的 {"commands": ["提醒 澳元 4.65"], "reply": "帮你设好了"}' };
    return { response: '{"commands": [], "reply": "现在处于近 30 天低位，可以分批换。仅供参考。"}' };
  } } };
  const d = { fetchQuote: fakeQuote };
  assert.match(await handleText(e, "澳元", d), /1 AUD = 4\.5200/);          // 纯货币名不走 AI
  assert.equal(calls.length, 0);
  assert.match(await handleText(e, "现在适合换澳元吗", d), /低位/);
  assert.match(calls[0][0].content, /最新行情/);
  const r = await handleText(e, "澳元涨到4.65的时候提醒我", d);
  assert.match(r, /帮你设好了/);
  assert.match(r, /AUD\/CNY 到 4\.65/);
  assert.ok(JSON.parse(await e.FX.get("config")).alerts.some((a) => a.target === 4.65));
  assert.equal(JSON.parse(await e.FX.get("chat_history")).length, 4);
  assert.match(await handleText(env(), "随便聊聊", d), /没看懂/);              // 没有 AI 时退回指令模式
});

test("AI 输出解析", () => {
  assert.deepEqual(parseAIJson('前缀 {"commands":["列表"],"reply":"好"} 后缀'), { commands: ["列表"], reply: "好" });
  assert.deepEqual(parseAIJson("纯文本回答"), { commands: [], reply: "纯文本回答" });
});

const BOC_HTML = `<table><tr><th>货币名称</th><th>现汇买入价</th></tr>
<tr align="center">
  <td>澳大利亚元</td>
  <td>462.5</td>
  <td>448.13</td>
  <td>465.9</td>
  <td>467.96</td>
  <td>464.05</td>
  <td class="pjrq">2026.10.04</td>
  <td class="pjrq">13:30:00</td>
</tr>
<tr align="center"><td>美元</td><td>710.2</td><td>710.2</td><td>713.18</td><td>713.18</td><td>711.5</td><td>2026.10.04</td><td>13:30:00</td></tr>
<tr align="center"><td>巴西里亚尔</td><td></td><td>120</td><td></td><td>140</td><td>130</td><td>2026.10.04</td><td>13:30:00</td></tr>
</table>`;

test("中国银行牌价：解析和指令", async () => {
  const boc = parseBOC(BOC_HTML);
  assert.deepEqual(boc.AUD, { buy_spot: 462.5, buy_cash: 448.13, sell_spot: 465.9, sell_cash: 467.96, mid: 464.05, time: "2026.10.04 13:30:00" });
  assert.equal(boc.USD.sell_spot, 713.18);
  assert.equal(Object.keys(boc).length, 2);
  const e = env(), d = { fetchQuote: fakeQuote, fetchBOC: async () => boc };
  const r = await handleText(e, "中行 澳元", d);
  assert.match(r, /你用人民币买 AUD：现汇 4\.6590，现钞 4\.6796/);
  assert.match(r, /卖给银行：现汇 4\.6250/);
  assert.match(await handleText(e, "中行", d), /USD[\s\S]*AUD|AUD[\s\S]*USD/);
  const q = await handleText(e, "1000 澳元", d);
  assert.match(q, /中行现汇：你买 4\.6590/);
  assert.match(q, /约需 4659\.00 CNY/);
  const sum = buildSummary(CFG, { history: {} }, { "AUD/CNY": quoteOf("AUD/CNY", 4.52) }, NOW / 1000, boc);
  assert.match(sum, /中行现汇：买 4\.6590/);
});

test("波动提醒：从高点跌 0.2% 提醒，之后从新价位重新算", () => {
  const cfg = { moves: [{ pair: "AUD/CNY", direction: "down", step: 0.2 }] };
  const st = {};
  const run = (p) => checkMoves(cfg, st, { "AUD/CNY": quoteOf("AUD/CNY", p) });
  assert.deepEqual(run(4.65), []);        // 第一次只记录起点
  assert.deepEqual(run(4.66), []);        // 涨了：高点变成 4.66
  assert.deepEqual(run(4.655), []);       // 跌 0.11%，不够
  assert.match(run(4.65)[0][0], /AUD 跌了 0\.21%/);
  assert.deepEqual(run(4.648), []);       // 从 4.65 重新算
  assert.match(run(4.64)[0][0], /跌了/);
});

test("波动提醒指令和 AI 失败时如实告知", async () => {
  const e = env(), d = { fetchQuote: fakeQuote };
  assert.match(await handleText(e, "提醒 澳元 跌", d), /AUD\/CNY 从现在起每跌 0\.2%/);
  assert.match(await handleText(e, "波动 美元 0.5", d), /USD\/CNY 从现在起每涨或跌 0\.5%/);
  assert.match(await handleText(e, "列表", d), /波动提醒：\n  1\. AUD\/CNY 每跌 0\.2% 提醒\n  2\. USD\/CNY 每涨或跌 0\.5% 提醒/);
  assert.match(await handleText(e, "取消波动 1", d), /已取消波动提醒：AUD\/CNY/);
  const ai = { ...env(), AI: { run: async () => ({ response: '{"commands":["关注 火星币"],"reply":"已设置好了"}' }) } };
  const r = await handleText(ai, "帮我关注一下火星币", d);
  assert.match(r, /没设置成功/);
  assert.doesNotMatch(r, /已设置好了/);
});
