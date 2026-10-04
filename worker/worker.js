// 汇率机器人 · Cloudflare Workers 版
// 在微信测试号里聊天：查汇率、设提醒线、改监控内容；定时检查提醒线并发每日总结。
// 单文件，无依赖，可直接粘贴到 Cloudflare 控制台的 Worker 编辑器里。
//
// 需要的绑定 / 变量（在 Worker 的 Settings 里配置）：
//   KV 命名空间绑定  FX          存设置和状态
//   WX_TOKEN    自己随便定的一串字符，与测试号「接口配置信息」里的 Token 一致
//   WX_APPID    测试号 appID
//   WX_SECRET   测试号 appsecret（填成 Secret 类型）
//   PUSHPLUS_TOKEN  可选：主动推送失败时（例如 48 小时没和测试号说过话）改用 PushPlus 推送
// 定时触发器（Triggers → Cron）：*/15 * * * *

const DEFAULTS = {
  timezone: "Australia/Sydney",
  summary_times: ["08:00", "23:00"],
  pairs: ["USD/CNY", "AUD/CNY"],
  approach_percent: 0.5,
  alerts: [{ pair: "AUD/CNY", target: 4.6 }],
};

const NAMES = {
  澳元: "AUD", 澳币: "AUD", 美元: "USD", 美金: "USD", 人民币: "CNY", 欧元: "EUR",
  英镑: "GBP", 日元: "JPY", 港币: "HKD", 港元: "HKD", 新西兰元: "NZD", 纽币: "NZD",
  加元: "CAD", 加币: "CAD", 新加坡元: "SGD", 新币: "SGD", 韩元: "KRW", 瑞郎: "CHF",
  泰铢: "THB", 台币: "TWD",
};
const UA = "Mozilla/5.0 (fxbot)";
const DAY = 86400;

// ------------------------------------------------------------------ 小工具

const fmt = (x) => x.toFixed(4);
const pct = (a, b) => ((b - a) / a) * 100;
const sign = (x) => (x >= 0 ? "+" : "") + x.toFixed(2) + "%";

export function normPair(text) {
  let s = text.trim().toUpperCase().replace(/[-\s]+/g, "/");
  for (const [k, v] of Object.entries(NAMES)) s = s.replaceAll(k, v);
  const codes = s.match(/[A-Z]{3}/g) || [];
  if (codes.length === 0) return null;
  const base = codes[0];
  const quote = codes[1] || (base === "CNY" ? "AUD" : "CNY");
  return `${base}/${quote}`;
}

function localParts(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

// ------------------------------------------------------------------ 存储

async function loadJSON(env, key, fallback) {
  const v = await env.FX.get(key);
  return v ? JSON.parse(v) : structuredClone(fallback);
}
const saveJSON = (env, key, v) => env.FX.put(key, JSON.stringify(v));
const loadConfig = (env) => loadJSON(env, "config", DEFAULTS);
const loadState = (env) => loadJSON(env, "state", { history: {}, alerts: {}, last_summary_slot: null });

// ------------------------------------------------------------------ 汇率数据源

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function yahoo(base, quote, range, interval) {
  const sym = encodeURIComponent(`${base}${quote}=X`);
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}`);
  const res = j.chart.result[0];
  const closes = res.indicators.quote[0].close;
  const pts = (res.timestamp || []).map((t, i) => [t, closes[i]]).filter((p) => p[1]);
  return { price: res.meta.regularMarketPrice, pts };
}

export async function fetchQuote(pair, withHistory = true) {
  const [base, quote] = pair.split("/");
  const errors = [];
  try {
    if (withHistory) {
      const [m, d] = await Promise.all([yahoo(base, quote, "1mo", "1d"), yahoo(base, quote, "2d", "15m")]);
      return { pair, price: m.price, source: "Yahoo Finance", daily: m.pts, intraday: d.pts };
    }
    const m = await yahoo(base, quote, "1d", "1d");
    return { pair, price: m.price, source: "Yahoo Finance", daily: [], intraday: [] };
  } catch (e) { errors.push(`Yahoo: ${e.message}`); }
  try {
    const j = await getJSON(`https://open.er-api.com/v6/latest/${base}`);
    const price = j.rates[quote];
    if (price) return { pair, price, source: "open.er-api.com", daily: [], intraday: [] };
    errors.push(`open.er-api.com: 不支持 ${quote}`);
  } catch (e) { errors.push(`open.er-api.com: ${e.message}`); }
  throw new Error(`${pair} 获取失败（${errors.join("；")}）`);
}

