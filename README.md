# 汇率机器人

监控人民币兑美元、人民币兑澳元等汇率：设置提醒线（接近和到达时各提醒一次），每天定时发送波动总结和买入建议，推送到微信。

提供两个版本，**选一个用就行，不要同时开**（否则会收到两份提醒和总结）：

| | 版本一：微信提醒版 | 版本二：聊天机器人版 |
|---|---|---|
| 适合 | 只想在微信里收提醒和每日总结 | 还想随时用聊天的方式查汇率、改设置 |
| 微信推送（提醒、总结） | ✅ PushPlus | ✅ PushPlus |
| 查汇率 | GitHub App 里手动运行一次，结果推到微信 | 网页里直接问，比如「现在适合换澳元吗」 |
| 修改提醒线 / 关注货币 | 改 `config.toml` 文件 | 聊天里说一句，比如「澳元到 4.6 提醒我」 |
| 中国银行买入 / 卖出价 | — | ✅ |
| AI 对话 | — | ✅ Cloudflare 免费 AI |
| 运行在 | GitHub Actions，每 30 分钟检查 | Cloudflare Workers，每 15 分钟检查 |
| 代码 | `fxbot.py`（Python） | `worker/worker.js`（JavaScript） |
| 费用 | 免费 | 免费 |

两个版本都需要先准备 **PushPlus token**：微信关注公众号「pushplus 推送加」，或打开 https://www.pushplus.plus 用微信扫码登录，完成实名认证后，在「发送消息 → 一对一消息」里复制 token。token 只填到 GitHub / Cloudflare 的 Secrets 里，不要写进文件或发到聊天里。

---

## 版本一：微信提醒版

只用 Python 标准库，不需要安装依赖。

### 部署
1. 仓库 Settings → Secrets and variables → Actions → New repository secret，名字填 `PUSHPLUS_TOKEN`，值填 token。
2. 打开 Actions 页面，启用「汇率机器人」工作流。之后每 30 分钟自动检查一次，到 08:00 和 23:00（悉尼时间）发总结。

### 修改设置
全部在 `config.toml` 里：
- `summary_times`：总结时间，例如 `["07:30", "22:00"]`
- `pairs`：关注的货币对
- `approach_percent`：距离提醒线多少百分比算「接近」，默认 0.5
- `[[alerts]]`：提醒线，可以写多条

### 随时查汇率
- 手机：GitHub App → 仓库 → Actions → 汇率机器人 → Run workflow，填 `AUD`、`CNY` 和金额，结果推送到微信。
- 电脑：`python fxbot.py rate AUD CNY 1000`

### 其他命令
```
python fxbot.py check          # 检查提醒线，到点发总结（定时任务用的就是这个）
python fxbot.py summary --push # 立刻发一份总结
python fxbot.py test-push      # 发测试消息
python fxbot.py loop 15        # 不用 GitHub，在自己电脑 / 服务器上常驻运行，每 15 分钟检查
python -m unittest test_fxbot  # 离线测试
```

---

## 版本二：聊天机器人版

在手机网页里像聊天一样使用，提醒和每日总结仍然推送到微信。完整说明见 [worker/README.md](worker/README.md)。

### 能做什么
- 用平常的话提问：「现在适合换澳元吗」「最近美元涨了还是跌了」「澳元涨到 4.65 的时候提醒我」「把欧元也加进每天的总结」
- 也可以用简短指令：`澳元`、`1000 澳元`、`中行 澳元`、`提醒 澳元 4.6`、`删除提醒 1`、`关注 欧元`、`时间 8:00 23:00`、`列表`、`总结`、`帮助`
- 查汇率时同时显示市场中间价和中国银行现汇 / 现钞买卖价

### 部署（Cloudflare 免费账号）
1. Cloudflare 控制台 → Workers & Pages → Create → 从 GitHub 导入这个仓库。Build command 留空，Deploy command 填 `cd worker && npx wrangler deploy`。
2. Worker → Settings → Variables and Secrets，添加以下 Secret：
   - `PUSHPLUS_TOKEN`：PushPlus token
   - `WEB_PASSWORD`：网页登录密码（建议 12 位以上）
3. Worker → Domains：确认 `fx-bot.<你的子域名>.workers.dev` 那一行的开关是打开的。
4. 用手机打开这个网址，输入密码就能开始聊。在浏览器菜单里选「添加到主屏幕」，用起来像一个 App。
5. 如果之前用过版本一，到 GitHub → Actions → 汇率机器人 → `···` → Disable workflow，关掉版本一。

存储和每 15 分钟的定时任务会在部署时自动创建。自检页：`https://fx-bot.<你的子域名>.workers.dev/status`

---

## 数据来源
- 市场汇率：Yahoo Finance（盘中实时），拿不到时改用 open.er-api.com
- 银行价（仅版本二）：中国银行外汇牌价
- 微信推送：PushPlus

买入建议依据：当前价在近 30 天区间里的位置、和 30 天均值的比较、24 小时涨跌。仅供参考，不构成投资建议。
