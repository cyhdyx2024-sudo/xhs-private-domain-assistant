"""XHS 私域接待 LLM Bridge：HTTP 服务与请求编排。"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from db import *  # noqa: F401,F403
from gateway import *  # noqa: F401,F403
from rag import *  # noqa: F401,F403
from safety import *  # noqa: F401,F403
from safety import _is_external_action_status_check

# 评论区雷达依赖本机 xhs CLI（xiaohongshu-cli，逆向签名接口）。
# 路径可用 XHS_CLI_BIN 覆盖；CLI 需已通过 `xhs login` 登录。
XHS_CLI_BIN = os.environ.get("XHS_CLI_BIN", shutil.which("xhs") or "xhs")


def _xhs_cli(*args: str, timeout: int = 90) -> dict:
    result = subprocess.run(
        [XHS_CLI_BIN, *args, "--json"],
        capture_output=True, text=True, timeout=timeout,
    )
    output = result.stdout.strip() or result.stderr.strip()
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        raise ValueError(f"xhs CLI 输出异常: {output[:200]}")


def _extract_note_token(search_payload: dict, note_id: str) -> tuple[str, str]:
    for item in search_payload.get("data", {}).get("items", []):
        item_id = item.get("id") or item.get("note_card", {}).get("note_id")
        if item_id == note_id:
            token = item.get("xsec_token") or item.get("note_card", {}).get("xsec_token", "")
            source = item.get("xsec_source") or "pc_search"
            return token, source
    raise ValueError("搜索结果里没找到这条笔记，换个关键词试试")


def fetch_note_comments(note_ref: str) -> dict:
    """输入笔记 ID / 带参数的笔记链接 / 搜索关键词，返回真实评论列表。"""
    note_ref = (note_ref or "").strip()
    if not note_ref:
        raise ValueError("请输入笔记链接、笔记 ID 或搜索关键词")
    parsed = urlparse(note_ref if "://" in note_ref else f"https://www.xiaohongshu.com/explore/{note_ref}")
    note_id = None
    token = parse_qs(parsed.query).get("xsec_token", [""])[0]
    if re.search(r"/(explore|discovery)/([0-9a-f]{12,})", parsed.path):
        note_id = re.search(r"/(explore|discovery)/([0-9a-f]{12,})", parsed.path).group(2)
    elif re.fullmatch(r"[0-9a-f]{12,}", note_ref):
        note_id = note_ref
    if note_id and token:
        result = _xhs_cli("comments", note_id, "--xsec-token", token)
        if result.get("ok"):
            return result.get("data", {})
    if note_id:
        # 直接读一次以建立上下文缓存，再尝试拉评论
        try:
            _xhs_cli("read", note_id)
            result = _xhs_cli("comments", note_id)
            if result.get("ok"):
                return result.get("data", {})
        except (ValueError, subprocess.TimeoutExpired):
            pass
    # 兜底：把输入当搜索关键词，从搜索结果里解析出笔记和 token
    search_payload = _xhs_cli("search", note_ref)
    search_note_id, token_source = None, ""
    for item in search_payload.get("data", {}).get("items", []):
        candidate = item.get("id") or item.get("note_card", {}).get("note_id")
        if candidate:
            search_note_id, token_source = candidate, item.get("xsec_token") or item.get("note_card", {}).get("xsec_token", "")
            break
    if not search_note_id or not token_source:
        raise ValueError("搜索没有返回可用结果，请换关键词或直接粘贴带 xsec_token 的笔记链接")
    result = _xhs_cli("comments", search_note_id, "--xsec-token", token_source)
    if not result.get("ok"):
        raise ValueError(result.get("error", {}).get("message", "评论拉取失败"))
    return result.get("data", {})


# 注册接口应用层限流：自托管直连(无 nginx)时兜底防工作区表被灌爆。
REGISTER_MAX_PER_MINUTE = 10


REGISTER_HITS: dict[str, list[float]] = {}



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
    fallback_text: str = "",
    temperature: float = 0.55,
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
        "comment_reply": "这是笔记评论区的公开回复：像作者顺手回粉丝一样简短自然（20~60字），只回应这条评论本身；不得推销过度、不得直接索要联系方式，可用轻量引导（如'私信你啦'）。",
        "rewrite_fallback": "上一版草稿被判定为模板腔。请在保持信息准确的前提下，用更自然、更具体的口语重写一版，不要复用原句式。",
    }.get(action, "准确承接客户最后一条消息。")
    if action == "rewrite_fallback" and fallback_text:
        action_note += f"\n待重写的原草稿：{clean_analysis_text(fallback_text, 200)}"
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
        "temperature": min(0.8, max(0.2, float(temperature) or 0.55)),
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
        return (reply if len(reply) >= 6 else "", len(examples), sources)
    except Exception as e:
        print(f"[LLM Error] {e}")
        return "", 0, []


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
        self._send_cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Model-Key, X-Model-Base-Url, X-Model-Name, X-Embedding-Key, X-Embedding-Base-Url, X-Embedding-Model, X-Feishu-App-Id, X-Feishu-App-Secret")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _cors_origin(self) -> str:
        """只对可信来源回显 CORS：本机 Bridge 绝不能变成任意网页可读的开放代理。"""
        origin = str(self.headers.get("Origin") or "").strip()
        if not origin:
            return ""
        try:
            parsed = urlparse(origin)
            host = (parsed.hostname or "").lower()
        except Exception:
            return ""
        if parsed.scheme == "chrome-extension":
            return origin
        if parsed.scheme == "http" and host in ("127.0.0.1", "localhost"):
            return origin
        if parsed.scheme == "https" and (host == "xiaohongshu.com" or host.endswith(".xiaohongshu.com")):
            return origin
        return ""

    def _send_cors(self) -> None:
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self._send_cors()
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
            self._send_json(200, {"ok": True, **feedback_scope_stats(scope)})
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
        elif path == "/report/today":
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            init_feedback_db()
            stats = today_stats(tenant)
            webhook = get_tenant_webhook(tenant)
            stats["webhook_configured"] = bool(webhook)
            self._send_json(200, {"ok": True, **stats})
        elif path == "/leads/export.csv":
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            if not tenant:
                self._send_json(401, {"ok": False, "error": "unauthorized"})
                return
            csv_body = tenant_leads_csv(tenant["id"]).encode("utf-8-sig")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", "attachment; filename=leads_export.csv")
            self._send_cors()
            self.send_header("Content-Length", str(len(csv_body)))
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
            ip = (self.headers.get("X-Forwarded-For") or self.client_address[0] or "-").split(",")[0].strip()
            now = time.monotonic()
            recent = [t for t in REGISTER_HITS.get(ip, []) if now - t < 60.0]
            if len(recent) >= REGISTER_MAX_PER_MINUTE:
                self._send_json(429, {"ok": False, "error": "too_many_registrations"})
                return
            recent.append(now)
            REGISTER_HITS[ip] = recent
            if len(REGISTER_HITS) > 10000:
                REGISTER_HITS.clear()
            try:
                payload = self._read_payload()
            except ValueError:
                self._send_json(413, {"ok": False, "error": "request_too_large"})
                return
            try:
                result = register_tenant(payload.get("workspace_name") or "")
            except ValueError as error:
                self._send_json(400, {"ok": False, "error": str(error)})
                return
            self._send_json(201, {"ok": True, **result})
            return

        if path in {"/reply", "/feedback", "/feedback/delete", "/feedback/status", "/tenant/config", "/tenant/webhook", "/comments/list", "/knowledge/upload", "/knowledge/feishu", "/knowledge/status", "/knowledge/faq/add", "/knowledge/faq/delete", "/leads/delete", "/leads/clear"}:
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            try:
                payload = self._read_payload()
            except ValueError:
                self._send_json(413, {"ok": False, "error": "request_too_large"})
                return
            scope = tenant_scope(tenant, payload.get("knowledge_scope") or "default")

            if path == "/leads/delete":
                if not tenant:
                    self._send_json(401, {"ok": False, "error": "tenant_required"})
                    return
                deleted = delete_tenant_lead(tenant["id"], str(payload.get("id") or ""))
                self._send_json(200 if deleted else 404, {"ok": deleted})
                return

            if path == "/leads/clear":
                if not tenant:
                    self._send_json(401, {"ok": False, "error": "tenant_required"})
                    return
                removed = clear_tenant_leads(tenant["id"])
                self._send_json(200, {"ok": True, "deleted": removed})
                return

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

            if path == "/tenant/webhook":
                if not tenant:
                    self._send_json(400, {"ok": False, "error": "tenant_required"})
                    return
                webhook_url = str(payload.get("url") or "").strip()
                if webhook_url and not (webhook_url.startswith("https://open.feishu.cn/") or webhook_url.startswith("https://qyapi.weixin.qq.com/")):
                    self._send_json(400, {"ok": False, "error": "webhook_url_not_allowed"})
                    return
                set_tenant_webhook(tenant["id"], webhook_url)
                self._send_json(200, {"ok": True, "webhook_url": webhook_url})
                return

            if path == "/comments/list":
                try:
                    data = fetch_note_comments(str(payload.get("note") or ""))
                    comments = []
                    for c in data.get("comments", []):
                        user = c.get("user_info", {}) or {}
                        comments.append({
                            "id": c.get("id"),
                            "author": user.get("nickname") or user.get("nickname_red_id") or "匿名",
                            "location": c.get("ip_location") or "",
                            "content": c.get("content") or "",
                            "likes": c.get("like_count") or 0,
                            "time": c.get("create_time") or "",
                            "sub_count": c.get("sub_comment_count") or 0,
                        })
                    self._send_json(200, {"ok": True, "comments": comments, "has_more": bool(data.get("has_more")), "cursor": data.get("cursor") or ""})
                except (ValueError, subprocess.TimeoutExpired) as error:
                    self._send_json(502, {"ok": False, "error": str(error)})
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
            request_started = time.monotonic()

            # /reply 会真实消耗模型额度：拒绝可信来源之外的浏览器跨域调用，防止被任意网页白嫖。
            origin = str(self.headers.get("Origin") or "").strip()
            if origin and not self._cors_origin():
                self._send_json(403, {"ok": False, "error": "origin_not_allowed"})
                return

            try:
                temperature = min(0.8, max(0.2, float(payload.get("temperature") or (0.3 if action == "rewrite_fallback" else 0.55))))
            except (TypeError, ValueError):
                temperature = 0.55

            try:
                model_config = resolve_model_config(self.headers)
                embedding_config = resolve_embedding_config(self.headers, model_config)
            except ValueError as error:
                self._send_json(400, {"ok": False, "error": str(error)})
                return

            llm_reply, memory_hits, knowledge_sources = call_llm_dynamic(
                user_name, latest_msg, turns, user_msgs, bot_msgs, shared_cards, action,
                knowledge_scope, tenant=tenant, model_config=model_config, embedding_config=embedding_config,
                fallback_text=str(payload.get("fallback_text") or ""), temperature=temperature,
            )
            quality_issues = reply_quality_issues(latest_msg, turns, llm_reply)
            if quality_issues:
                llm_reply = rewrite_failed_reply(latest_msg, turns, llm_reply, quality_issues, tenant, model_config)

            if not llm_reply:
                # 全自动场景宁可不发，也不能用无上下文模板误伤真实客户。
                self._send_json(503, {"ok": False, "error": "llm_unavailable"})
                return

            log_reply(
                tenant["id"] if tenant else "", str(payload.get("session_id") or ""),
                user_name, latest_msg, llm_reply, action, int((time.monotonic() - request_started) * 1000),
            )

            self._send_json(200, {
                "ok": True,
                "reply": llm_reply,
                "engine": f"{model_config['model']} / OpenAI-compatible",
                "memory_hits": memory_hits,
                "knowledge_scope": knowledge_scope,
                "knowledge_sources": knowledge_sources,
                "compliance_flags": compliance_flags(llm_reply),
            })
        else:
            self.send_response(404)
            self.end_headers()


def main():
    parser = argparse.ArgumentParser(description="私域接待 Agent HTTP 服务")
    parser.add_argument("--port", type=int, default=18195)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--rotate-token", metavar="WORKSPACE", help="按 tenant ID 或工作区名称在本机重签访问令牌")
    args = parser.parse_args()
    if args.rotate_token:
        result = rotate_tenant_token(args.rotate_token)
        print(f"workspace: {result['workspace_name']} ({result['tenant_id']})")
        print(f"new access token: {result['access_token']}")
        return

    threading.Thread(target=alert_worker, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), HttpHandler)
    init_feedback_db()
    print(f"✅ 私域接待 LLM 网关已启动: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("服务已停止")


if __name__ == "__main__":
    main()
