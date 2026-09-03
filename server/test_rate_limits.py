import unittest
from agent import check_rate_limits, SESSION_CALL_TIMES, TENANT_CALL_TIMES
from gateway import get_last_usage, LAST_USAGE

class RateLimitAndCircuitBreakerTest(unittest.TestCase):
    def setUp(self):
        SESSION_CALL_TIMES.clear()
        TENANT_CALL_TIMES.clear()

    def test_session_rate_limit_trips_on_third_call_within_minute(self):
        sid = "test-session-circuit"
        tid = "test-tenant"
        
        # 第一次请求：允许
        p1, err1 = check_rate_limits(tid, sid)
        self.assertTrue(p1, "First call should pass")
        self.assertEqual(err1, "")

        # 第二次请求：允许
        p2, err2 = check_rate_limits(tid, sid)
        self.assertTrue(p2, "Second call should pass")
        self.assertEqual(err2, "")

        # 第三次请求（60秒内）：强制拦截熔断！
        p3, err3 = check_rate_limits(tid, sid)
        self.assertFalse(p3, "Third call in 60s must be blocked")
        self.assertIn("60 秒内仅允许请求 2 次", err3)

    def test_tenant_rate_limit_trips_when_exceeded(self):
        tid = "busy-tenant"
        # 模拟120次调用
        for i in range(120):
            p, _ = check_rate_limits(tid, f"sess-{i}")
            self.assertTrue(p)
        
        # 第121次：租户级硬熔断！
        p_blocked, err = check_rate_limits(tid, "sess-another")
        self.assertFalse(p_blocked)
        self.assertIn("工作区每小时调用已达 120 次硬上限", err)

    def test_usage_reporting(self):
        LAST_USAGE.prompt_tokens = 42
        LAST_USAGE.completion_tokens = 18
        LAST_USAGE.total_tokens = 60
        u = get_last_usage()
        self.assertEqual(u["prompt_tokens"], 42)
        self.assertEqual(u["completion_tokens"], 18)
        self.assertEqual(u["total_tokens"], 60)

if __name__ == "__main__":
    unittest.main()
