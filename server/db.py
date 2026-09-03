"""存储层：SQLite 持久化、租户、线索、FAQ、反馈与告警。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from gateway import OPENCODEX_API_KEY, OPENCODEX_MODEL, OPENCODEX_URL, request_model

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


def record_tenant_lead(tenant_id: str, session_id: str, user_name: str, text: str, lead_timestamp: int | float | None = None) -> bool:
    lead = extract_contact_lead(text)
    if not lead or not tenant_id:
        return False
    lead_type, lead_value = lead
    lead_created_at = datetime.fromtimestamp(float(lead_timestamp) / 1000, tz=timezone.utc).isoformat() if lead_timestamp else datetime.now(timezone.utc).isoformat()
    try:
        with db_connection() as conn:
            existed = conn.execute(
                "SELECT 1 FROM tenant_leads WHERE tenant_id=? AND lead_type=? AND lead_value=?",
                (tenant_id, lead_type, lead_value),
            ).fetchone()
            conn.execute("""
                INSERT INTO tenant_leads (id, tenant_id, session_id, user_name, lead_type, lead_value, context_summary, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tenant_id, lead_type, lead_value) DO UPDATE SET
                    user_name=excluded.user_name,
                    context_summary=excluded.context_summary
            """, (f"lead_{secrets.token_hex(10)}", tenant_id, session_id, user_name, lead_type, lead_value, clean_analysis_text(text, 200), lead_created_at))
        return existed is None
    except Exception as e:
        print(f"[Lead Record Error] {e}")
        return False


def record_explicit_tenant_lead(tenant_id: str, session_id: str, user_name: str,
                                lead_type: str, lead_value: str, context_summary: str = "",
                                lead_timestamp: int | float | None = None) -> bool:
    if lead_type not in {"手机号", "微信号"} or not tenant_id:
        raise ValueError("invalid_lead")
    value = str(lead_value or "").strip()
    valid = re.fullmatch(r"1[3-9]\d{9}", value) if lead_type == "手机号" else re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{5,19}", value)
    if not valid:
        raise ValueError("invalid_lead_value")
    lead_created_at = datetime.fromtimestamp(float(lead_timestamp) / 1000, tz=timezone.utc).isoformat() if lead_timestamp else datetime.now(timezone.utc).isoformat()
    with db_connection() as conn:
        existed = conn.execute(
            "SELECT 1 FROM tenant_leads WHERE tenant_id=? AND lead_type=? AND lead_value=?",
            (tenant_id, lead_type, value),
        ).fetchone()
        conn.execute("""
            INSERT INTO tenant_leads (id, tenant_id, session_id, user_name, lead_type, lead_value, context_summary, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, lead_type, lead_value) DO UPDATE SET
                session_id=excluded.session_id,
                user_name=excluded.user_name,
                context_summary=excluded.context_summary
        """, (f"lead_{secrets.token_hex(10)}", tenant_id, session_id, user_name, lead_type, value,
              clean_analysis_text(context_summary, 200), lead_created_at))
    return existed is None


def list_tenant_leads(tenant_id: str) -> list[dict]:
    if not tenant_id:
        return []
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT id, session_id, user_name, lead_type, lead_value, context_summary, created_at FROM tenant_leads WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100",
            (tenant_id,)
        ).fetchall()
        return [dict(zip(["id", "session_id", "user_name", "lead_type", "lead_value", "context_summary", "created_at"], row)) for row in rows]


def delete_tenant_lead(tenant_id: str, lead_id: str) -> bool:
    if not tenant_id or not lead_id:
        return False
    with db_connection() as conn:
        cur = conn.execute("DELETE FROM tenant_leads WHERE tenant_id=? AND id=?", (tenant_id, lead_id))
        conn.commit()
        return cur.rowcount > 0


def clear_tenant_leads(tenant_id: str) -> int:
    if not tenant_id:
        return 0
    with db_connection() as conn:
        cur = conn.execute("DELETE FROM tenant_leads WHERE tenant_id=?", (tenant_id,))
        conn.commit()
        return cur.rowcount


def _csv_safe(value) -> str:
    text = str(value or "")
    return "'" + text if text.startswith(("=", "+", "-", "@")) else text


def add_tenant_faq(tenant_id: str, question: str, answer: str, keywords: str) -> dict:
    faq_id = f"faq_{secrets.token_hex(10)}"
    now = datetime.now(timezone.utc).isoformat()
    with db_connection() as conn:
        conn.execute(
            "INSERT INTO tenant_faq (id, tenant_id, question, answer, keywords, enabled, usage_count, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?)",
            (faq_id, tenant_id, clean_analysis_text(question, 200), clean_analysis_text(answer, 1000), clean_analysis_text(keywords, 200), now)
        )
    return {"id": faq_id, "question": question, "answer": answer, "keywords": keywords}


def list_tenant_faqs(tenant_id: str) -> list[dict]:
    if not tenant_id:
        return []
    init_feedback_db()
    safe_defaults = [
        ('多少钱？怎么收费？', '当前业务资料没有明确价格时，不自行报价或承诺优惠，请由人工按实际版本确认。', '价格,收费,多少钱,套餐,费用'),
        ('手机上可以用吗？有没有小程序或App？', '当前业务资料没有确认终端支持情况时，不猜测功能，请由人工核对实际产品说明。', '手机,小程序,App,安装,下载,电脑'),
        ('你们会乱发消息或被封号吗？', '系统默认只生成草稿并由操作员确认发送；仍需遵守平台规则，不能承诺账号绝对安全。', '封号,安全,违规,自动发,群控'),
        ('可以针对我们行业的特定模板定制吗？', '是否支持行业模板或定制取决于实际产品配置；资料没有明确说明时请由人工确认。', '模板,定制,行业,美业,家装,教培'),
    ]
    with db_connection() as conn:
        # 只迁移曾由本项目自动写入的明确旧承诺；不覆盖用户自行编辑的普通 FAQ。
        for question, answer, keywords in safe_defaults:
            conn.execute(
                """UPDATE tenant_faq SET answer=?, keywords=?
                   WHERE tenant_id=? AND question=?
                   AND (answer LIKE '%50 次%' OR answer LIKE '%100% 安全%' OR answer LIKE '%47 套%')""",
                (answer, keywords, tenant_id, question),
            )
        count = conn.execute("SELECT COUNT(*) FROM tenant_faq WHERE tenant_id=?", (tenant_id,)).fetchone()[0]
        if count == 0:
            for q, a, kw in safe_defaults:
                conn.execute(
                    "INSERT INTO tenant_faq (id, tenant_id, question, answer, keywords, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (f"faq_{secrets.token_hex(8)}", tenant_id, q, a, kw, datetime.now(timezone.utc).isoformat())
                )
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT id, question, answer, keywords, enabled, usage_count, created_at FROM tenant_faq WHERE tenant_id=? ORDER BY created_at DESC",
            (tenant_id,)
        ).fetchall()
        return [dict(zip(["id", "question", "answer", "keywords", "enabled", "usage_count", "created_at"], row)) for row in rows]


def delete_tenant_faq(tenant_id: str, faq_id: str) -> bool:
    with db_connection() as conn:
        cur = conn.execute("DELETE FROM tenant_faq WHERE id=? AND tenant_id=?", (faq_id, tenant_id))
        return cur.rowcount > 0


def retrieve_faq_matches(query: str, tenant_id: str) -> list[dict]:
    if not query or not tenant_id:
        return []
    q_terms = _terms(query)
    with db_connection() as conn:
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



FEEDBACK_DB = Path(os.environ.get(
    "XHS_FEEDBACK_DB",
    Path(__file__).resolve().parent / "data" / "xhs_reply_feedback.sqlite3",
))


@contextmanager
def db_connection(path: Path | str | None = None):
    """提供事务语义并确保 SQLite 连接在每次操作后关闭。"""
    conn = sqlite3.connect(path or FEEDBACK_DB)
    try:
        with conn:
            yield conn
    finally:
        conn.close()



# 线索警报与日报：webhook 兼容飞书群机器人 / 企微群机器人；
# 租户级 webhook_url 优先，未配置时回退到服务端全局值。
ALERT_WEBHOOK = os.environ.get("XHS_ALERT_WEBHOOK", "")


REPORT_HOUR = int(os.environ.get("XHS_REPORT_HOUR", "13") or 13)


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


def sanitize_history_samples(sessions: list) -> tuple[list[dict], dict]:
    """限制并脱敏首次学习样本；客户内容仅保留为场景，学习必须以客服回复为准。"""
    if not isinstance(sessions, list):
        raise ValueError("invalid_history_samples")
    cleaned_sessions: list[dict] = []
    total_chars = 0
    assistant_turns = 0
    for raw_session in sessions[:12]:
        if not isinstance(raw_session, dict) or not isinstance(raw_session.get("turns"), list):
            continue
        cleaned_turns = []
        for raw_turn in raw_session["turns"][:30]:
            if not isinstance(raw_turn, dict) or raw_turn.get("role") not in {"user", "assistant"}:
                continue
            content = redact_sensitive(raw_turn.get("content") or "")
            remaining = 30000 - total_chars
            if remaining <= 0:
                break
            content = content[:remaining].strip()
            if not content:
                continue
            role = raw_turn["role"]
            cleaned_turns.append({
                "role": role,
                "content": content,
                "type": "card" if raw_turn.get("type") == "card" else "text",
            })
            total_chars += len(content)
            if role == "assistant":
                assistant_turns += 1
        if cleaned_turns:
            cleaned_sessions.append({
                "session_id": hashlib.sha256(str(raw_session.get("session_id") or "unknown").encode()).hexdigest()[:16],
                "user_name": "客户",
                "turns": cleaned_turns,
            })
        if total_chars >= 30000:
            break
    if assistant_turns == 0:
        raise ValueError("no_valid_assistant_samples")
    return cleaned_sessions, {
        "session_count": len(cleaned_sessions),
        "assistant_turns": assistant_turns,
        "total_chars": total_chars,
        "truncated": len(sessions) > 12 or total_chars >= 30000,
    }


def init_feedback_db() -> None:
    FEEDBACK_DB.parent.mkdir(parents=True, exist_ok=True)
    with db_connection() as conn:
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
        columns = {row[1] for row in conn.execute("PRAGMA table_info(tenants)").fetchall()}
        if "webhook_url" not in columns:
            conn.execute("ALTER TABLE tenants ADD COLUMN webhook_url TEXT NOT NULL DEFAULT ''")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS reply_log (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL DEFAULT '',
                user_name TEXT NOT NULL DEFAULT '',
                latest_msg TEXT NOT NULL DEFAULT '',
                reply TEXT NOT NULL DEFAULT '',
                action TEXT NOT NULL DEFAULT '',
                latency_ms INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reply_log_created ON reply_log(created_at DESC)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS alert_log (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                ref_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(tenant_id, kind, ref_id)
            )
        """)


