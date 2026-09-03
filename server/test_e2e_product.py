import json
import urllib.request
import threading
import unittest
import agent
from http.server import ThreadingHTTPServer

class ProductEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), agent.HttpHandler)
        cls.port = cls.server.server_address[1]
        cls.base = 'http://127.0.0.1:' + str(cls.port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request_json(self, path, token='', payload=None, headers=None):
        h = {'Content-Type': 'application/json'}
        if token:
            h['Authorization'] = 'Bearer ' + token
        if headers:
            h.update(headers)
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode('utf-8') if payload else None,
            headers=h,
            method='POST' if payload else 'GET'
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))

    def test_01_opencodex_connectivity(self):
        req = urllib.request.Request(
            'http://127.0.0.1:10100/v1/chat/completions',
            data=json.dumps({
                'model': 'google-antigravity/gemini-3.7-flash',
                'messages': [{'role': 'user', 'content': '请只回复：OK'}],
                'max_tokens': 500
            }).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            content = data['choices'][0]['message'].get('content')
            self.assertTrue(content is not None)

    def test_02_full_product_flow(self):
        status, reg = self.request_json('/tenant/register', payload={'workspace_name': 'E2E测试工作区'})
        self.assertEqual(status, 201)
        token = reg['access_token']

        status, cfg = self.request_json('/tenant/config', token)
        self.assertEqual(status, 200)
        self.assertIn('新作AI', cfg['config']['brand_name'])

        status, reply_data = self.request_json(
            '/reply', token,
            payload={
                'session_id': 'cust-real-001',
                'user_name': '创业者小李',
                'latest_msg': '你们这个工具支持什么格式的排版啊？能做小红书卡片吗？',
                'turns': [
                    {'role': 'user', 'content': '你们这个工具支持什么格式的排版啊？能做小红书卡片吗？'}
                ]
            },
            headers={
                'X-Model-Base-Url': 'http://127.0.0.1:10100/v1/chat/completions',
                'X-Model-Name': 'google-antigravity/gemini-3.7-flash'
            }
        )
        self.assertEqual(status, 200)
        self.assertTrue(len(reply_data['reply']) >= 5)

        status, wecom_reply = self.request_json(
            '/reply', token,
            payload={
                'session_id': 'cust-real-002',
                'user_name': '客户B',
                'latest_msg': '好的',
                'turns': [
                    {'role': 'assistant', 'type': 'card', 'content': '邀您添加企业微信'},
                    {'role': 'system', 'type': 'system_notice', 'content': '对方已点击你的企业微信联系卡'},
                    {'role': 'user', 'content': '好的'}
                ]
            },
            headers={
                'X-Model-Base-Url': 'http://127.0.0.1:10100/v1/chat/completions',
                'X-Model-Name': 'google-antigravity/gemini-3.7-flash'
            }
        )
        self.assertEqual(status, 200)
        self.assertNotIn('稍后在企微', wecom_reply['reply'])
        self.assertNotIn('发资料', wecom_reply['reply'])

        sample_sessions = [
            {
                'session_id': 'sample-001',
                'turns': [
                    {'role': 'user', 'content': '你好，想了解一下怎么试用新作2.0？'},
                    {'role': 'assistant', 'content': '收到！新作2.0电脑端内测已开放，方便留个微信号吗？我发您电脑端体验通道和算力福利～'}
                ]
            }
        ]
        status, learn_res = self.request_json(
            '/tenant/learn-history', token,
            payload={'sessions': sample_sessions},
            headers={
                'X-Model-Base-Url': 'http://127.0.0.1:10100/v1/chat/completions',
                'X-Model-Name': 'google-antigravity/gemini-3.7-flash'
            }
        )
        self.assertEqual(status, 200)
        self.assertTrue(learn_res['ok'])
        self.assertTrue(bool(learn_res['summary']))

        status, lead_res = self.request_json(
            '/leads/capture', token,
            payload={
                'session_id': 'lead-cust-001',
                'user_name': '上海美业主理人',
                'lead_type': '微信号',
                'lead_value': 'meiye_vip888',
                'context_summary': '方便留微信吗 | meiye_vip888',
                'lead_timestamp': None
            }
        )
        self.assertEqual(status, 200)
        self.assertTrue(lead_res['created'])

        status, report = self.request_json('/report/today', token)
        self.assertEqual(status, 200)
        self.assertGreaterEqual(report['replies'], 1)
        self.assertGreaterEqual(report['leads'], 1)

if __name__ == '__main__':
    unittest.main()
