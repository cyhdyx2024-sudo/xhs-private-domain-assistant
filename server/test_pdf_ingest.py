import tempfile
import unittest
from pathlib import Path
import db
import rag

class PdfIngestRegressionTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        db.FEEDBACK_DB = Path(self.temp_dir.name) / "feedback.sqlite3"
        rag.FEEDBACK_DB = db.FEEDBACK_DB
        db.init_feedback_db()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_extract_and_ingest_pdf(self):
        pdf_path = Path(__file__).resolve().parent / "data" / "新作AI2.0官方产品手册.pdf"
        if not pdf_path.exists():
            self.skipTest("PDF sample not generated yet")
        pdf_bytes = pdf_path.read_bytes()
        text, stype = rag.extract_uploaded_text("新作AI2.0官方产品手册.pdf", pdf_bytes)
        self.assertEqual(stype, "pdf")
        self.assertGreater(len(text), 100)
        tenant = db.register_tenant("My_Workspace")
        tenant_obj = {"id": tenant["tenant_id"], "workspace_name": "My_Workspace"}
        res = rag.ingest_knowledge_document(tenant_obj, "新作AI2.0官方产品手册.pdf", text, stype, "", None)
        self.assertTrue(res.get("id"))
        self.assertGreater(res.get("chunk_count", 0), 0)

if __name__ == "__main__":
    unittest.main()