// ------------------------------------------------------------------ 微信

async function wxAccessToken(env) {
  const cached = await loadJSON(env, "wx_token", null);
  const now = Date.now() / 1000;
  if (cached && cached.expires > now + 60) return cached.token;
  const j = await getJSON(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${env.WX_APPID}&secret=${env.WX_SECRET}`);
  if (!j.access_token) throw new Error(`获取 access_token 失败：${JSON.stringify(j)}`);
  await saveJSON(env, "wx_token", { token: j.access_token, expires: now + j.expires_in });
  return j.access_token;
}

// 主动推送：先用微信客服消息（48 小时内和测试号说过话即可），失败再用 PushPlus
export function chunks(text, maxBytes = 1800) {
  const out = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const next = cur ? `${cur}\n${line}` : line;
    if (new TextEncoder().encode(next).length > maxBytes && cur) { out.push(cur); cur = line; }
    else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

export async function push(env, title, content) {
  const owner = await env.FX.get("owner");
  const errors = [];
  if (owner && env.WX_APPID) {
    try {
      const token = await wxAccessToken(env);
      let ok = true;
      for (const part of chunks(`${title}\n\n${content}`)) {
        const r = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`, {
          method: "POST",
          body: JSON.stringify({ touser: owner, msgtype: "text", text: { content: part } }),
        });
        const j = await r.json();
        if (j.errcode !== 0) { ok = false; errors.push(`微信：${JSON.stringify(j)}`); break; }
      }
      if (ok) return "wechat";
    } catch (e) { errors.push(`微信：${e.message}`); }
  }
  if (env.PUSHPLUS_TOKEN) {
    const r = await fetch("https://www.pushplus.plus/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: env.PUSHPLUS_TOKEN, title, content: content.replaceAll("\n", "<br>"), template: "html" }),
    });
    const j = await r.json();
    if (j.code === 200) return "pushplus";
    errors.push(`PushPlus：${JSON.stringify(j)}`);
  }
  throw new Error(`推送失败：${errors.join("；") || "没有可用的推送方式"}`);
}

