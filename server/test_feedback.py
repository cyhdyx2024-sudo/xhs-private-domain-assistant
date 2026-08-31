import tempfile
import unittest
from pathlib import Path

import agent
import db


class FeedbackKnowledgeBaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        db.FEEDBACK_DB = Path(self.temp_dir.name) / "feedback.sqlite3"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_save_redact_deduplicate_and_retrieve(self) -> None:
        payload = {
            "session_id": "uid-123",
            "latest_msg": "装修公司怎么获客？联系我 13800138000",
            "turns": [{"role": "user", "type": "text", "content": "装修公司怎么获客？"}],
            "ai_reply": "可以了解一下，方便留联系方式吗？",
            "human_reply": "您目前做整装还是局改？可以先按真实业务做一版样稿，看内容能否承接咨询。",
            "reason": "先确认业务类型，再用低成本样稿验证。",
        }
        first = agent.save_feedback(payload)
        second = agent.save_feedback(payload)
        matches = agent.retrieve_feedback_examples("装修整装业务怎么获客", payload["turns"])

        self.assertEqual(first["knowledge_count"], 1)
        self.assertEqual(second["knowledge_count"], 1)
        self.assertTrue(matches)
        self.assertNotIn("13800138000", matches[0]["latest_msg"])
        self.assertIn("[手机号]", matches[0]["latest_msg"])

    def test_rotate_tenant_token_invalidates_previous_token(self) -> None:
        created = agent.register_tenant("restore-test")
        rotated = agent.rotate_tenant_token(created["tenant_id"])
        self.assertIsNone(agent.get_tenant_by_token(created["access_token"]))
        self.assertEqual(agent.get_tenant_by_token(rotated["access_token"])["id"], created["tenant_id"])


if __name__ == "__main__":
    unittest.main()
