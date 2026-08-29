from __future__ import annotations

def extract_contact_lead(text: str) -> tuple[str, str] | None:
    if not text:
        return None
    phone_match = re.search(r'(?:1[3-9]\d{9})', text)
    if phone_match:
        return ("手机号", phone_match.group(0))
    wechat_match = re.search(r'(?:微信号?|vx|wx|VX)[\s:：_\-]*([a-zA-Z][a-zA-Z0-9_-]{5,19}|1[3-9]\d{9})', text, re.IGNORECASE)
    if wechat_match:
        return ("微信号", wechat_match.group(1) or wechat_match.group(0))
    return None

def record_tenant_lead(tenant_id: str, session_id: str, user_name: str, text: str) -> bool:
    lead = extract_contact_lead(text)
    if not lead or not tenant_id:
        return False
    lead_type, lead_value = lead
    now = datetime.now(timezone.utc).isoformat()
    try:
        with sqlite3.connect(FEEDBACK_DB) as conn:
            conn.execute("""
                INSERT INTO tenant_leads (id, tenant_id, session_id, user_name, lead_type, lead_value, context_summary, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, lead_type, lead_value) DO UPDATE SET
                    user_name=excluded.user_name,
                    context_summary=excluded.context_summary,
                    created_at=excluded.created_at
            """, (f"lead_{secrets.token_hex(10)}", tenant_id, session_id, user_name, lead_type, lead_value, clean_analysis_text(text, 200), now))
        return True
    except Exception as e:
        print(f"[Lead Record Error] {e}")
        return False

def list_tenant_leads(tenant_id: str) -> list[dict]:
    if not tenant_id:
        return []
    with sqlite3.connect(FEEDBACK_DB) as conn:
        rows = conn.execute(
            "SELECT id, session_id, user_name, lead_type, lead_value, context_summary, created_at FROM tenant_leads WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100",
            (tenant_id,)
        ).fetchall()
        return [dict(zip(["id", "session_id", "user_name", "lead_type", "lead_value", "context_summary", "created_at"], row)) for row in rows]

def add_tenant_faq(tenant_id: str, question: str, answer: str, keywords: str) -> dict:
    faq_id = f"faq_{secrets.token_hex(10)}"
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.execute(
            "INSERT INTO tenant_faq (id, tenant_id, question, answer, keywords, enabled, usage_count, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?)",
            (faq_id, tenant_id, clean_analysis_text(question, 200), clean_analysis_text(answer, 1000), clean_analysis_text(keywords, 200), now)
        )
    return {"id": faq_id, "question": question, "answer": answer, "keywords": keywords}

def list_tenant_faqs(tenant_id: str) -> list[dict]:
    if not tenant_id:
        return []
    with sqlite3.connect(FEEDBACK_DB) as conn:
        rows = conn.execute(
            "SELECT id, question, answer, keywords, enabled, usage_count, created_at FROM tenant_faq WHERE tenant_id=? ORDER BY created_at DESC",
            (tenant_id,)
        ).fetchall()
        return [dict(zip(["id", "question", "answer", "keywords", "enabled", "usage_count", "created_at"], row)) for row in rows]

def delete_tenant_faq(tenant_id: str, faq_id: str) -> bool:
    with sqlite3.connect(FEEDBACK_DB) as conn:
        cur = conn.execute("DELETE FROM tenant_faq WHERE id=? AND tenant_id=?", (faq_id, tenant_id))
        return cur.rowcount > 0

def retrieve_faq_matches(query: str, tenant_id: str) -> list[dict]:
    if not query or not tenant_id:
        return []
    q_terms = _terms(query)
    with sqlite3.connect(FEEDBACK_DB) as conn:
        rows = conn.execute(
            "SELECT id, question, answer, keywords FROM tenant_faq WHERE tenant_id=? AND enabled=1",
            (tenant_id,)
        ).fetchall()
        matched = []
        for r in rows:
            q_text = r[1]
            kw_text = r[3]
            combined_terms = _terms(f"{q_text} {kw_text}")
            overlap = len(q_terms & combined_terms)
            if overlap > 0 or query in q_text or q_text in query:
                matched.append({"id": r[0], "question": r[1], "answer": r[2], "score": overlap})
        matched.sort(key=lambda x: x["score"], reverse=True)
        return matched[:3]

#!/usr/bin/env python3


import argparse
import base64
import binascii
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import subprocess
import time
import urllib.request
import urllib.error
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

OPENCODEX_URL = os.environ.get("OPENCODEX_URL", "http://127.0.0.1:10100/v1/chat/completions")
OPENCODEX_API_KEY = os.environ.get("OPENCODEX_API_KEY", "")
OPENCODEX_MODEL = os.environ.get("OPENCODEX_MODEL", "google-antigravity/gemini-3.7-flash")
PRODUCT_MODE = os.environ.get("XHS_PRODUCT_MODE", "0") == "1"
ALLOWED_MODEL_HOSTS = {
    host.strip().lower() for host in os.environ.get(
        "XHS_ALLOWED_MODEL_HOSTS",
        "api.openai.com,api.deepseek.com,dashscope.aliyuncs.com,open.bigmodel.cn,api.moonshot.cn,api.siliconflow.cn,ark.cn-beijing.volces.com,api.minimax.chat,openrouter.ai",
    ).split(",") if host.strip()
}
FEEDBACK_DB = Path(os.environ.get(
    "XHS_FEEDBACK_DB",
    Path(__file__).resolve().parent / "data" / "xhs_reply_feedback.sqlite3",
))

SYSTEM_PROMPT = """你是小红书私信顾问。你的目标不是套模板索要联系方式，而是先看懂这位客户刚刚说了什么，再自然推进下一步。

回复决策规则：
1. 先回答客户最后一条消息中的问题或承接其具体信息；至少引用一个当前会话里的具体点。
2. 必须结合完整多轮对话，不能重复客服上一轮已经介绍过的卖点、问题或留资请求。
3. 不得根据昵称猜行业、身份或需求；没有证据时用一个简短问题澄清。
4. 客户只是进入会话、发了空泛问候或分享卡片时，不得强行套家装、美业、投资人等身份。
5. 若客户明确自述是投资人或合作方，可以项目负责人 Jay 身份承接；但不能只做身份介绍，必须逐项回应他提到的 Demo、数据、合作诉求。未提供的商业数据只说明可按真实口径整理，绝不编造。
6. 若客户提供了联系方式，只确认已收到并说明下一步，不再次索要。
7. 每次最多推进一个动作：回答问题、了解场景、邀约样稿或承接留资四选一；禁止一条消息同时堆四五个卖点。
8. 不使用虚假承诺、夸张 ROI、未经证实的客户数据；不主动发送站外联系方式。
9. 价格、导出格式、API、额度、席位、交付时间等属于硬事实。上下文没有明确口径时，直接说明需要核对当前页面，不能补全一个听起来合理的答案。

拟人化规则（优先服从真实上下文）：
10. 不要自称“AI助手”“智能客服”，不要每次重新介绍产品；客户没有问名字时，不主动报身份。
11. 不要机械称呼昵称，不要每条都“您好/感谢咨询/很高兴为您服务”；只有对话需要时才使用一次自然回应。
12. 像一个真正负责项目的人在聊天：先回应客户刚说的具体内容，再给一个小而明确的下一步；一次最多问一个问题。
13. 允许自然短句、停顿和轻微口语化（如“嗯，明白”“您先看也可以”“这个要看您具体怎么用”），但不能堆“哈哈、呢、呀”、Emoji 或故意装熟。
14. 不复述客户已经说过的话，不把多个卖点拼成广告，不用“赋能、闭环、抓手、降本增效、全方位”等销售腔。
15. 客户只是观望、拒绝留资或表达犹豫时，先降低压力、继续提供判断依据，不要立刻追问联系方式。

输出要求：只输出可直接发给客户的中文回复。自然、具体、像真人，通常 25~90 字；不加标题、不解释策略、不堆 Emoji。"""

