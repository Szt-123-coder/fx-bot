# 汇率机器人

查询任意汇率、监控 USD/CNY 和 AUD/CNY、提醒线（接近和到达各提醒一次）、每天两次总结并给出买入建议，推送到微信。

- 汇率数据：Yahoo Finance（免费、盘中实时）；拿不到时自动改用 open.er-api.com / fawazahmed0（每日更新）。
- 微信推送：PushPlus（或 Server酱，二选一）。
- 运行方式：GitHub Actions 定时任务（免费，不用自己开电脑），每 30 分钟检查一次。
- 只用 Python 标准库，不需要安装任何依赖。

## 1. 获取微信推送 token

PushPlus：微信关注公众号「pushplus 推送加」，或打开 https://www.pushplus.plus 用微信扫码登录，在「发送消息 → 一对一消息」里复制你的 token。

（备选 Server酱：https://sct.ftqq.com 微信扫码登录，复制 SendKey。）

token 等同于给你微信发消息的钥匙，只填到 GitHub Secrets 里，不要写进文件或发到聊天里。

## 2. 部署到 GitHub

1. 把这个文件夹建成一个 GitHub 仓库（建议设为 Private 也可以，每月 2000 分钟免费额度够用）。
2. 仓库 Settings → Secrets and variables → Actions → New repository secret，名字填 `PUSHPLUS_TOKEN`，值填上一步的 token。
3. Actions 页面启用工作流。之后每 30 分钟自动检查，到 08:00 和 23:00（悉尼时间）发总结。

## 3. 修改设置

全部在 `config.toml`：
- `summary_times`：总结时间，比如改成 `["07:30", "22:00"]`
- `pairs`：关注的货币对
- `approach_percent`：距离提醒线多少百分比算「接近」，默认 0.5%
- `[[alerts]]`：提醒线，可以写多条

## 4. 随时查汇率

- 手机：GitHub App → 仓库 → Actions → 汇率机器人 → Run workflow，填 `AUD`、`CNY`、金额，结果推送到微信。
- 电脑：`python fxbot.py rate AUD CNY 1000`

## 其他命令

```
python fxbot.py check          # 检查提醒线，到点发总结（定时任务用的就是这个）
python fxbot.py summary --push # 立刻发一份总结
python fxbot.py test-push      # 发测试消息
python fxbot.py loop 15        # 不用 GitHub，在自己电脑/服务器上常驻运行，每 15 分钟检查
python -m unittest test_fxbot  # 离线测试
```

买入建议依据：当前价在近 30 天区间的位置、和 30 天均值比较、24 小时涨跌。仅供参考，不构成投资建议。