def log_reply(tenant_id: str, session_id: str, user_name: str, latest_msg: str, reply: str, action: str, latency_ms: int) -> None:
    try:
        with db_connection() as conn:
            # 自动清理：保留最近 15 天日志，防止单表无限制膨胀
            cutoff = datetime.now(timezone.utc).timestamp() - 15 * 86400
            cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
            conn.execute("DELETE FROM reply_log WHERE created_at < ?", (cutoff_iso,))
            conn.execute(
                "INSERT OR REPLACE INTO reply_log (id, tenant_id, session_id, user_name, latest_msg, reply, action, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (f"r_{secrets.token_hex(10)}", tenant_id or "", session_id or "", user_name or "",
                 clean_analysis_text(latest_msg, 300), clean_analysis_text(reply, 500), action or "reply", int(latency_ms),
                 datetime.now(timezone.utc).isoformat()),
            )
    except Exception as error:
        print(f"[Reply Log Error] {error}")


def set_tenant_webhook(tenant_id: str, webhook_url: str) -> None:
    with db_connection() as conn:
        conn.execute("UPDATE tenants SET webhook_url=?, updated_at=? WHERE id=?",
                     (clean_analysis_text(webhook_url, 300), datetime.now(timezone.utc).isoformat(), tenant_id))


def get_tenant_webhook(tenant: dict | None) -> str:
    if tenant:
        with db_connection() as conn:
            row = conn.execute("SELECT webhook_url FROM tenants WHERE id=?", (tenant["id"],)).fetchone()
            if row:
                return row[0] or ""
    return ALERT_WEBHOOK


