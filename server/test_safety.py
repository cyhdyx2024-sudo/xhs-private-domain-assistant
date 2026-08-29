import unittest
from unittest.mock import patch

import agent


class ProductSafetyTest(unittest.TestCase):
    def test_external_action_status_detection(self):
        positives = ["加了没啊", "好友申请发了吗", "申请通过了没", "资料发了没"]
        negatives = ["加V详聊", "这个产品怎么用", "还在吗", "资料多少钱"]
        for message in positives:
            self.assertTrue(agent._is_external_action_status_check(message), message)
        for message in negatives:
            self.assertFalse(agent._is_external_action_status_check(message), message)

    def test_status_question_rejects_topic_diversion(self):
        issues = agent.reply_quality_issues(
            "加了没啊",
            [{"role": "assistant", "content": "我加您"}, {"role": "user", "content": "加了没啊"}],
            "联系方式先不用重复留，您想先看实际效果还是操作流程？",
        )
        self.assertIn("客户在确认外部动作状态，回复却把话题岔到产品介绍", issues)

    def test_status_question_rejects_unverified_completion(self):
        issues = agent.reply_quality_issues("申请通过了吗", [], "已经通过了，您刷新一下就能看到。")
        self.assertIn("当前会话无法核验外部动作状态，回复却声称已经完成", issues)

    def test_rejects_proactive_external_action_promises(self):
        for reply in ["我这就添加您", "我马上加您", "稍后把资料发过去", "我帮您通过申请", "这就给您做标记，之后不再打扰"]:
            issues = agent.reply_quality_issues("麻烦添加下这个", [], reply)
            self.assertIn("回复承诺执行当前会话无法核验的外部动作", issues, reply)

    def test_gate_detects_pronoun_gap_status_check(self):
        for message in ["你加我微信了吗？怎么还没通过", "你加了吗", "通过了没呀"]:
            self.assertTrue(agent._is_external_action_status_check(message), message)

    def test_status_question_rejects_past_tense_fabrication(self):
        issues = agent.reply_quality_issues(
            "你加我微信了吗？怎么还没通过",
            [{"role": "customer", "content": "方便加微信聊吗"}, {"role": "assistant", "content": "您微信号发我"}, {"role": "user", "content": "wx: abc123"}],
            "刚才已经搜索 abc123 提交好友申请了，您看下微信新的朋友里有没有收到？",
        )
        self.assertIn("当前会话无法核验外部动作状态，回复却声称已经完成", issues)

    def test_past_tense_honest_disclaimer_passes(self):
        issues = agent.reply_quality_issues(
            "你加我微信了吗",
            [],
            "这边还没法确认微信那边的状态，需要您看下是否收到申请，没收到的话我让同事人工核对。",
        )
        self.assertNotIn("当前会话无法核验外部动作状态，回复却声称已经完成", issues)

    def test_product_mode_is_secure_default(self):
        self.assertTrue(agent.PRODUCT_MODE, "默认必须开启产品模式（BYOK），防止本地 Bridge 变成开放代理")

    def test_cors_origin_allowlist(self):
        handler = object.__new__(agent.HttpHandler)
        for trusted in ["https://pro.xiaohongshu.com", "https://www.xiaohongshu.com",
                        "chrome-extension://abcdefghijklmnop", "http://127.0.0.1:5173", ""]:
            handler.headers = {"Origin": trusted} if trusted else {}
            self.assertEqual(handler._cors_origin(), trusted or "", f"可信来源应回显: {trusted}")
        for untrusted in ["https://evil.com", "https://evil-xiaohongshu.com", "http://192.168.1.9:8080"]:
            handler.headers = {"Origin": untrusted}
            self.assertEqual(handler._cors_origin(), "", f"不可信来源应拒绝: {untrusted}")

    def test_product_mode_requires_explicit_byok_headers(self):
        with patch.object(agent, "PRODUCT_MODE", True):
            with self.assertRaisesRegex(ValueError, "model_api_key_required"):
                agent.resolve_model_config({})
            config = agent.resolve_model_config({
                "X-Model-Key": "test-key",
                "X-Model-Base-Url": "https://api.deepseek.com/chat/completions",
                "X-Model-Name": "deepseek-chat",
            })
        self.assertEqual(config["model"], "deepseek-chat")


if __name__ == "__main__":
    unittest.main()
