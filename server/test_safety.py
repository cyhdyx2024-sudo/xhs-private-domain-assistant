import unittest
from unittest.mock import patch

import agent
import gateway


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

    def test_compliance_flags_detection(self):
        self.assertIn("第一", agent.compliance_flags("我们是全网第一的选择"))
        self.assertIn("100%", agent.compliance_flags("100% 有效，您放心"))
        self.assertIn("零风险", agent.compliance_flags("零风险，随时可以退款"))
        self.assertEqual(agent.compliance_flags("这个要看您具体怎么用，我先按实际场景帮您核对"), [])

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
        with patch.object(gateway, "PRODUCT_MODE", True):
            config = agent.resolve_model_config({
                "X-Model-Key": "test-key",
                "X-Model-Base-Url": "https://api.deepseek.com/chat/completions",
                "X-Model-Name": "deepseek-chat",
            })
            self.assertEqual(config["model"], "deepseek-chat")
            with self.assertRaisesRegex(ValueError, "model_api_key_required"):
                agent.resolve_model_config({
                    "X-Model-Base-Url": "https://api.deepseek.com/chat/completions",
                    "X-Model-Name": "deepseek-chat",
                })
            with self.assertRaisesRegex(ValueError, "model_endpoint_not_allowed"):
                agent.resolve_model_config({
                    "X-Model-Key": "test-key",
                    "X-Model-Base-Url": "https://evil-untrusted-api.com/v1",
                    "X-Model-Name": "deepseek-chat",
                })

        with patch.object(gateway, "PRODUCT_MODE", False):
            config = agent.resolve_model_config({})
            self.assertEqual(config["url"], agent.OPENCODEX_URL)
            self.assertEqual(config["key"], agent.OPENCODEX_API_KEY)
            self.assertEqual(config["model"], agent.OPENCODEX_MODEL)

    def test_existing_contact_is_not_requested_again(self):
        for latest in ["微信号: abc123", "手机：13800138000"]:
            issues = agent.reply_quality_issues(latest, [], "方便再留个联系方式吗？")
        self.assertIn("客户已经提供了联系方式，不应再次索要", issues)

    def test_acknowledgement_does_not_hide_future_contact_promise(self):
        turns = [
            {"role": "assistant", "content": "方便留个微信吗"},
            {"role": "user", "content": "demo_lead_123"},
        ]
        issues = agent.reply_quality_issues(
            "demo_lead_123", turns, "收到 稍后加你 验证信息带小红书",
        )
        self.assertIn("回复承诺执行当前会话无法核验的外部动作", issues)

    def test_searching_claim_is_rejected_for_status_question(self):
        turns = [
            {"role": "assistant", "content": "方便留个微信吗"},
            {"role": "user", "content": "demo_lead_123"},
            {"role": "user", "content": "加了吗？"},
        ]
        issues = agent.reply_quality_issues(
            "加了吗？", turns, "刚在搜 你微信昵称叫什么 我核对下",
        )
        self.assertIn("当前会话无法核验外部动作状态，回复却声称已经完成", issues)
        self.assertIn("回复承诺执行当前会话无法核验的外部动作", issues)

    def test_high_risk_contact_actions_have_post_model_fallback(self):
        turns = [
            {"role": "assistant", "content": "方便留个微信吗"},
            {"role": "user", "content": "demo_lead_123"},
        ]
        self.assertEqual(agent.post_model_safety_fallback("demo_lead_123", turns), "收到")
        self.assertEqual(
            agent.post_model_safety_fallback("加了吗？", turns + [{"role": "user", "content": "加了吗？"}]),
            "我这边暂时看不到添加状态 你那边现在有收到申请吗？",
        )

    def test_isolated_identifier_is_not_assumed_to_be_contact(self):
        turns = [{"role": "user", "content": "code998877"}]
        issues = agent.reply_quality_issues(
            "code998877", turns, "收到 微信号记下了 怎么称呼您？",
        )
        self.assertIn("缺少联系方式语境，不能把孤立字母数字串擅自当成微信号", issues)
        self.assertEqual(
            agent.post_model_safety_fallback("code998877", turns),
            "这是你的账号吗 还是想咨询其他问题？",
        )

    def test_contact_acknowledgement_does_not_start_interview(self):
        turns = [
            {"role": "assistant", "content": "方便留个微信吗"},
            {"role": "user", "content": "demo_lead_123"},
        ]
        issues = agent.reply_quality_issues(
            "demo_lead_123", turns, "收到 微信号记下了 怎么称呼您？您主要做哪块？",
        )
        self.assertIn("客户刚提供联系方式，本轮只需简短确认收到，不应立刻连问业务问题", issues)

    def test_wecom_card_click_rejects_asking_for_contact(self):
        turns = [
            {"role": "assistant", "type": "card", "content": "邀您添加我的企业微信"},
            {"role": "system", "type": "system_notice", "content": "对方已点击你的企业微信联系卡"},
        ]
        issues = agent.reply_quality_issues(
            "好的", turns, "方便留个微信吗？我发您资料",
        )
        self.assertIn("客户已点击企业微信名片，不应再次索要联系方式", issues)
        fallback = agent.post_model_safety_fallback("好的", turns)
        self.assertEqual(fallback, "看到你点开名片了 如果没跳转成功跟我说一声就行")
        for forbidden in ["稍后", "通过", "发资料", "已添加", "对接"]:
            self.assertNotIn(forbidden, fallback)

    def test_build_system_prompt_is_tenant_neutral(self):
        prompt = gateway.build_system_prompt(None)
        for phrase in ["绝对虚构", "未授权数据"]:
            self.assertNotIn(phrase, prompt)
        self.assertIn("点开名片", prompt)

    def test_build_system_prompt_uses_tenant_configuration(self):
        prompt = gateway.build_system_prompt({
            "workspace_name": "专属空间",
            "brand_name": "定制品牌",
            "business_profile": "企业工作流服务",
            "knowledge_text": "仅使用确认资料",
            "reply_preferences": "专业克制，不催促",
        })
        self.assertIn("企业工作流服务", prompt)
        self.assertIn("专业克制，不催促", prompt)

    def test_format_relative_time(self):
        now_ts = 1788166000000
        self.assertEqual(agent.format_relative_time(now_ts - 30000, now_ts), "刚刚")
        self.assertEqual(agent.format_relative_time(now_ts - 5 * 60000, now_ts), "5分钟前")
        self.assertEqual(agent.format_relative_time(now_ts - 3 * 3600000, now_ts), "3小时前")
        self.assertEqual(agent.format_relative_time(now_ts - 2 * 86400000, now_ts), "2天前")


if __name__ == "__main__":
    unittest.main()
