import base64
import json
import urllib.request
from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import os

for font_path in [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Songti.ttc"
]:
    if os.path.exists(font_path):
        try:
            pdfmetrics.registerFont(TTFont("ChineseFont", font_path))
            break
        except Exception:
            pass

pdf_path = Path("server/data/新作AI2.0官方产品手册.pdf")
doc = SimpleDocTemplate(str(pdf_path), pagesize=letter)
styles = getSampleStyleSheet()

body_style = ParagraphStyle(
    'ChineseBody',
    fontName='ChineseFont' if 'ChineseFont' in pdfmetrics.getRegisteredFontNames() else 'Helvetica',
    fontSize=11,
    leading=18,
    textColor='#1e293b'
)

title_style = ParagraphStyle(
    'ChineseTitle',
    fontName='ChineseFont' if 'ChineseFont' in pdfmetrics.getRegisteredFontNames() else 'Helvetica',
    fontSize=18,
    leading=24,
    textColor='#0f172a',
    spaceAfter=12
)

story = []
content_text = Path("server/data/seed_knowledge_xinzuo.md").read_text(encoding="utf-8")

for line in content_text.split("\n"):
    line = line.strip()
    if not line:
        story.append(Spacer(1, 8))
    elif line.startswith("#"):
        story.append(Paragraph(line.replace("#", "").strip(), title_style))
    else:
        story.append(Paragraph(line, body_style))

doc.build(story)
print(f"Generated PDF: {pdf_path} ({pdf_path.stat().st_size} bytes)")

pdf_bytes = pdf_path.read_bytes()
b64_content = base64.b64encode(pdf_bytes).decode("utf-8")

req = urllib.request.Request(
    "http://127.0.0.1:18195/knowledge/upload",
    data=json.dumps({
        "filename": "新作AI2.0官方产品手册.pdf",
        "content_base64": b64_content
    }).encode("utf-8"),
    headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer xhs_live_87EBDO26zZKNv7NlmuZgc-TOaSyRyH7UU47EPMH-Tag",
        "X-Model-Key": "sk-dummy-for-ingest",
        "X-Model-Base-Url": "https://api.deepseek.com/chat/completions",
        "X-Model-Name": "deepseek-chat"
    }
)

try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        print("Upload Result:", result)
except Exception as e:
    print("Upload Failed:", e)