async function sha1Hex(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function wxSignatureOk(env, params) {
  const sig = await sha1Hex([env.WX_TOKEN, params.get("timestamp"), params.get("nonce")].sort().join(""));
  return sig === params.get("signature");
}

const xmlField = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`));
  return m ? (m[1] ?? m[2]) : "";
};

const xmlResponse = (to, from, text) =>
  new Response(wxReply(to, from, text), { headers: { "Content-Type": "application/xml; charset=utf-8" } });

const wxReply = (to, from, text) =>
  `<xml><ToUserName><![CDATA[${to}]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
  `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType>` +
  `<Content><![CDATA[${text.replaceAll("]]>", "]]]]><![CDATA[>")}]]></Content></xml>`;

// ------------------------------------------------------------------ 历史记录

function record(state, q, now) {
  const hist = (state.history[q.pair] ||= []);
  if (!hist.length || now - hist[hist.length - 1][0] >= 600) hist.push([now, q.price]);
  state.history[q.pair] = hist.filter((p) => p[0] >= now - 35 * DAY);
}

function series(state, q, now) {
  const own = state.history[q.pair] || [];
  let month = q.daily.map((p) => p[1]);
  if (!month.length) month = own.filter((p) => p[0] >= now - 30 * DAY).map((p) => p[1]);
  let day = q.intraday.filter((p) => p[0] >= now - DAY).map((p) => p[1]);
  if (!day.length) day = own.filter((p) => p[0] >= now - DAY).map((p) => p[1]);
  return { month: [...month, q.price], day: [...day, q.price] };
}

function priceAgo(state, q, now, hours) {
  const target = now - hours * 3600;
  let pts = hours >= 48 ? q.daily : q.intraday;
  if (!pts.length) pts = state.history[q.pair] || [];
  const before = pts.filter((p) => p[0] <= target);
  return before.length ? before[before.length - 1][1] : null;
}

// ------------------------------------------------------------------ 提醒线

export function checkAlerts(cfg, state, quotes) {
  const band = Number(cfg.approach_percent);
  const msgs = [];
  for (const a of cfg.alerts) {
    const q = quotes[a.pair];
    if (!q) continue;
    const key = `${a.pair}@${a.target}`;
    const st = (state.alerts[key] ||= {});
    let dir = a.direction || st.direction;
    if (dir !== "up" && dir !== "down") dir = q.price < a.target ? "up" : "down";
    st.direction = dir;
    const [base, quote] = a.pair.split("/");
    const reached = dir === "up" ? q.price >= a.target : q.price <= a.target;
    const gap = (Math.abs(a.target - q.price) / a.target) * 100;
    const verb = dir === "up" ? "涨到" : "跌到";
    if (reached) {
      if (!st.reached_sent) {
        msgs.push([`✅ ${a.pair} 已${verb} ${a.target}`,
          `${a.pair} 当前 ${fmt(q.price)}，已${verb}你设的提醒线 ${a.target}。\n1 ${base} = ${fmt(q.price)} ${quote}`]);
        st.reached_sent = st.approach_sent = true;
      }
    } else if (gap <= band) {
      if (!st.approach_sent) {
        msgs.push([`⏳ ${a.pair} 接近 ${a.target}`,
          `${a.pair} 当前 ${fmt(q.price)}，距离提醒线 ${a.target} 只差 ${gap.toFixed(2)}%。${verb} ${a.target} 时会再提醒你。`]);
        st.approach_sent = true;
      }
    } else if (gap > band * 2) {
      st.approach_sent = st.reached_sent = false;
    }
  }
  return msgs;
}

// ------------------------------------------------------------------ 总结与建议

function advice(q, month, c24) {
  const [base, quote] = q.pair.split("/");
  const lo = Math.min(...month), hi = Math.max(...month);
  const pos = hi === lo ? 0.5 : (q.price - lo) / (hi - lo);
  const avg = month.reduce((a, b) => a + b, 0) / month.length;
  let s;
  if (pos <= 0.25) s = `★★★ 处于近 30 天低位，用${quote}换${base}较划算，可考虑分批买入`;
  else if (q.price <= avg) s = `★★ 低于近 30 天均值，可小额分批买入${base}`;
  else if (pos < 0.75) s = "★ 高于近 30 天均值，不急的话建议观望";
  else s = `☆ 接近近 30 天高位，${base}偏贵，建议等回落`;
  if (c24 != null) {
    if (c24 <= -0.3) s += `；${base}还在走弱，可以再等等或分批`;
    else if (c24 >= 0.3) s += `；${base}短期走强，急用可先换一部分`;
  }
  return s;
}

export function buildSummary(cfg, state, quotes, now) {
  const lp = localParts(new Date(now * 1000), cfg.timezone);
  const lines = [`${lp.date} ${lp.hm}（${cfg.timezone}）`, ""];
  for (const q of Object.values(quotes)) {
    const [base, quote] = q.pair.split("/");
    const { month, day } = series(state, q, now);
    const p24 = priceAgo(state, q, now, 24), p7 = priceAgo(state, q, now, 24 * 7);
    const c24 = p24 ? pct(p24, q.price) : null;
    lines.push(`【${q.pair}】1 ${base} = ${fmt(q.price)} ${quote}`);
    if (c24 != null) {
      const lo = Math.min(...day), hi = Math.max(...day);
      lines.push(`· 24 小时 ${sign(c24)}，区间 ${fmt(lo)} ~ ${fmt(hi)}`);
    }
    if (p7) lines.push(`· 7 天 ${sign(pct(p7, q.price))}`);
    if (month.length >= 3) {
      const avg = month.reduce((a, b) => a + b, 0) / month.length;
      lines.push(`· 30 天 ${fmt(Math.min(...month))} ~ ${fmt(Math.max(...month))}，均值 ${fmt(avg)}`);
    }
    for (const a of cfg.alerts.filter((a) => a.pair === q.pair)) {
      lines.push(`· 提醒线 ${a.target}：还差 ${sign(pct(q.price, a.target))}`);
    }
    lines.push(month.length >= 3 ? `· 建议：${advice(q, month, c24)}` : "· 建议：历史数据还不够，运行几天后会给出");
    lines.push("");
  }
  lines.push("建议仅根据近期走势自动生成，不构成投资建议；银行实际换汇价会有点差。");
  return lines.join("\n");
}

export function dueSummarySlot(cfg, state, nowDate) {
  // 把「本地时间」当作 UTC 数字来比较，找最近一个已到、3 小时内、还没发过的时间点
  const lp = localParts(nowDate, cfg.timezone);
  const localNow = Date.parse(`${lp.date}T${lp.hm}:00Z`);
  let best = null;
  for (const dayOffset of [-1, 0]) {
    const d = new Date(Date.parse(`${lp.date}T00:00:00Z`) + dayOffset * DAY * 1000).toISOString().slice(0, 10);
    for (const hm of cfg.summary_times) {
      const [h, m] = hm.split(":").map(Number);
      const slot = Date.parse(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
      if (slot <= localNow && localNow - slot <= 3 * 3600 * 1000 && (!best || slot > best.t)) {
        best = { t: slot, key: `${d} ${hm}` };
      }
    }
  }
  return best && state.last_summary_slot !== best.key ? best.key : null;
}

// ------------------------------------------------------------------ 定时任务

async function fetchAll(cfg, fq = fetchQuote) {
  const pairs = [...new Set([...cfg.pairs, ...cfg.alerts.map((a) => a.pair)])];
  const results = await Promise.allSettled(pairs.map((p) => fq(p)));
  const quotes = {};
  results.forEach((r, i) => { if (r.status === "fulfilled") quotes[pairs[i]] = r.value; else console.log(r.reason.message); });
  return quotes;
}

export async function runCheck(env, nowDate = new Date(), fetcher = fetchAll, pusher = push) {
  const now = Math.floor(nowDate.getTime() / 1000);
  const cfg = await loadConfig(env), state = await loadState(env);
  const quotes = await fetcher(cfg);
  if (!Object.keys(quotes).length) throw new Error("所有汇率都获取失败");
  for (const q of Object.values(quotes)) record(state, q, now);
  for (const [t, b] of checkAlerts(cfg, state, quotes)) await pusher(env, t, b);
  const slot = dueSummarySlot(cfg, state, nowDate);
  if (slot) {
    const summaryQuotes = Object.fromEntries(cfg.pairs.filter((p) => quotes[p]).map((p) => [p, quotes[p]]));
    await pusher(env, "📊 每日汇率总结", buildSummary(cfg, state, summaryQuotes, now));
    state.last_summary_slot = slot;
  }
  await saveJSON(env, "state", state);
}

// ------------------------------------------------------------------ 聊天指令

const HELP = `可以这样跟我说：
· 澳元 / 美元 / AUD / EUR USD：查汇率（默认换成人民币）
· 1000 澳元：换算金额
· 提醒 澳元 4.6：AUD/CNY 到 4.6 附近和到达时提醒
· 提醒 美元 7.0 跌：只在跌到 7.0 时提醒（涨 / 跌可省略）
· 删除提醒 澳元 4.6，或 删除提醒 1（按列表序号）
· 关注 欧元 / 取消关注 欧元：加入或移出每日总结
· 时间 8:00 23:00：修改每日总结时间
· 接近 0.3：距离提醒线多少 % 算接近
· 列表：查看当前设置
· 总结：马上发一份总结`;

function listText(cfg) {
  const alerts = cfg.alerts.length
    ? cfg.alerts.map((a, i) => `  ${i + 1}. ${a.pair} ${a.target}${a.direction ? (a.direction === "up" ? "（涨到）" : "（跌到）") : ""}`).join("\n")
    : "  （无）";
  return `关注：${cfg.pairs.join("、") || "（无）"}\n提醒线：\n${alerts}\n总结时间：${cfg.summary_times.join("、")}（${cfg.timezone}）\n接近幅度：${cfg.approach_percent}%`;
}

export async function handleText(env, text, deps = {}) {
  const quote = deps.fetchQuote || fetchQuote;
  const t = text.trim().replace(/\s+/g, " ");
  const cfg = await loadConfig(env);
  const save = () => saveJSON(env, "config", cfg);
  let m;

  if (/^(帮助|help|\?|？|菜单)$/i.test(t)) return HELP;
  if (/^(列表|设置|状态|list)$/i.test(t)) return listText(cfg);

  if (/^总结$/.test(t)) {
    // 微信要求 5 秒内回复，总结要查多个货币对，所以先回一句，再主动推送
    const job = (async () => {
      const quotes = await fetchAll({ ...cfg, alerts: [] }, quote);
      await (deps.push || push)(env, "📊 汇率总结", buildSummary(cfg, await loadState(env), quotes, Math.floor(Date.now() / 1000)));
    })().catch((e) => console.log(e.message));
    if (deps.waitUntil) deps.waitUntil(job); else await job;
    return "正在生成总结，马上发给你。";
  }

  if ((m = t.match(/^(?:删除提醒|删提醒|取消提醒) ?(.*)$/))) {
    const arg = m[1].trim();
    let idx = -1;
    if (/^\d+$/.test(arg)) idx = Number(arg) - 1;
    else {
      const num = arg.match(/\d+(\.\d+)?/);
      const pair = normPair(arg.replace(/\d+(\.\d+)?/, ""));
      idx = cfg.alerts.findIndex((a) => a.pair === pair && (!num || a.target === Number(num[0])));
    }
    if (idx < 0 || idx >= cfg.alerts.length) return `没找到这条提醒。\n\n${listText(cfg)}`;
    const [removed] = cfg.alerts.splice(idx, 1);
    await save();
    return `已删除提醒：${removed.pair} ${removed.target}`;
  }

  if ((m = t.match(/^(?:提醒|设置提醒|提醒线) ?(.+)$/))) {
    const num = m[1].match(/\d+(\.\d+)?/);
    const pair = normPair(m[1].replace(/\d+(\.\d+)?/, "").replace(/[涨跌]/g, ""));
    if (!num || !pair) return "格式：提醒 澳元 4.6（可在末尾加 涨 / 跌）";
    const target = Number(num[0]);
    const alert = { pair, target };
    if (/涨/.test(m[1])) alert.direction = "up";
    if (/跌/.test(m[1])) alert.direction = "down";
    cfg.alerts = cfg.alerts.filter((a) => !(a.pair === pair && a.target === target));
    cfg.alerts.push(alert);
    await save();
    let now = "";
    try { now = `，当前 ${fmt((await quote(pair, false)).price)}`; } catch {}
    return `好的，${pair} 到 ${target} 附近（${cfg.approach_percent}% 以内）和到达时都会提醒你${now}。`;
  }

  if ((m = t.match(/^(取消关注|关注) ?(.+)$/))) {
    const pair = normPair(m[2]);
    if (!pair) return "格式：关注 欧元，或 关注 EUR/CNY";
    if (m[1] === "关注") {
      if (!cfg.pairs.includes(pair)) cfg.pairs.push(pair);
    } else cfg.pairs = cfg.pairs.filter((p) => p !== pair);
    await save();
    return `${m[1] === "关注" ? "已关注" : "已取消关注"} ${pair}。现在关注：${cfg.pairs.join("、") || "（无）"}`;
  }

  if ((m = t.match(/^(?:时间|总结时间) ?(.+)$/))) {
    const times = [...m[1].matchAll(/(\d{1,2})[:：点](\d{2})?/g)]
      .map((x) => `${x[1].padStart(2, "0")}:${x[2] || "00"}`)
      .filter((x) => Number(x.slice(0, 2)) < 24);
    if (!times.length) return "格式：时间 8:00 23:00";
    cfg.summary_times = times;
    await save();
    return `好的，每天 ${times.join("、")}（${cfg.timezone}）发总结。`;
  }

  if ((m = t.match(/^接近 ?(\d+(\.\d+)?)%?$/))) {
    cfg.approach_percent = Number(m[1]);
    await save();
    return `好的，距离提醒线 ${cfg.approach_percent}% 以内算「接近」。`;
  }

  // 其余当作查汇率：「澳元」「AUD」「1000 澳元」「EUR USD」
  const amt = t.match(/\d+(\.\d+)?/);
  const pair = normPair(t.replace(/\d+(\.\d+)?/, ""));
  if (!pair) return `没看懂这句话。\n\n${HELP}`;
  try {
    const q = await quote(pair, false);
    const [base, qq] = pair.split("/");
    let s = `1 ${base} = ${fmt(q.price)} ${qq}\n1 ${qq} = ${fmt(1 / q.price)} ${base}`;
    if (amt) s += `\n${Number(amt[0])} ${base} = ${(Number(amt[0]) * q.price).toFixed(2)} ${qq}`;
    return `${s}\n（${q.source}）`;
  } catch (e) {
    return `查询失败：${e.message}`;
  }
}

// ------------------------------------------------------------------ 入口

// 浏览器直接打开 Worker 网址时显示的自检页，只显示「有没有设置」，不显示具体值
async function statusPage(env) {
  const ok = (b) => (b ? "✅" : "❌");
  let kv = false, owner = null;
  try { owner = await env.FX.get("owner"); kv = true; } catch {}
  const lines = [
    "fxbot 自检",
    `${ok(kv)} 存储 FX`,
    `${ok(env.WX_TOKEN)} WX_TOKEN`,
    `${ok(env.WX_APPID)} WX_APPID`,
    `${ok(env.WX_SECRET)} WX_SECRET`,
    `${ok(env.PUSHPLUS_TOKEN)} PUSHPLUS_TOKEN（可选）`,
    `${ok(owner)} 已收到过你的微信消息`,
  ];
  try {
    const last = await env.FX.get("last_wx");
    lines.push("", `最近一次微信请求：${last || "（还没有）"}`);
  } catch {}
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const params = url.searchParams;
    if (!params.get("signature")) return statusPage(env);
    // 记录最近一次微信请求，显示在自检页上，方便排查
    const log = { at: new Date().toISOString(), method: request.method };
    const done = async (resp) => {
      log.status = resp.status;
      try { await env.FX.put("last_wx", JSON.stringify(log)); } catch {}
      console.log(JSON.stringify(log));
      return resp;
    };
    try {
      log.sig = await wxSignatureOk(env, params);
      if (!log.sig) return done(new Response("bad signature", { status: 403 }));
      if (request.method === "GET") return done(new Response(params.get("echostr") || ""));

      const xml = await request.text();
      const from = xmlField(xml, "FromUserName"), to = xmlField(xml, "ToUserName");
      const type = xmlField(xml, "MsgType");
      log.type = type;
      log.content = (xmlField(xml, "Content") || xmlField(xml, "Event")).slice(0, 30);
      if (!from) log.raw = xml.slice(0, 120);

      // 第一个发消息的人成为主人；其他人一律不理，避免被别人改设置
      let owner = await env.FX.get("owner");
      if (!owner) { owner = from; await env.FX.put("owner", from); }
      if (from !== owner) { log.note = "不是主人"; return done(xmlResponse(from, to, "这是私人机器人。")); }

      let text;
      if (type === "event") text = xmlField(xml, "Event") === "subscribe" ? `欢迎！\n\n${HELP}` : "";
      else if (type === "text") {
        try { text = await handleText(env, xmlField(xml, "Content"), { waitUntil: (p) => ctx.waitUntil(p) }); }
        catch (e) { text = `出错了：${e.message}`; log.error = e.message; }
      } else text = HELP;
      log.reply = text ? text.slice(0, 30) : "(无)";
      if (!text) return done(new Response("success"));
      return done(xmlResponse(from, to, text));
    } catch (e) {
      log.error = e.message;
      return done(new Response("success"));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
};
