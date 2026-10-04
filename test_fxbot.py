"""离线测试：用假数据跑提醒线和每日总结逻辑。运行：python -m unittest test_fxbot"""

import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import fxbot


def make_quote(pair, price):
    now = int(datetime(2026, 10, 4, tzinfo=timezone.utc).timestamp())
    daily = [(now - (30 - i) * 86400, 4.50 + 0.01 * (i % 10)) for i in range(30)]
    intraday = [(now - 86400 + i * 900, price - 0.01 + 0.0002 * i) for i in range(96)]
    return fxbot.Quote(pair, price, "test", daily, intraday)


CFG = {"timezone": "Australia/Sydney", "summary_times": ["08:00", "23:00"],
       "pairs": ["AUD/CNY"], "approach_percent": 0.5,
       "alerts": [{"pair": "AUD/CNY", "target": 4.6}]}


class AlertTests(unittest.TestCase):
    def run_at(self, state, price):
        return fxbot.check_alerts(CFG, state, {"AUD/CNY": make_quote("AUD/CNY", price)})

    def test_approach_then_reach_then_rearm(self):
        state = {"alerts": {}}
        self.assertEqual(self.run_at(state, 4.50), [])           # 远离：不提醒
        self.assertEqual(state["alerts"]["AUD/CNY@4.6"]["direction"], "up")
        msgs = self.run_at(state, 4.585)                         # 差 0.33%：接近
        self.assertIn("接近", msgs[0][0])
        self.assertEqual(self.run_at(state, 4.59), [])           # 不重复提醒
        msgs = self.run_at(state, 4.601)                         # 到达
        self.assertIn("已涨到", msgs[0][0])
        self.assertEqual(self.run_at(state, 4.62), [])           # 不重复
        self.assertEqual(self.run_at(state, 4.50), [])           # 远离后重新布防
        self.assertIn("接近", self.run_at(state, 4.58)[0][0])

    def test_down_direction(self):
        state = {"alerts": {}}
        self.assertEqual(self.run_at(state, 4.80), [])
        self.assertEqual(state["alerts"]["AUD/CNY@4.6"]["direction"], "down")
        self.assertIn("已跌到", self.run_at(state, 4.59)[0][0])


class SummaryTests(unittest.TestCase):
    def test_slots(self):
        state = {"last_summary_slot": None}
        # 悉尼 10 月 4 日 08:30（夏令时 UTC+10 → 22:30 UTC 前一天）
        now = datetime(2026, 10, 3, 22, 30, tzinfo=timezone.utc)
        slot = fxbot.due_summary_slot(CFG, state, now)
        self.assertTrue(slot.startswith("2026-10-04T08:00"))
        state["last_summary_slot"] = slot
        self.assertIsNone(fxbot.due_summary_slot(CFG, state, now))
        # 悉尼 12:00：不在任何时间点 3 小时内
        self.assertIsNone(fxbot.due_summary_slot(CFG, state, datetime(2026, 10, 4, 2, tzinfo=timezone.utc)))

    def test_summary_text(self):
        state = {"history": {}, "alerts": {}}
        now = datetime(2026, 10, 4, tzinfo=timezone.utc)
        text = fxbot.build_summary(CFG, state, {"AUD/CNY": make_quote("AUD/CNY", 4.52)}, now)
        self.assertIn("1 AUD = 4.5200 CNY", text)
        self.assertIn("建议：", text)
        self.assertIn("提醒线 4.6", text)
        print("\n" + text)


class CheckTests(unittest.TestCase):
    def test_check_end_to_end(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d, "c.toml")
            cfg.write_text('pairs=["AUD/CNY"]\n[[alerts]]\npair="AUD/CNY"\ntarget=4.6\n')
            with mock.patch.object(fxbot, "CONFIG_PATH", cfg), \
                 mock.patch.object(fxbot, "STATE_PATH", Path(d, "s.json")), \
                 mock.patch.object(fxbot, "fetch_quote", lambda p, **k: make_quote(p, 4.599)), \
                 mock.patch.dict(os.environ, {"PUSHPLUS_TOKEN": "", "SERVERCHAN_KEY": ""}), \
                 mock.patch.object(fxbot, "push") as push:
                fxbot.cmd_check(datetime(2026, 10, 3, 21, 5, tzinfo=timezone.utc))
                titles = [c.args[0] for c in push.call_args_list]
                self.assertEqual(len(titles), 2, titles)  # 接近提醒 + 08:00 总结
                push.reset_mock()
                fxbot.cmd_check(datetime(2026, 10, 3, 21, 35, tzinfo=timezone.utc))
                push.assert_not_called()


if __name__ == "__main__":
    unittest.main()
