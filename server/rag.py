"""知识库：文档解析、分块、嵌入与检索。"""
from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import math
import os
import re
import sqlite3
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from typing import Any

from db import FEEDBACK_DB, clean_analysis_text, init_feedback_db

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