def push_webhook(webhook_url: str, text: str) -> bool:
    """同时兼容飞书群机器人与企微群机器人的文本消息格式。"""
    if not webhook_url:
        return False
    try:
        if "qyapi.weixin.qq.com" in webhook_url:
            payload = {"msgtype": "text", "text": {"content": text[:1800]}}
        else:
            payload = {"msg_type": "text", "content": {"text": text[:1800]}}
        request = urllib.request.Request(webhook_url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                         headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=8) as response:
            return 200 <= response.status < 300
    except Exception as error:
        print(f"[Webhook Error] {error}")
        return False


def alert_once(tenant_id: str, kind: str, ref_id: str, text: str, webhook_url: str) -> bool:
    """推送一次提醒；同租户同类型同对象只提醒一次。"""
    try:
        with db_connection() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO alert_log (id, tenant_id, kind, ref_id, created_at) VALUES (?,?,?,?,?)",
                (f"a_{secrets.token_hex(10)}", tenant_id, kind, ref_id, datetime.now(timezone.utc).isoformat()),
            )
            sent = conn.total_changes
        if sent:
            return push_webhook(webhook_url, text)
        return False
    except Exception as error:
        print(f"[Alert Error] {error}")
        return False


def today_stats(tenant: dict | None) -> dict:
    now = datetime.now(timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    tenant_id = tenant["id"] if tenant else ""
    lead_where, reply_where = ("WHERE tenant_id=?", "WHERE tenant_id=?") if tenant_id else ("WHERE 1=1", "WHERE 1=1")
    lead_params: tuple = (tenant_id, day_start) if tenant_id else (day_start,)
    reply_params: tuple = (tenant_id, day_start) if tenant_id else (day_start,)
    with db_connection() as conn:
        leads_today = conn.execute(f"SELECT COUNT(*) FROM tenant_leads {lead_where} AND created_at>=?", lead_params).fetchone()[0]
        replies_today, avg_latency = conn.execute(
            f"SELECT COUNT(*), COALESCE(AVG(latency_ms),0) FROM reply_log {reply_where} AND created_at>=?", reply_params
        ).fetchone()
        recent_messages = [row[0] for row in conn.execute(
            f"SELECT latest_msg FROM reply_log {reply_where} AND created_at>=? ORDER BY created_at DESC LIMIT 50",
            reply_params,
        ).fetchall()]
    buckets: dict[str, int] = {}
    for message in recent_messages:
        bucket = detect_intent_bucket(message)
        buckets[bucket] = buckets.get(bucket, 0) + 1
    top_intents = sorted(buckets.items(), key=lambda kv: -kv[1])[:4]
    return {"replies": replies_today, "leads": leads_today, "avg_latency_ms": round(avg_latency),
            "top_intents": [{"intent": name, "count": count} for name, count in top_intents]}


def build_digest_text(tenant_name: str, stats: dict) -> str:
    intents = "、".join(f"{item['intent']}×{item['count']}" for item in stats["top_intents"]) or "暂无"
    return (
        f"📊 {tenant_name} 私信经营日报\n"
        f"今日 AI 生成回复：{stats['replies']} 条\n"
        f"今日新增线索：{stats['leads']} 条\n"
        f"平均回复耗时：{stats['avg_latency_ms']}ms\n"
        f"客户在问：{intents}"
    )


def push_daily_digest_if_due() -> None:
    """每天到达 REPORT_HOUR 后向所有配置了 webhook 的租户推送一次日报。"""
    now = datetime.now(timezone.utc)
    today_key = now.strftime("%Y-%m-%d")
    if now.hour < REPORT_HOUR:
        return
    try:
        with db_connection() as conn:
            tenants = conn.execute("SELECT id, workspace_name, webhook_url FROM tenants WHERE webhook_url != ''").fetchall()
        for tenant_id, name, webhook in tenants:
            stats = today_stats({"id": tenant_id})
            if stats["replies"] == 0 and stats["leads"] == 0:
                continue
            alert_once(tenant_id, "daily_digest", today_key, build_digest_text(name or "工作区", stats), webhook)
    except Exception as error:
        print(f"[Digest Error] {error}")


def alert_worker() -> None:
    """后台线程：新线索即时警报 + 每日日报。"""
    init_feedback_db()
    while True:
        try:
            now = datetime.now(timezone.utc)
            window_start = (now - timedelta(minutes=2)).isoformat()
            with db_connection() as conn:
                fresh = conn.execute(
                    "SELECT id, tenant_id, user_name, lead_type, lead_value, context_summary FROM tenant_leads WHERE created_at>=?",
                    (window_start,),
                ).fetchall()
            for lead_id, tenant_id, user_name, lead_type, lead_value, summary in fresh:
                with db_connection() as conn:
                    webhook = conn.execute("SELECT webhook_url FROM tenants WHERE id=?", (tenant_id,)).fetchone()
                webhook_url = (webhook[0] if webhook else "") or ALERT_WEBHOOK
                if webhook_url:
                    alert_once(
                        tenant_id, "new_lead", lead_id,
                        f"🎯 新线索！客户「{user_name or '匿名'}」留下{lead_type}：{lead_value}\n场景：{summary[:80]}\n快去私信台跟进，别让客户凉了。",
                        webhook_url,
                    )
            push_daily_digest_if_due()
        except Exception as error:
            print(f"[Alert Worker Error] {error}")
        time.sleep(60)


def register_tenant(workspace_name: str) -> dict:
    init_feedback_db()
    tenant_id = f"t_{secrets.token_hex(8)}"
    access_token = f"xhs_live_{secrets.token_urlsafe(32)}"
    now = datetime.now(timezone.utc).isoformat()
    with db_connection() as conn:
        conn.execute(
            """INSERT INTO tenants
               (id, token_hash, workspace_name, brand_name, business_profile, reply_preferences, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (tenant_id, token_hash(access_token), clean_analysis_text(workspace_name or "我的工作区", 80),
             "新作AI",
             "【产品定位】新作AI（新作2.0）：面向中小企业与内容创作者的电脑网页端获客图文工具，支持3:4多页图文排版、业务资料知识库与小红书私信副驾。包含专属内测邀请码与算力福利。",
             "先回应客户最后一条消息中的具体问题；结合上下文自然引导体验电脑端或留微信号；语气像真人主理人，自然干练，不堆Emoji，不生硬推销。",
             now, now),
        )
    return {"tenant_id": tenant_id, "access_token": access_token}


def rotate_tenant_token(identifier: str) -> dict:
    """由服务器所有者在本机终端重签令牌，不暴露远程恢复接口。"""
    value = clean_analysis_text(identifier, 120)
    if not value:
        raise ValueError("workspace_identifier_required")
    init_feedback_db()
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT id, workspace_name FROM tenants WHERE id = ? OR workspace_name = ? ORDER BY created_at DESC",
            (value, value),
        ).fetchall()
        if not rows:
            raise ValueError("workspace_not_found")
        if len(rows) > 1:
            raise ValueError("workspace_name_ambiguous_use_tenant_id")
        tenant_id, workspace_name = rows[0]
        access_token = f"xhs_live_{secrets.token_urlsafe(32)}"
        conn.execute(
            "UPDATE tenants SET token_hash = ?, updated_at = ? WHERE id = ?",
            (token_hash(access_token), datetime.now(timezone.utc).isoformat(), tenant_id),
        )
    return {"tenant_id": tenant_id, "workspace_name": workspace_name, "access_token": access_token}


def get_tenant_by_token(access_token: str) -> dict | None:
    if not access_token:
        return None
    init_feedback_db()
    with db_connection() as conn:
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
    with db_connection() as conn:
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


def feedback_scope_stats(scope: str) -> dict:
    init_feedback_db()
    scope = normalize_scope(scope)
    with db_connection() as conn:
        total = conn.execute("SELECT COUNT(*) FROM reply_feedback WHERE scope = ? AND enabled = 1", (scope,)).fetchone()[0]
        disabled = conn.execute("SELECT COUNT(*) FROM reply_feedback WHERE scope = ? AND enabled = 0", (scope,)).fetchone()[0]
    return {"knowledge_count": total, "disabled_count": disabled, "scope": scope}


def tenant_leads_csv(tenant_id: str) -> str:
    leads = list_tenant_leads(tenant_id)
    lines = ["客户昵称,线索类型,联系方式,意向场景,捕获时间"]
    for lead in leads:
        lines.append(
            f'"{_csv_safe(lead.get("user_name", ""))}",{_csv_safe(lead.get("lead_type", ""))},'
            f'{_csv_safe(lead.get("lead_value", ""))},"{_csv_safe(lead.get("context_summary", ""))}",{lead.get("created_at", "")}'
        )
    return "\n".join(lines)


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
    with db_connection() as conn:
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
        with db_connection() as conn:
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
    with db_connection() as conn:
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
    with db_connection() as conn:
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
    with db_connection() as conn:
        cursor = conn.execute(
            "UPDATE reply_feedback SET enabled = ?, disabled_at = ? WHERE id = ? AND scope = ?",
            (1 if enabled else 0, disabled_at, int(feedback_id), scope),
        )
    return cursor.rowcount > 0


def delete_feedback(feedback_id: int, scope: str = "default") -> bool:
    """兼容旧扩展：delete 现在等价于软停用，保留案例和审计记录。"""
    return set_feedback_enabled(feedback_id, False, scope)
