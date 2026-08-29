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
        for reply in ["我这就添加您", "我马上加您", "稍后把资料发过去", "我帮您通过申请"]:
            issues = agent.reply_quality_issues("麻烦添加下这个", [], reply)
            self.assertIn("回复承诺执行当前会话无法核验的外部动作", issues, reply)

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
