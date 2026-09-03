"""端到端回归：启动真实 HTTP 服务，验证曾出现导入缺失的端点可用。"""
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

_tmp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
os.environ["XHS_FEEDBACK_DB"] = _tmp_db.name
_tmp_db.close()

import agent  # noqa: E402
import gateway  # noqa: E402
from db import get_tenant_by_token, sanitize_history_samples  # noqa: E402


def _request(base: str, path: str, token: str = "", payload: dict | None = None,
             extra_headers: dict | None = None) -> tuple[int, bytes]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(extra_headers or {})
    req = urllib.request.Request(base + path, data=data, headers=headers,
                                 method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        try:
            return err.code, err.read()
        finally:
            err.close()


class EndpointRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.server = ThreadingHTTPServer(("127.0.0.1", 0), agent.HttpHandler)
        except PermissionError:
            raise unittest.SkipTest("sandbox forbids local port binding")
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        status, body = _request(cls.base, "/tenant/register", payload={"workspace_name": "e2e-test-ws"})
        assert status == 201, body
        cls.token = json.loads(body)["access_token"]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        try:
            os.unlink(_tmp_db.name)
        except OSError:
            pass

    def test_feedback_stats_endpoint(self):
        status, body = _request(self.base, "/feedback/stats", self.token)
        self.assertEqual(status, 200, body)
        data = json.loads(body)
        self.assertTrue(data["ok"])
        self.assertIn("knowledge_count", data)

    def test_leads_csv_endpoint(self):
        status, body = _request(self.base, "/leads/export.csv", self.token)
        self.assertEqual(status, 200, body)
        self.assertIn("客户昵称,线索类型,联系方式,意向场景,捕获时间".encode("utf-8"), body)

    def test_capture_plain_wechat_lead_endpoint(self):
        payload = {
            "session_id": "uid-lead-1", "user_name": "小辉",
            "lead_type": "微信号", "lead_value": "demo_lead_123",
            "context_summary": "方便留个微信吗 | demo_lead_123",
            "lead_timestamp": 1788100000000,
        }
        status, body = _request(self.base, "/leads/capture", self.token, payload)
        self.assertEqual(status, 200, body)
        self.assertTrue(json.loads(body)["created"])
        status, body = _request(self.base, "/leads/capture", self.token, payload)
        self.assertEqual(status, 200, body)
        self.assertFalse(json.loads(body)["created"])

    def test_high_risk_replies_still_require_model_config(self):
        status, body = _request(self.base, "/reply", self.token, {
            "session_id": "uid-fixed-1",
            "latest_msg": "demo_lead_123",
            "turns": [
                {"role": "assistant", "content": "方便留个微信吗"},
                {"role": "user", "content": "demo_lead_123"},
            ],
        }, extra_headers={
            "X-Model-Base-Url": "https://api.openai.com/v1/chat/completions",
            "X-Model-Name": "gpt-4.1-mini",
        })
        self.assertEqual(status, 400, body)
        self.assertEqual(json.loads(body)["error"], "model_api_key_required")

    def test_local_opencodex_does_not_require_api_key(self):
        config = gateway.resolve_model_config({
            "X-Model-Base-Url": "http://127.0.0.1:10100/v1/chat/completions",
            "X-Model-Name": "google-antigravity/gemini-3.7-flash",
        })
        self.assertEqual(config["key"], "")
        self.assertEqual(config["url"], "http://127.0.0.1:10100/v1/chat/completions")

    def test_remote_model_without_key_remains_rejected(self):
        with self.assertRaisesRegex(ValueError, "model_api_key_required"):
            gateway.resolve_model_config({
                "X-Model-Base-Url": "https://api.openai.com/v1/chat/completions",
                "X-Model-Name": "gpt-4.1-mini",
            })

    @patch("gateway.request_model")
    def test_history_learning_writes_only_authenticated_tenant(self, request_model):
        status, body = _request(self.base, "/tenant/register", payload={"workspace_name": "other-ws"})
        self.assertEqual(status, 201, body)
        other_token = json.loads(body)["access_token"]
        other_before = get_tenant_by_token(other_token)
        request_model.return_value = json.dumps({
            "business_profile": "企业软件咨询",
            "reply_preferences": "短句、先回答问题、点击名片不等于添加",
            "summary": "已学习人工回复风格",
        }, ensure_ascii=False)
        status, body = _request(
            self.base, "/tenant/learn-history", self.token,
            {"sessions": [{
                "session_id": "customer-1", "user_name": "测试客户",
                "turns": [
                    {"role": "user", "content": "手机号 13800138000，怎么合作？"},
                    {"role": "assistant", "content": "你主要是自己用 还是团队一起用？"},
                ],
            }]},
            {
                "X-Model-Base-Url": "http://127.0.0.1:10100/v1/chat/completions",
                "X-Model-Name": "google-antigravity/gemini-3.7-flash",
            },
        )
        self.assertEqual(status, 200, body)
        learned = json.loads(body)
        self.assertEqual(learned["config"]["business_profile"], "企业软件咨询")
        self.assertNotIn("token_hash", learned["config"])
        self.assertEqual(get_tenant_by_token(other_token)["business_profile"], other_before["business_profile"])

    def test_history_sample_limits_and_redaction(self):
        sessions = [{
            "session_id": f"s-{index}",
            "turns": ([{"role": "user", "content": "手机号 13800138000 " * 100},
                       {"role": "assistant", "content": "人工回复" * 100}] * 20),
        } for index in range(20)]
        cleaned, stats = sanitize_history_samples(sessions)
        self.assertLessEqual(len(cleaned), 12)
        self.assertLessEqual(stats["total_chars"], 30000)
        self.assertTrue(stats["truncated"])
        self.assertNotIn("13800138000", json.dumps(cleaned, ensure_ascii=False))
        self.assertTrue(all(len(item["turns"]) <= 30 for item in cleaned))

    def test_history_learning_rejects_customer_only_samples(self):
        status, body = _request(
            self.base, "/tenant/learn-history", self.token,
            {"sessions": [{"session_id": "s", "turns": [{"role": "user", "content": "在吗"}]}]},
            {
                "X-Model-Base-Url": "http://127.0.0.1:10100/v1/chat/completions",
                "X-Model-Name": "google-antigravity/gemini-3.7-flash",
            },
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(json.loads(body)["error"], "no_valid_assistant_samples")


if __name__ == "__main__":
    unittest.main()
