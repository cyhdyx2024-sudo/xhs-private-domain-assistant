"""端到端回归：启动真实 HTTP 服务，验证曾出现导入缺失的端点可用。"""
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

_tmp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
os.environ["XHS_FEEDBACK_DB"] = _tmp_db.name
_tmp_db.close()

import agent  # noqa: E402


def _request(base: str, path: str, token: str = "", payload: dict | None = None) -> tuple[int, bytes]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, headers=headers,
                                 method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


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


if __name__ == "__main__":
    unittest.main()
