# 聊天版汇率机器人（微信测试号 + Cloudflare Workers）

在微信里直接跟它说话：

| 你发 | 它做 |
|---|---|
| `澳元` / `美元` / `AUD` / `欧元 美元` | 查汇率（默认换成人民币） |
| `1000 澳元` | 换算金额 |
| `提醒 澳元 4.6` | AUD/CNY 接近 4.6 和到达 4.6 时各提醒一次 |
| `提醒 美元 7.0 跌` | 只在跌到 7.0 时提醒（涨 / 跌可省略，省略时自动判断） |
| `删除提醒 1` / `删除提醒 澳元 4.6` | 删除提醒 |
| `关注 欧元` / `取消关注 欧元` | 加入或移出每日总结 |
| `时间 8:00 23:00` | 改每日总结时间（悉尼时间） |
| `接近 0.3` | 距离提醒线多少 % 算「接近」 |
| `列表` | 查看当前设置 |
| `总结` | 马上发一份总结 |
| `帮助` | 显示上面这些 |

全部免费，不需要自己的电脑或服务器。只有第一个给测试号发消息的人（你）能使用，其他人发消息会被忽略。

## 部署步骤（大约 15 分钟）

### 1. 建 Worker
1. 注册并登录 https://dash.cloudflare.com （免费）。
2. 左侧 **Workers & Pages → Create → Create Worker**，名字填 `fx-bot`，点 Deploy。
3. 点 **Edit code**，把编辑器里的内容全部删掉，粘贴本目录 `worker.js` 的全部内容，点 **Deploy**。
4. 记下 Worker 的网址，形如 `https://fx-bot.xxxx.workers.dev`。

### 2. 加存储
1. 左侧 **Storage & Databases → KV → Create**，名字填 `fx`。
2. 回到 Worker → **Settings → Bindings → Add → KV namespace**，Variable name 填 `FX`，选刚建的 `fx`。

### 3. 申请微信测试号
1. 打开 https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login ，用微信扫码登录。
2. 页面上能看到 **appID** 和 **appsecret**，先别关页面。

### 4. 填变量
Worker → **Settings → Variables and Secrets → Add**：

| 名字 | 类型 | 值 |
|---|---|---|
| `WX_TOKEN` | Text | 自己随便编一串英文数字，比如 `fxbot2026abc` |
| `WX_APPID` | Text | 测试号 appID |
| `WX_SECRET` | Secret | 测试号 appsecret |
| `PUSHPLUS_TOKEN` | Secret | 可选：你的 PushPlus token，微信发送失败时作为备用 |

### 5. 定时任务
Worker → **Settings → Trigger Events（或 Triggers）→ Add → Cron Triggers**，填 `*/15 * * * *`（每 15 分钟检查一次）。

### 6. 连上微信
1. 回到测试号页面，「接口配置信息」点修改：URL 填第 1 步的 Worker 网址，Token 填和 `WX_TOKEN` 一样的值，点提交，显示「配置成功」即可。
2. 用微信扫测试号页面上的二维码关注，然后发 `帮助`。

### 7. 关掉旧的 GitHub 定时任务
GitHub 仓库 → Actions → 汇率机器人 → 右上角 `···` → **Disable workflow**，避免收到重复的总结。

## 注意
- 微信规定：机器人主动发给你的消息（提醒、每日总结），要求你在 **48 小时内跟测试号说过话**。平时偶尔发一句 `列表` 就行；超过 48 小时，如果填了 `PUSHPLUS_TOKEN`，会改用 PushPlus 推送，不会漏掉。
- 如果第 6 步提交时提示「配置失败」，可能是微信服务器访问不了 `workers.dev` 域名（在国内有时会被屏蔽）。这种情况需要给 Worker 绑定一个自己的域名，告诉我，我来帮你处理。

## 测试
`node --test`（在本目录运行，离线测试，不访问网络）