OWNER_DEFAULTS = {
    "workspace_name": "新作 AI",
    "account_id": "49321885008",
    "business_line": "new-ai",
    "brand_name": "新作 AI 2.0",
    "business_profile": "面向有获客需求的个人和中小企业，把业务知识库、3:4 多页卡片排版和行业模板串成内容生产流程。",
    "knowledge_text": "可以用客户真实业务资料做低摩擦样稿；价格、额度、席位和功能状态以当前产品页面为准。",
    "reply_preferences": "先回应具体问题，一次只推进一个动作；少寒暄、少销售腔，不主动索要联系方式。",
}


def token_hash(value: str) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()

def redact_sensitive(value: str) -> str:
    """反馈知识库只保留可复用语义，不保存客户的明文联系方式。"""
    text = str(value or "")
    text = re.sub(r"(?<!\d)1[3-9]\d{9}(?!\d)", "[手机号]", text)
    text = re.sub(
        r"(?i)(微信号?|vx|wx)\s*[:：_\-]?\s*[a-z][a-z0-9_-]{5,19}",
        r"\1：[微信号]",
        text,
    )
    return text.strip()


def init_feedback_db() -> None:
    FEEDBACK_DB.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reply_feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fingerprint TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                session_hash TEXT NOT NULL,
                latest_msg TEXT NOT NULL,
                context_json TEXT NOT NULL,
                ai_reply TEXT NOT NULL,
                human_reply TEXT NOT NULL,
                reason TEXT NOT NULL,
                analysis_json TEXT NOT NULL,
                usage_count INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reply_feedback_created_at ON reply_feedback(created_at DESC)")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(reply_feedback)").fetchall()}
        if "scope" not in columns:
            conn.execute("ALTER TABLE reply_feedback ADD COLUMN scope TEXT NOT NULL DEFAULT 'default'")
        if "enabled" not in columns:
            conn.execute("ALTER TABLE reply_feedback ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
        if "disabled_at" not in columns:
            conn.execute("ALTER TABLE reply_feedback ADD COLUMN disabled_at TEXT NOT NULL DEFAULT ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reply_feedback_scope ON reply_feedback(scope, created_at DESC)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tenants (
                id TEXT PRIMARY KEY,
                token_hash TEXT NOT NULL UNIQUE,
                workspace_name TEXT NOT NULL,
                account_id TEXT NOT NULL DEFAULT '',
                business_line TEXT NOT NULL DEFAULT 'default',
                brand_name TEXT NOT NULL DEFAULT '',
                business_profile TEXT NOT NULL DEFAULT '',
                knowledge_text TEXT NOT NULL DEFAULT '',
                reply_preferences TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS knowledge_documents (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                title TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_uri TEXT NOT NULL DEFAULT '',
                checksum TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL,
                status_detail TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(tenant_id, checksum)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_knowledge_documents_tenant ON knowledge_documents(tenant_id, updated_at DESC)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tenant_faq (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                keywords TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                usage_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tenant_leads (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                user_name TEXT NOT NULL,
                lead_type TEXT NOT NULL,
                lead_value TEXT NOT NULL,
                context_summary TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(tenant_id, lead_type, lead_value)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS knowledge_chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                heading TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                terms_json TEXT NOT NULL,
                embedding_json TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant ON knowledge_chunks(tenant_id, document_id)")
def register_tenant(workspace_name: str) -> dict:
    init_feedback_db()
    tenant_id = f"t_{secrets.token_hex(8)}"
    access_token = f"xhs_live_{secrets.token_urlsafe(32)}"
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.execute(
            """INSERT INTO tenants
               (id, token_hash, workspace_name, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?)""",
            (tenant_id, token_hash(access_token), clean_analysis_text(workspace_name or "我的工作区", 80), now, now),
        )
    return {"tenant_id": tenant_id, "access_token": access_token}


def get_tenant_by_token(access_token: str) -> dict | None:
    if not access_token:
        return None
    init_feedback_db()
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM tenants WHERE token_hash = ?", (token_hash(access_token),)).fetchone()
    return dict(row) if row else None


def update_tenant(tenant_id: str, payload: dict) -> dict:
    allowed = {
        "workspace_name": 80, "account_id": 40, "business_line": 80,
        "brand_name": 80, "business_profile": 4000, "knowledge_text": 12000,
        "reply_preferences": 3000,
    }
    values = {key: clean_analysis_text(payload.get(key) or "", limit) for key, limit in allowed.items()}
    values["account_id"] = re.sub(r"[^0-9A-Za-z_-]", "", values["account_id"])
    values["business_line"] = normalize_scope(values["business_line"] or "default")
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.execute(
            """UPDATE tenants SET workspace_name=?, account_id=?, business_line=?, brand_name=?,
               business_profile=?, knowledge_text=?, reply_preferences=?, updated_at=? WHERE id=?""",
            (values["workspace_name"] or "我的工作区", values["account_id"], values["business_line"],
             values["brand_name"], values["business_profile"], values["knowledge_text"],
             values["reply_preferences"], now, tenant_id),
        )
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
    result = dict(row)
    result.pop("token_hash", None)
    return result


def tenant_scope(tenant: dict | None, requested: str = "default") -> str:
    if not tenant:
        return normalize_scope(requested)
    return normalize_scope(f"tenant:{tenant['id']}:xhs:{tenant.get('account_id') or 'unconfigured'}:{tenant.get('business_line') or 'default'}")


def _xml_text(data: bytes) -> str:
    root = ET.fromstring(data)
    lines: list[str] = []
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] in {"t", "tab", "br"}:
            if node.tag.endswith("tab"):
                lines.append("\t")
            elif node.tag.endswith("br"):
                lines.append("\n")
            elif node.text:
                lines.append(node.text)
        if node.tag.rsplit("}", 1)[-1] in {"p", "tr"}:
            lines.append("\n")
    return re.sub(r"\n{3,}", "\n\n", "".join(lines)).strip()


def extract_uploaded_text(filename: str, content: bytes) -> tuple[str, str]:
    suffix = Path(filename).suffix.lower()
    if suffix in {".txt", ".md", ".csv"}:
        return content.decode("utf-8", errors="replace"), suffix.lstrip(".")
    if suffix == ".docx":
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            parts = [name for name in archive.namelist() if name == "word/document.xml" or re.fullmatch(r"word/(header|footer)\d+\.xml", name)]
            return "\n\n".join(_xml_text(archive.read(name)) for name in parts), "docx"
    if suffix == ".pptx":
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            slides = sorted(
                (name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
                key=lambda name: int(re.search(r"(\d+)", Path(name).stem).group(1)),
            )
            text = []
            for index, name in enumerate(slides, 1):
                text.append(f"第 {index} 页\n{_xml_text(archive.read(name))}")
            return "\n\n".join(text), "pptx"
    if suffix == ".pdf":
        process = subprocess.run(
            ["pdftotext", "-layout", "-", "-"], input=content, capture_output=True, timeout=30,
        )
        if process.returncode != 0:
            raise ValueError("pdf_parse_failed")
        text = process.stdout.decode("utf-8", errors="replace")
        if len(clean_analysis_text(text, 5000)) < 20:
            raise ValueError("pdf_no_extractable_text_or_scanned")
        return text, "pdf"
    raise ValueError("unsupported_file_type")


def chunk_document(text: str, target_chars: int = 700, overlap_chars: int = 100) -> list[dict]:
    paragraphs = [re.sub(r"\s+", " ", part).strip() for part in re.split(r"\n+", text) if part.strip()]
    chunks: list[dict] = []
    current: list[str] = []
    current_len = 0
    heading = ""
    for paragraph in paragraphs:
        if len(paragraph) <= 60 and not re.search(r"[。！？.!?]$", paragraph):
            heading = paragraph
        if current and current_len + len(paragraph) > target_chars:
            content = "\n".join(current)
            chunks.append({"heading": heading, "content": content})
            tail = content[-overlap_chars:] if overlap_chars else ""
            current = [tail] if tail else []
            current_len = len(tail)
        current.append(paragraph)
        current_len += len(paragraph)
    if current:
        chunks.append({"heading": heading, "content": "\n".join(current)})
    return [chunk for chunk in chunks if len(chunk["content"].strip()) >= 10]


def resolve_embedding_config(headers: Any, model_config: dict) -> dict:
    url = str(headers.get("X-Embedding-Base-Url") or "").strip()
    if not url:
        url = re.sub(r"/chat/completions/?$", "/embeddings", model_config["url"])
    model = str(headers.get("X-Embedding-Model") or "text-embedding-3-small").strip()
    parsed = urlparse(url)
    if PRODUCT_MODE and (parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_MODEL_HOSTS):
        raise ValueError("embedding_endpoint_not_allowed")
    key = str(headers.get("X-Embedding-Key") or model_config["key"]).strip()
    return {"url": url, "key": key, "model": model}


def embed_texts(config: dict, texts: list[str]) -> list[list[float]]:
    payload = json.dumps({"model": config["model"], "input": texts}).encode("utf-8")
    req = urllib.request.Request(config["url"], data=payload, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {config['key']}",
    })
    with urllib.request.urlopen(req, timeout=30) as response:
        body = json.loads(response.read().decode("utf-8"))
    ordered = sorted(body.get("data") or [], key=lambda item: item.get("index", 0))
    vectors = [item.get("embedding") or [] for item in ordered]
    if len(vectors) != len(texts) or any(not vector for vector in vectors):
        raise ValueError("embedding_response_invalid")
    return vectors


def ingest_knowledge_document(tenant: dict, title: str, text: str, source_type: str, source_uri: str, embedding_config: dict | None) -> dict:
    normalized = re.sub(r"\n{3,}", "\n\n", str(text or "")).strip()
    if len(normalized) < 20:
        raise ValueError("document_has_too_little_text")
    if len(normalized) > 2_000_000:
        raise ValueError("document_too_large")
    chunks = chunk_document(normalized)
    if not chunks:
        raise ValueError("document_chunking_failed")
    vectors: list[list[float]] = []
    status, detail = "ready_lexical", "未配置或未成功生成向量，当前使用关键词检索"
    if embedding_config:
        try:
            for start in range(0, len(chunks), 32):
                vectors.extend(embed_texts(embedding_config, [chunk["content"] for chunk in chunks[start:start + 32]]))
            status, detail = "ready", "混合向量与关键词检索"
        except Exception as error:
            print(f"[Embedding Ingest Error] {error}")
            vectors = []
            detail = f"向量生成失败，已降级关键词检索：{type(error).__name__}"
    checksum = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    document_id = f"doc_{secrets.token_hex(10)}"
    with sqlite3.connect(FEEDBACK_DB) as conn:
        existing = conn.execute(
            "SELECT id, title, status, status_detail, chunk_count, version, enabled FROM knowledge_documents WHERE tenant_id=? AND checksum=?",
            (tenant["id"], checksum),
        ).fetchone()
        if existing:
            return dict(zip(["id", "title", "status", "status_detail", "chunk_count", "version", "enabled"], existing))
        version = conn.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_documents WHERE tenant_id=? AND (title=? OR source_uri=?)",
            (tenant["id"], clean_analysis_text(title, 200), source_uri),
        ).fetchone()[0]
        conn.execute(
            """INSERT INTO knowledge_documents
               (id, tenant_id, title, source_type, source_uri, checksum, version, status, status_detail, chunk_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (document_id, tenant["id"], clean_analysis_text(title, 200), source_type, clean_analysis_text(source_uri, 1000),
             checksum, version, status, detail, len(chunks), now, now),
        )
        for index, chunk in enumerate(chunks):
            terms = sorted(_terms(f"{chunk['heading']} {chunk['content']}"))
            vector = vectors[index] if len(vectors) == len(chunks) else []
            conn.execute(
                """INSERT INTO knowledge_chunks
                   (id, document_id, tenant_id, chunk_index, heading, content, terms_json, embedding_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (f"chk_{secrets.token_hex(10)}", document_id, tenant["id"], index, chunk["heading"], chunk["content"],
                 json.dumps(terms, ensure_ascii=False), json.dumps(vector) if vector else "", now),
            )
    return {"id": document_id, "title": title, "status": status, "status_detail": detail, "chunk_count": len(chunks), "version": version, "enabled": 1}


def list_knowledge_documents(tenant_id: str) -> list[dict]:
    init_feedback_db()
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT id,title,source_type,source_uri,version,status,status_detail,enabled,chunk_count,created_at,updated_at
               FROM knowledge_documents WHERE tenant_id=? ORDER BY updated_at DESC""", (tenant_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def set_knowledge_document_enabled(tenant_id: str, document_id: str, enabled: bool) -> bool:
    with sqlite3.connect(FEEDBACK_DB) as conn:
        cursor = conn.execute(
            "UPDATE knowledge_documents SET enabled=?, updated_at=? WHERE id=? AND tenant_id=?",
            (1 if enabled else 0, datetime.now(timezone.utc).isoformat(), document_id, tenant_id),
        )
    return cursor.rowcount > 0


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    norm = (sum(a * a for a in left) * sum(b * b for b in right)) ** 0.5
    return dot / norm if norm else 0.0


def retrieve_knowledge_chunks(query: str, tenant_id: str, embedding_config: dict | None, limit: int = 5) -> list[dict]:
    query_terms = _terms(query)
    query_vector: list[float] = []
    if embedding_config:
        try:
            query_vector = embed_texts(embedding_config, [query])[0]
        except Exception as error:
            print(f"[Embedding Query Error] {error}")
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """SELECT c.content,c.heading,c.terms_json,c.embedding_json,d.id AS document_id,d.title,d.source_type,d.source_uri,d.version
               FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
               WHERE c.tenant_id=? AND d.enabled=1 ORDER BY d.updated_at DESC LIMIT 5000""", (tenant_id,),
        ).fetchall()
    scored = []
    for row in rows:
        terms = set(json.loads(row["terms_json"] or "[]"))
        lexical = len(query_terms & terms) / max(1, len(query_terms | terms))
        vector = json.loads(row["embedding_json"]) if row["embedding_json"] else []
        semantic = max(0.0, _cosine(query_vector, vector))
        score = semantic * 0.72 + lexical * 0.28 if query_vector and vector else lexical
        if score > (0.08 if query_vector and vector else 0.025):
            scored.append((score, dict(row)))
    return [{**row, "score": round(score, 4)} for score, row in sorted(scored, key=lambda item: item[0], reverse=True)[:limit]]


def import_feishu_doc(url: str, app_id: str, app_secret: str) -> tuple[str, str]:
    match = re.search(r"/(docx|wiki)/([A-Za-z0-9]+)", url)
    if not match:
        raise ValueError("feishu_link_type_not_supported")
    auth_payload = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode("utf-8")
    auth_req = urllib.request.Request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", data=auth_payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(auth_req, timeout=15) as response:
        auth = json.loads(response.read().decode("utf-8"))
    token = auth.get("tenant_access_token")
    if not token:
        raise ValueError("feishu_authorization_failed")
    kind, object_token = match.groups()
    headers = {"Authorization": f"Bearer {token}"}
    if kind == "wiki":
        req = urllib.request.Request(f"https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token={object_token}", headers=headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            node = json.loads(response.read().decode("utf-8")).get("data", {}).get("node", {})
        if node.get("obj_type") != "docx":
            raise ValueError("feishu_wiki_object_not_docx")
        object_token = node.get("obj_token") or ""
    page_token, blocks = "", []
    while True:
        query = f"page_size=500" + (f"&page_token={page_token}" if page_token else "")
        req = urllib.request.Request(f"https://open.feishu.cn/open-apis/docx/v1/documents/{object_token}/blocks?{query}", headers=headers)
        with urllib.request.urlopen(req, timeout=20) as response:
            page = json.loads(response.read().decode("utf-8")).get("data", {})
        blocks.extend(page.get("items") or [])
        if not page.get("has_more"):
            break
        page_token = page.get("page_token") or ""
    lines = []
    for block in blocks:
        block_type = block.get("block_type")
        for key, value in block.items():
            if not isinstance(value, dict) or "elements" not in value:
                continue
            text = "".join(
                element.get("text_run", {}).get("content", "") for element in value.get("elements") or []
            ).strip()
            if text:
                lines.append(text)
    return f"飞书文档 {object_token}", "\n".join(lines)


def normalize_scope(value: str) -> str:
    scope = re.sub(r"[^a-zA-Z0-9_:.\-\u4e00-\u9fff]", "_", str(value or "default")).strip("_")
    return scope[:120] or "default"


def detect_intent_bucket(value: str) -> str:
    text = str(value or "").lower()
    rules = [
        ("price", r"价格|多少钱|收费|预算|贵|便宜|报价"),
        ("hesitation", r"先看看|考虑|不急|暂时不|再说|观望|不想留"),
        ("feature", r"功能|支持|导出|api|接口|源文件|分层|版权"),
        ("onboarding", r"怎么用|不会|难不难|上手|教程|教我"),
        ("cooperation", r"合作|投资|加盟|代理|项目|商务"),
        ("industry", r"装修|家装|美业|教培|餐饮|房产|珠宝|摄影|服装|招商"),
        ("demo", r"样稿|演示|试用|案例|资料|方案|排版"),
        ("greeting", r"^你好$|^hello$|在吗|您好"),
    ]
    for bucket, pattern in rules:
        if re.search(pattern, text):
            return bucket
    return "general"


def _terms(value: str) -> set[str]:
    text = re.sub(r"\s+", "", str(value or "").lower())
    chinese = re.findall(r"[\u4e00-\u9fff]", text)
    grams = {"".join(chinese[i:i + 2]) for i in range(max(0, len(chinese) - 1))}
    words = set(re.findall(r"[a-z0-9]{2,}", text))
    return grams | words


def retrieve_feedback_examples(latest_msg: str, turns: list, scope: str = "default", limit: int = 3) -> list[dict]:
    init_feedback_db()
    query_text = " ".join(
        [str(latest_msg or "")] + [str(turn.get("content") or "") for turn in turns[-4:]]
    )
    query_terms = _terms(query_text)
    if not query_terms:
        return []
    scope = normalize_scope(scope)
    query_bucket = detect_intent_bucket(query_text)
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, latest_msg, human_reply, reason, analysis_json FROM reply_feedback WHERE scope = ? AND enabled = 1 ORDER BY id DESC LIMIT 300",
            (scope,),
        ).fetchall()
    scored = []
    for row in rows:
        candidate_terms = _terms(f"{row['latest_msg']} {row['reason']} {row['analysis_json']}")
        overlap = len(query_terms & candidate_terms)
        if not overlap:
            continue
        score = overlap / max(1, len(query_terms | candidate_terms))
        analysis = str(row["analysis_json"] or "")
        candidate_bucket = detect_intent_bucket(f"{row['latest_msg']} {analysis}")
        if candidate_bucket == query_bucket:
            score += 0.22
        if row["latest_msg"] and row["latest_msg"] in query_text:
            score += 0.25
        scored.append((score, dict(row)))
    matches = [row for score, row in sorted(scored, key=lambda item: item[0], reverse=True)[:limit] if score >= 0.035]
    if matches:
        with sqlite3.connect(FEEDBACK_DB) as conn:
            conn.executemany("UPDATE reply_feedback SET usage_count = usage_count + 1 WHERE id = ?", [(row["id"],) for row in matches])
    return matches


def analyze_feedback(latest_msg: str, turns: list, ai_reply: str, human_reply: str, model_config: dict | None = None) -> dict:
    context = []
    for turn in turns[-8:]:
        role = "客服" if turn.get("role") == "assistant" else "客户"
        content = redact_sensitive(turn.get("content") or "")
        if content:
            context.append(f"{role}：{content}")
    prompt = f"""请分析一条小红书私信客服人工改稿，提炼可复用经验。不要判断或补充任何产品事实。
客户最后消息：{redact_sensitive(latest_msg)}
会话：{' | '.join(context)}
模型原稿：{redact_sensitive(ai_reply)}
人工采用：{redact_sensitive(human_reply)}

严格只输出以下五行，每行控制在30字内，不要 JSON、Markdown 或额外解释。最重要的原因必须放第一行：
原因：人工版更好的原因
策略：采用的回复策略
意图：客户意图
避免：以后应避免什么
标签：标签1、标签2"""
    payload = {
        "model": OPENCODEX_MODEL,
        "messages": [
            {"role": "system", "content": "你是客服质检员，只提炼回复策略，严格按用户要求的五行格式输出。"},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "max_tokens": 800,
    }
    try:
        config = model_config or {"url": OPENCODEX_URL, "key": OPENCODEX_API_KEY, "model": OPENCODEX_MODEL}
        raw = request_model(config, payload["messages"], temperature=0.2, max_tokens=800)
        labels = {
            "意图": "intent", "策略": "strategy", "原因": "why_better",
            "标签": "tags", "避免": "avoid",
        }
        parsed: dict[str, Any] = {}
        for line in raw.splitlines():
            match = re.match(r"^\s*(意图|策略|原因|标签|避免)\s*[：:]\s*(.+?)\s*$", line)
            if not match:
                continue
            key, value = labels[match.group(1)], match.group(2).strip()
            parsed[key] = [item.strip() for item in re.split(r"[、,，]", value) if item.strip()] if key == "tags" else value
        # 即使模型未完全遵守五行协议，也保留一条可读原因，避免反馈链路因格式问题失效。
        if not parsed.get("why_better") and raw:
            parsed["why_better"] = clean_analysis_text(raw)
        return parsed
    except Exception as error:
        print(f"[Feedback Analysis Error] {error}")
        return {}


def clean_analysis_text(value: str, limit: int = 240) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def save_feedback(payload: dict, model_config: dict | None = None) -> dict:
    init_feedback_db()
    latest_msg = redact_sensitive(payload.get("latest_msg") or "")
    ai_reply = redact_sensitive(payload.get("ai_reply") or "")
    human_reply = redact_sensitive(payload.get("human_reply") or "")
    turns = []
    for turn in (payload.get("turns") or [])[-12:]:
        turns.append({
            "role": "assistant" if turn.get("role") == "assistant" else "user",
            "type": "card" if turn.get("type") == "card" else "text",
            "content": redact_sensitive(turn.get("content") or ""),
        })
    reason = redact_sensitive(payload.get("reason") or "")
    scope = normalize_scope(payload.get("knowledge_scope") or "default")
    if not latest_msg or not human_reply:
        raise ValueError("latest_msg_and_human_reply_required")
    analysis = {}
    if not reason and payload.get("auto_analyze", True):
        analysis = analyze_feedback(latest_msg, turns, ai_reply, human_reply, model_config)
        reason = redact_sensitive(analysis.get("why_better") or "AI 已分析，暂无补充说明")
    elif reason:
        analysis = {"why_better": reason, "source": "human"}
    session_hash = hashlib.sha256(str(payload.get("session_id") or "unknown").encode("utf-8")).hexdigest()[:16]
    fingerprint = hashlib.sha256(f"{scope}\n{latest_msg}\n{human_reply}".encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.execute(
            """INSERT INTO reply_feedback
               (fingerprint, created_at, session_hash, latest_msg, context_json, ai_reply, human_reply, reason, analysis_json, scope)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(fingerprint) DO UPDATE SET
                 reason=excluded.reason, analysis_json=excluded.analysis_json, scope=excluded.scope, created_at=excluded.created_at""",
            (fingerprint, now, session_hash, latest_msg, json.dumps(turns, ensure_ascii=False), ai_reply,
             human_reply, reason, json.dumps(analysis, ensure_ascii=False), scope),
        )
        row_id = conn.execute("SELECT id FROM reply_feedback WHERE fingerprint = ?", (fingerprint,)).fetchone()[0]
        total = conn.execute("SELECT COUNT(*) FROM reply_feedback WHERE scope = ?", (scope,)).fetchone()[0]
    return {"id": row_id, "reason": reason, "analysis": analysis, "knowledge_count": total}


def list_feedback(scope: str = "default", limit: int = 30) -> list[dict]:
    init_feedback_db()
    scope = normalize_scope(scope)
    safe_limit = max(1, min(int(limit or 30), 100))
    with sqlite3.connect(FEEDBACK_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, created_at, latest_msg, human_reply, reason, analysis_json, usage_count, enabled, disabled_at FROM reply_feedback WHERE scope = ? ORDER BY id DESC LIMIT ?",
            (scope, safe_limit),
        ).fetchall()
    result = []
    for row in rows:
        try:
            analysis = json.loads(row["analysis_json"] or "{}")
        except json.JSONDecodeError:
            analysis = {}
        result.append({**dict(row), "analysis": analysis})
    return result


def set_feedback_enabled(feedback_id: int, enabled: bool, scope: str = "default") -> bool:
    init_feedback_db()
    scope = normalize_scope(scope)
    disabled_at = "" if enabled else datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(FEEDBACK_DB) as conn:
        cursor = conn.execute(
            "UPDATE reply_feedback SET enabled = ?, disabled_at = ? WHERE id = ? AND scope = ?",
            (1 if enabled else 0, disabled_at, int(feedback_id), scope),
        )
    return cursor.rowcount > 0


def delete_feedback(feedback_id: int, scope: str = "default") -> bool:
    """兼容旧扩展：delete 现在等价于软停用，保留案例和审计记录。"""
    return set_feedback_enabled(feedback_id, False, scope)


def resolve_model_config(headers: Any) -> dict:
    header_url = str(headers.get("X-Model-Base-Url") or "").strip()
    header_key = str(headers.get("X-Model-Key") or "").strip()
    header_model = str(headers.get("X-Model-Name") or "").strip()
    url = header_url or OPENCODEX_URL
    key = header_key or OPENCODEX_API_KEY
    model = header_model or OPENCODEX_MODEL
    parsed = urlparse(url)
    if PRODUCT_MODE:
        # 商用模式是明确的 BYOK：不能悄悄回退到服务器内部模型或密钥。
        if not header_key:
            raise ValueError("model_api_key_required")
        if not header_url:
            raise ValueError("model_endpoint_required")
        if not header_model:
            raise ValueError("model_name_required")
        if parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_MODEL_HOSTS:
            raise ValueError("model_endpoint_not_allowed")
    if not parsed.scheme or not parsed.netloc or len(url) > 500 or len(model) > 160:
        raise ValueError("invalid_model_config")
    return {"url": url, "key": key, "model": model}


def build_system_prompt(tenant: dict | None) -> str:
    config = tenant or OWNER_DEFAULTS
    facts = "\n".join([
        f"品牌/项目：{config.get('brand_name') or config.get('workspace_name') or '未填写'}",
        f"业务介绍：{config.get('business_profile') or '未填写；信息不足时只能澄清，不能猜。'}",
        f"业务知识：{config.get('knowledge_text') or '未填写；价格、功能等硬事实不得自行补全。'}",
        f"回复偏好：{config.get('reply_preferences') or '自然、简洁，一次推进一个动作。'}",
    ])
    return f"{SYSTEM_PROMPT}\n\n当前工作区已确认资料（只能使用这里和当前会话中的事实）：\n{facts}"


def request_model(model_config: dict, messages: list, temperature: float = 0.45, max_tokens: int = 800) -> str:
    payload = {
        "model": model_config["model"], "messages": messages,
        "temperature": temperature, "max_tokens": max_tokens,
    }
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {model_config['key']}"}
    req = urllib.request.Request(model_config["url"], data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=16) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    return result["choices"][0]["message"]["content"].strip().strip('"“”')


def call_llm_dynamic(
    user_name: str,
    latest_msg: str,
    turns: list,
    user_msgs: list,
    bot_msgs: list,
    shared_cards: list,
    action: str,
    knowledge_scope: str = "default",
    tenant: dict | None = None,
    model_config: dict | None = None,
    embedding_config: dict | None = None,
) -> tuple[str, int, list[dict]]:
    context_lines = []
    for turn in turns[-12:]:
        role = "客服" if turn.get("role") == "assistant" else "客户"
        kind = "（分享卡片）" if turn.get("type") == "card" else ""
        content = str(turn.get("content") or "").strip()
        if content:
            context_lines.append(f"{role}{kind}：{content}")

    # 兼容旧版扩展，但新版优先使用按时间排序的 turns。
    if not context_lines:
        for message in user_msgs[-4:]:
            context_lines.append(f"客户：{message}")
        for message in bot_msgs[-4:]:
            context_lines.append(f"客服：{message}")
        for card in shared_cards[-2:]:
            context_lines.append(f"客户（分享卡片）：{card}")

    action_note = {
        "auto_reply": "这是自动回复：只有充分确定上下文时才作答，宁可简短澄清，也不要猜测。",
        "manual_followup": "这是人工主动生成跟进草稿：避免重复上一轮，给出一个自然的后续动作。",
        "reply": "这是副驾回复草稿：准确承接客户最后一条未回复消息。",
    }.get(action, "准确承接客户最后一条消息。")
    if _is_external_action_status_check(latest_msg):
        action_note += (
            " 客户正在追问添加、发送、申请或通过等外部动作状态。当前会话不能证明动作是否完成；"
            "不得谎称已完成，也不得转去介绍产品。应明确需要核对，并给出一个最低摩擦的确认动作。"
        )
    examples = retrieve_feedback_examples(latest_msg, turns, knowledge_scope)
    memory_lines = []
    for index, example in enumerate(examples, 1):
        memory_lines.append(
            f"案例{index}｜客户：{example['latest_msg']}｜优质回复：{example['human_reply']}｜为什么：{example['reason']}"
        )
    memory_context = "\n".join(memory_lines) or "暂无相似人工优质案例"
    knowledge_hits = retrieve_knowledge_chunks(
        " ".join([latest_msg] + [str(turn.get("content") or "") for turn in turns[-5:]]),
        tenant["id"], embedding_config,
    ) if tenant else []
    knowledge_context = "\n\n".join(
        f"资料{index}｜{item['title']}（v{item['version']}）｜{item['content']}"
        for index, item in enumerate(knowledge_hits, 1)
    ) or "当前问题没有命中已启用的业务资料"
    style_hints = [
        "语气像正在跟进项目的真人，先短回应，再问一个关键问题。",
        "语气克制、自然，少用完整宣传句，像微信里认真沟通。",
        "先接住客户顾虑，不急着成交；用一两个具体词证明你看过上下文。",
        "尽量用短句和口语，但信息要具体，避免寒暄和套话。",
    ]
    style_hint = style_hints[int(hashlib.sha256(f"{knowledge_scope}:{latest_msg}".encode()).hexdigest(), 16) % len(style_hints)]
    user_prompt = (
        f"客户昵称：{user_name}\n"
        f"客户最后一条消息：{latest_msg}\n"
        f"任务：{action_note}\n\n"
        "表达风格提示：" + style_hint + "\n\n"
        "按时间顺序的真实会话：\n" + "\n".join(context_lines) +
        "\n\n命中的业务知识（这是回答业务事实的首要依据；未命中时不得自行补全）：\n" + knowledge_context +
        "\n\n相似人工优质案例（只学习策略和表达，不得照抄；其中价格、功能、身份均不能当作当前事实）：\n" + memory_context
    )

    payload = {
        "model": (model_config or {}).get("model", OPENCODEX_MODEL),
        "messages": [
            {"role": "system", "content": build_system_prompt(tenant)},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.55,
        # 该网关把模型的内部推理 token 也计入 max_tokens；过小会把正文截在半句话。
        "max_tokens": 800
    }

    def request_once(request_payload: dict) -> str:
        config = model_config or {"url": OPENCODEX_URL, "key": OPENCODEX_API_KEY, "model": OPENCODEX_MODEL}
        return request_model(config, request_payload["messages"], request_payload.get("temperature", 0.55), request_payload.get("max_tokens", 800))

    try:
        reply = request_once(payload)
        # 对明确问题只回一句身份介绍属于不可用结果；仅在这种失败时低成本重试一次。
        if len(latest_msg.strip()) >= 8 and len(reply) < 28:
            retry_payload = dict(payload)
            retry_payload["messages"] = payload["messages"] + [
                {"role": "assistant", "content": reply},
                {
                    "role": "user",
                    "content": "这条没有回答客户的具体问题。请直接回应客户最后一句里的诉求，承接一个明确下一步；不得编造数据，控制在45~110字。"
                }
            ]
            reply = request_once(retry_payload)
        sources = [{key: item[key] for key in ("document_id", "title", "source_type", "source_uri", "version", "score")} for item in knowledge_hits]
        return (reply if len(reply) >= 24 else "", len(examples), sources)
    except Exception as e:
        print(f"[LLM Error] {e}")
        return "", 0, []

def apply_fact_guard(latest_msg: str, reply: str) -> str:
    """拦截模型对实时价格和未提供功能状态的擅自补全。"""
    latest = latest_msg.lower()
    if re.search(r"多少钱|价格|怎么收费|收费吗|费用", latest_msg):
        if re.search(r"\d[\d,.]*\s*(?:元|块)|每月|每年|起", reply):
            return (
                "价格、额度和席位要以当前订阅页为准，我不想在这里给您报旧口径。"
                "您是个人使用还是团队协作？我先按实际使用场景帮您对一下当前合适的档位。"
            )
    hard_feature = re.search(r"psd|api|导出|下载|源文件|分层|商用授权|版权", latest)
    unsupported_claim = re.search(r"暂不支持|不支持|已经支持|可以导出|能够导出|目前支持", reply)
    if hard_feature and unsupported_claim:
        subject = hard_feature.group(0).upper() if hard_feature.group(0) in {"psd", "api"} else hard_feature.group(0)
        return (
            f"{subject} 这项能力要按当前产品界面确认，我先不在这里答错。"
            "您具体是想拿到可分层二改的源文件，还是只需要高清成图？我按您的用途核对准确口径。"
        )
    return reply


def _is_presence_ping(value: str) -> bool:
    text = re.sub(r"[\s，。！!？?~～]+", "", str(value or "").lower())
    return bool(text) and len(text) <= 16 and bool(re.fullmatch(
        r"(?:(?:您好|你好|hello|hi)(?:还在吗|在吗|有人吗|方便吗|收到吗|看到了吗)?|还在吗|在吗|有人吗|方便吗|收到吗|看到了吗|没收到|没收到诶|怎么还没收到)",
        text,
    ))


def _is_external_action_status_check(value: str) -> bool:
    text = re.sub(r"[\s，。！!？?~～]+", "", str(value or "").lower())
    if not text or len(text) > 28:
        return False
    return bool(re.search(
        r"(?:加|添加|通过|申请|发送|发)(?:了|上|好|过)?(?:没|没有|了吗|了没|没啊|没有啊)"
        r"|(?:好友申请|资料|链接|邀请码).{0,6}(?:收到没|收到了吗|发了吗|发了没)",
        text,
    ))


def _asks_for_contact(value: str) -> bool:
    text = str(value or "")
    return bool(re.search(r"(?:留|发|给|提供|加|添加|联系).{0,8}(?:微信|手机号|手机|电话|联系方式)|联系方式", text, re.I))


def _has_contact_intent(value: str) -> bool:
    return bool(re.search(r"微信|手机号|手机号码|电话|联系方式|加您|加我|添加|好友申请|邀请码", str(value or ""), re.I))


def _last_substantive_customer_message(turns: list, latest_msg: str) -> str:
    for turn in reversed(turns[:-1]):
        if turn.get("role") != "assistant" and turn.get("type") != "card":
            content = clean_analysis_text(turn.get("content") or "", 28)
            if content and not _is_presence_ping(content):
                return content
    return ""


def apply_conversation_guard(latest_msg: str, turns: list, reply: str) -> str:
    """把最容易暴露模板味的两类结果拦下来：短促探问被强行销售、以及重复索要联系方式。"""
    current = clean_analysis_text(reply, 180)
    latest = clean_analysis_text(latest_msg, 80)
    recent_assistant = " ".join(
        str(turn.get("content") or "") for turn in turns[-4:] if turn.get("role") == "assistant"
    )
    recent_contact_ask = _asks_for_contact(recent_assistant)

    if _is_presence_ping(latest) and (_asks_for_contact(current) or len(current) > 105 or re.search(r"新作\s*2\.0|内测|专属邀请码|行业模板", current)):
        if "没收到" in latest:
            return "在的，刚看到。刚才那条可能没到，您不用重复发；您是想继续看刚才的资料，还是先了解 2.0 怎么用？"
        previous = _last_substantive_customer_message(turns, latest)
        if previous:
            return f"在的，刚看到。您刚才提到“{previous}”，我还记着，先按这个继续聊？"
        return "在的，刚看到。您是想继续了解刚才的内容，还是我先把具体用法说清楚？"

    if recent_contact_ask and not _has_contact_intent(latest) and _asks_for_contact(current):
        if "没收到" in latest:
            return "在的，刚看到。刚才那条可能没到，您不用重复留联系方式；您是想继续看资料，还是先了解具体用法？"
        return "明白，联系方式先不用重复留。我先把您刚才关心的内容说清楚，您想先看实际效果还是操作流程？"
    return current


def reply_quality_issues(latest_msg: str, turns: list, reply: str) -> list[str]:
    """只判定失败原因，不用固定模板覆盖模型结果。"""
    current = clean_analysis_text(reply, 220)
    latest = clean_analysis_text(latest_msg, 100)
    issues: list[str] = []
    recent_assistant = " ".join(
        str(turn.get("content") or "") for turn in turns[-4:] if turn.get("role") == "assistant"
    )
    if not current:
        issues.append("没有输出可发送的回复")
    if _is_presence_ping(latest) and (
        _asks_for_contact(current) or len(current) > 105 or re.search(r"内测|专属邀请码|行业模板|我们为您", current)
    ):
        issues.append("客户只是短促确认在线，不应突然推销或索要联系方式")
    if _asks_for_contact(recent_assistant) and not _has_contact_intent(latest) and _asks_for_contact(current):
        issues.append("客服上一轮已索要联系方式，本轮重复索要")
    if _is_external_action_status_check(latest):
        if re.search(r"实际效果|操作流程|了解(?:一下)?|产品介绍|怎么用", current):
            issues.append("客户在确认外部动作状态，回复却把话题岔到产品介绍")
        if re.search(r"(?:已经|已)(?:发送|添加|通过|处理)|加好了|发好了", current) and not re.search(r"无法确认|不能确认|暂时看不到|需要核对", current):
            issues.append("当前会话无法核验外部动作状态，回复却声称已经完成")
    if re.search(
        r"(?:我|这边)?(?:这就|马上|稍后|待会儿?|现在).{0,10}(?:添加|加|发送|发|通过|处理)|"
        r"(?:我|这边)?帮您?.{0,6}(?:添加|加|发送|发|通过)(?:一下)?(?:申请|好友|资料|链接)?",
        current,
    ) and not re.search(r"无法|不能|暂时.{0,4}(?:操作|确认)|需要人工|转人工|您可以", current):
        issues.append("回复承诺执行当前会话无法核验的外部动作")
    if re.search(r"多少钱|价格|怎么收费|收费吗|费用", latest_msg) and re.search(r"\d[\d,.]*\s*(?:元|块)|每月|每年|起", current):
        issues.append("业务资料没有给出实时价格，回复却自行报价")
    if re.search(r"psd|api|导出|下载|源文件|分层|商用授权|版权", latest.lower()) and re.search(r"暂不支持|不支持|已经支持|可以导出|能够导出|目前支持", current):
        issues.append("业务资料没有确认当前功能状态，回复却给出确定结论")
    previous_replies = [clean_analysis_text(t.get("content") or "", 220) for t in turns[-6:] if t.get("role") == "assistant"]
    if current and any(len(old) >= 20 and current == old for old in previous_replies):
        issues.append("与本会话客服上一轮回复完全重复")
    return issues


def rewrite_failed_reply(latest_msg: str, turns: list, reply: str, issues: list[str], tenant: dict | None, model_config: dict) -> str:
    context = []
    for turn in turns[-10:]:
        role = "客服" if turn.get("role") == "assistant" else "客户"
        content = clean_analysis_text(turn.get("content") or "", 500)
        if content:
            context.append(f"{role}：{content}")
    messages = [
        {"role": "system", "content": build_system_prompt(tenant)},
        {"role": "user", "content": (
            "下面原稿未通过发送质检。请基于真实多轮会话低温重写，只输出一条可直接发送的话。\n"
            f"失败原因：{'；'.join(issues)}\n客户最后消息：{latest_msg}\n"
            f"真实会话：{' | '.join(context)}\n原稿：{reply}\n"
            "要求：先回答/承接最后消息，不照抄客户原话，不编造事实，不重复上一轮，一次只推进一个动作。"
        )},
    ]
    try:
        rewritten = request_model(model_config, messages, temperature=0.18, max_tokens=700)
    except Exception as error:
        print(f"[LLM Rewrite Error] {error}")
        return ""
    return rewritten if not reply_quality_issues(latest_msg, turns, rewritten) else ""

class HttpHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        # 兼容旧客户端时也不允许查询参数里的历史令牌继续进入日志。
        sanitized = tuple(
            re.sub(r"([?&]token=)[^&\s\"]+", r"\1[REDACTED]", str(arg)) for arg in args
        )
        super().log_message(format, *sanitized)

    def _bearer_token(self) -> str:
        value = self.headers.get("Authorization", "")
        return value[7:].strip() if value.lower().startswith("bearer ") else ""

    def _tenant(self, required: bool = True) -> dict | None:
        tenant = get_tenant_by_token(self._bearer_token())
        if required and PRODUCT_MODE and not tenant:
            self._send_json(401, {"ok": False, "error": "workspace_token_invalid"})
            return None
        return tenant

    def _read_payload(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16 * 1024 * 1024:
            raise ValueError("request_too_large")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:
            return {}

    def _send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Model-Key, X-Model-Base-Url, X-Model-Name, X-Embedding-Key, X-Embedding-Base-Url, X-Embedding-Model, X-Feishu-App-Id, X-Feishu-App-Secret")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Model-Key, X-Model-Base-Url, X-Model-Name, X-Embedding-Key, X-Embedding-Base-Url, X-Embedding-Model, X-Feishu-App-Id, X-Feishu-App-Secret")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/healthz":
            self._send_json(200, {"ok": True, "service": "XHS Private Domain LLM Bridge", "product_mode": PRODUCT_MODE})
        elif path == "/tenant/config":
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            config = dict(tenant or OWNER_DEFAULTS)
            config.pop("token_hash", None)
            self._send_json(200, {"ok": True, "config": config})
        elif path == "/knowledge/documents":
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            if not tenant:
                self._send_json(400, {"ok": False, "error": "tenant_required"})
                return
            self._send_json(200, {"ok": True, "items": list_knowledge_documents(tenant["id"])})
        elif path == "/feedback/stats":
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            query = parse_qs(urlparse(self.path).query)
            scope = tenant_scope(tenant, query.get("scope", ["default"])[0])
            init_feedback_db()
            with sqlite3.connect(FEEDBACK_DB) as conn:
                total = conn.execute("SELECT COUNT(*) FROM reply_feedback WHERE scope = ? AND enabled = 1", (scope,)).fetchone()[0]
                disabled = conn.execute("SELECT COUNT(*) FROM reply_feedback WHERE scope = ? AND enabled = 0", (scope,)).fetchone()[0]
            self._send_json(200, {"ok": True, "knowledge_count": total, "disabled_count": disabled, "scope": scope})
        elif path == "/feedback/list":
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            query = parse_qs(urlparse(self.path).query)
            scope = tenant_scope(tenant, query.get("scope", ["default"])[0])
            self._send_json(200, {"ok": True, "scope": scope, "items": list_feedback(scope, query.get("limit", [30])[0])})
        elif path == "/leads/list":
            tenant = self._tenant()
            if not tenant:
                self._send_json(400, {"ok": False, "error": "tenant_required"})
                return
            self._send_json(200, {"ok": True, "items": list_tenant_leads(tenant["id"])})
        elif path == "/leads/export.csv":
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            if not tenant:
                self._send_json(401, {"ok": False, "error": "unauthorized"})
                return
            leads = list_tenant_leads(tenant["id"])
            csv_lines = ["客户昵称,线索类型,联系方式,意向场景,捕获时间"]
            for l in leads:
                csv_lines.append(f'"{l.get("user_name","")}",{l.get("lead_type","")},{l.get("lead_value","")},"{l.get("context_summary","")}",{l.get("created_at","")}')
            csv_body = "\n".join(csv_lines).encode("utf-8-sig")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=leads_export.csv")
            self.send_header("Content-Length", str(len(csv_body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(csv_body)
            return
        elif path == "/knowledge/faq/list":
            tenant = self._tenant()
            if not tenant:
                self._send_json(400, {"ok": False, "error": "tenant_required"})
                return
            self._send_json(200, {"ok": True, "items": list_tenant_faqs(tenant["id"])})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/tenant/register":
            payload = self._read_payload()
            try:
                result = register_tenant(payload.get("workspace_name") or "")
            except ValueError as error:
                self._send_json(400, {"ok": False, "error": str(error)})
                return
            self._send_json(201, {"ok": True, **result})
            return

        if path in {"/reply", "/feedback", "/feedback/delete", "/feedback/status", "/tenant/config", "/knowledge/upload", "/knowledge/feishu", "/knowledge/status", "/knowledge/faq/add", "/knowledge/faq/delete"}:
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            payload = self._read_payload()
            scope = tenant_scope(tenant, payload.get("knowledge_scope") or "default")

            if path == "/knowledge/faq/add":
                if not tenant:
                    self._send_json(400, {"ok": False, "error": "tenant_required"})
                    return
                q = str(payload.get("question") or "").strip()
                a = str(payload.get("answer") or "").strip()
                kw = str(payload.get("keywords") or "").strip()
                if not q or not a:
                    self._send_json(400, {"ok": False, "error": "question_and_answer_required"})
                    return
                item = add_tenant_faq(tenant["id"], q, a, kw)
                self._send_json(201, {"ok": True, "item": item})
                return

            if path == "/knowledge/faq/delete":
                if not tenant:
                    self._send_json(400, {"ok": False, "error": "tenant_required"})
                    return
                deleted = delete_tenant_faq(tenant["id"], str(payload.get("id") or ""))
                self._send_json(200 if deleted else 404, {"ok": deleted})
                return

            if path == "/tenant/config":
                if not tenant:
                    self._send_json(400, {"ok": False, "error": "tenant_required"})
                    return
                self._send_json(200, {"ok": True, "config": update_tenant(tenant["id"], payload)})
                return

            if path in {"/knowledge/upload", "/knowledge/feishu", "/knowledge/status"}:
                if not tenant:
                    self._send_json(400, {"ok": False, "error": "tenant_required"})
                    return
                if path == "/knowledge/status":
                    changed = set_knowledge_document_enabled(tenant["id"], str(payload.get("id") or ""), bool(payload.get("enabled")))
                    self._send_json(200 if changed else 404, {"ok": changed, "enabled": bool(payload.get("enabled"))})
                    return
                try:
                    model_config = resolve_model_config(self.headers)
                    embedding_config = resolve_embedding_config(self.headers, model_config)
                    if path == "/knowledge/upload":
                        filename = clean_analysis_text(payload.get("filename") or "", 240)
                        raw = base64.b64decode(payload.get("content_base64") or "", validate=True)
                        if len(raw) > 12 * 1024 * 1024:
                            raise ValueError("file_too_large")
                        text, source_type = extract_uploaded_text(filename, raw)
                        result = ingest_knowledge_document(tenant, filename, text, source_type, "", embedding_config)
                    else:
                        link = str(payload.get("url") or "").strip()
                        app_id = str(self.headers.get("X-Feishu-App-Id") or "").strip()
                        app_secret = str(self.headers.get("X-Feishu-App-Secret") or "").strip()
                        if not app_id or not app_secret:
                            raise ValueError("feishu_app_credentials_required")
                        title, text = import_feishu_doc(link, app_id, app_secret)
                        result = ingest_knowledge_document(tenant, title, text, "feishu", link, embedding_config)
                except (ValueError, binascii.Error) as error:
                    self._send_json(400, {"ok": False, "error": str(error)})
                    return
                except Exception as error:
                    print(f"[Knowledge Ingest Error] {error}")
                    self._send_json(500, {"ok": False, "error": "knowledge_ingest_failed"})
                    return
                self._send_json(201, {"ok": True, "document": result})
                return

            if path == "/feedback":
                payload["knowledge_scope"] = scope
                try:
                    model_config = resolve_model_config(self.headers) if payload.get("auto_analyze", True) else None
                    result = save_feedback(payload, model_config)
                except ValueError as error:
                    self._send_json(400, {"ok": False, "error": str(error)})
                    return
                except Exception as error:
                    print(f"[Feedback Save Error] {error}")
                    self._send_json(500, {"ok": False, "error": "feedback_save_failed"})
                    return
                self._send_json(200, {"ok": True, **result})
                return
            if path == "/feedback/delete":
                try:
                    deleted = delete_feedback(payload.get("id"), scope)
                except (TypeError, ValueError):
                    deleted = False
                self._send_json(200 if deleted else 404, {"ok": deleted, "disabled": deleted})
                return
            if path == "/feedback/status":
                try:
                    changed = set_feedback_enabled(payload.get("id"), bool(payload.get("enabled")), scope)
                except (TypeError, ValueError):
                    changed = False
                self._send_json(200 if changed else 404, {"ok": changed, "enabled": bool(payload.get("enabled"))})
                return

            user_name = payload.get("user_name") or "客户"
            latest_msg = payload.get("latest_msg") or ""
            turns = payload.get("turns") or []

            # 自动捕获客资并入库（永不漏单）
            if tenant:
                sid = str(payload.get("session_id") or "")
                record_tenant_lead(tenant["id"], sid, user_name, latest_msg)
                for t in turns:
                    if isinstance(t, dict) and t.get("role") == "user":
                        record_tenant_lead(tenant["id"], sid, user_name, str(t.get("content") or ""))
            user_msgs = payload.get("user_messages") or []
            bot_msgs = payload.get("bot_messages") or []
            shared_cards = payload.get("shared_cards") or []
            action = payload.get("action") or "reply"
            knowledge_scope = scope

            try:
                model_config = resolve_model_config(self.headers)
                embedding_config = resolve_embedding_config(self.headers, model_config)
            except ValueError as error:
                self._send_json(400, {"ok": False, "error": str(error)})
                return

            llm_reply, memory_hits, knowledge_sources = call_llm_dynamic(
                user_name, latest_msg, turns, user_msgs, bot_msgs, shared_cards, action,
                knowledge_scope, tenant=tenant, model_config=model_config, embedding_config=embedding_config,
            )
            quality_issues = reply_quality_issues(latest_msg, turns, llm_reply)
            if quality_issues:
                llm_reply = rewrite_failed_reply(latest_msg, turns, llm_reply, quality_issues, tenant, model_config)

            if not llm_reply:
                # 全自动场景宁可不发，也不能用无上下文模板误伤真实客户。
                self._send_json(503, {"ok": False, "error": "llm_unavailable"})
                return

            self._send_json(200, {
                "ok": True,
                "reply": llm_reply,
                "engine": f"{model_config['model']} / OpenAI-compatible",
                "memory_hits": memory_hits,
                "knowledge_scope": knowledge_scope,
                "knowledge_sources": knowledge_sources,
            })
        else:
            self.send_response(404)
            self.end_headers()

def main():
    parser = argparse.ArgumentParser(description="私域接待 Agent HTTP 服务")
    parser.add_argument("--port", type=int, default=18195)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), HttpHandler)
    print(f"✅ 私域接待 LLM 网关已启动: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("服务已停止")

if __name__ == "__main__":
    main()
