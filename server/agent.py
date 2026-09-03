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

from db import (
    add_tenant_faq,
    alert_worker,
    clean_analysis_text,
    clear_tenant_leads,
    delete_feedback,
    delete_tenant_faq,
    delete_tenant_lead,
    feedback_scope_stats,
    get_tenant_by_token,
    get_tenant_webhook,
    init_feedback_db,
    list_feedback,
    list_tenant_faqs,
    list_tenant_leads,
    log_reply,
    record_explicit_tenant_lead,
    record_tenant_lead,
    register_tenant,
    retrieve_faq_matches,
    retrieve_feedback_examples,
    rotate_tenant_token,
    save_feedback,
    sanitize_history_samples,
    set_feedback_enabled,
    set_tenant_webhook,
    tenant_leads_csv,
    tenant_scope,
    today_stats,
    update_tenant,
)
from gateway import (
    get_last_usage,
    OPENCODEX_API_KEY,
    OPENCODEX_MODEL,
    OPENCODEX_URL,
    OWNER_DEFAULTS,
    PRODUCT_MODE,
    build_system_prompt,
    learn_tenant_history,
    request_model,
    resolve_model_config,
)
from rag import (
    extract_uploaded_text,
    import_feishu_doc,
    ingest_knowledge_document,
    list_knowledge_documents,
    resolve_embedding_config,
    retrieve_knowledge_chunks,
    set_knowledge_document_enabled,
)
from safety import (
    _is_external_action_status_check,
    compliance_flags,
    post_model_safety_fallback,
    reply_quality_issues,
    rewrite_failed_reply,
)

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



def format_relative_time(timestamp: int | float | None, now_ts: int | float | None = None) -> str:
    if not timestamp:
        return ""
    now_ts = now_ts or time.time() * 1000
    diff_sec = max(0, int((float(now_ts) - float(timestamp)) / 1000))
    if diff_sec < 60:
        return "刚刚"
    if diff_sec < 3600:
        return f"{diff_sec // 60}分钟前"
    if diff_sec < 86400:
        return f"{diff_sec // 3600}小时前"
    return f"{diff_sec // 86400}天前"


def parse_card_directive(reply: str, latest_msg: str = "", turns: list | None = None) -> tuple[str, str | None]:
    send_card = None
    cleaned = str(reply or "").strip()
    if "[SEND_CARD:WECOM]" in cleaned or "【发企微名片】" in cleaned:
        send_card = "wecom"
        cleaned = re.sub(r"\[SEND_CARD:WECOM\]|【发企微名片】", "", cleaned).strip()
    elif "[SEND_CARD:LEAD]" in cleaned or "【发留资卡】" in cleaned:
        send_card = "lead"
        cleaned = re.sub(r"\[SEND_CARD:LEAD\]|【发留资卡】", "", cleaned).strip()
    elif re.search(r"怎么加|发(?:个|下|我)?(?:微信号?|联系方式)|加(?:个)?(?:微信|微|好友)|(?:微信号?|联系方式)是多少|有没有(?:微信|联系方式)|发我名片|名片发我", str(latest_msg or "")):
        # 客户主动索要微信/联系方式时，自动触发推送企微名片
        send_card = "wecom"
        if re.search(r"你把微信号发我|留个微信|发我一下微信|直接发我微信号|发我微信号", cleaned):
            cleaned = "好的 微信随时沟通 我把企微名片发在下方啦"
    return cleaned, send_card


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
    now_ts = time.time() * 1000
    context_lines = []
    latest_user_ts = 0
    wecom_card_clicked = False

    for turn in turns[-14:]:
        role = turn.get("role")
        if role == "assistant":
            role_label = "客服"
        elif role == "system":
            role_label = "系统通知"
        else:
            role_label = "客户"
        kind = "（企微名片/卡片）" if turn.get("type") == "card" else ""
        content = str(turn.get("content") or "").strip()
        ts = turn.get("timestamp")
        rel_time = format_relative_time(ts, now_ts) if ts else ""
        time_tag = f"[{rel_time}] " if rel_time else ""
        if "对方已点击你的企业微信联系卡" in content or "对方已保存你的名片" in content:
            wecom_card_clicked = True
        if role == "user" and ts:
            latest_user_ts = max(latest_user_ts, float(ts))
        if content:
            context_lines.append(f"{time_tag}{role_label}{kind}：{content}")

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

    shared_user_cards = [clean_analysis_text(t.get("content") or "", 100) for t in turns if t.get("type") == "card" and t.get("role") == "user"]
    if shared_user_cards:
        card_titles = "、".join(f"《{c.splitlines()[0]}》" for c in shared_user_cards if c)
        action_note += (
            f"\n【重要背景：客户在前文已分享过笔记/对标卡片：{card_titles}】。"
            "若客户询问是否适合其业务、能不能做这种形式或提到发了相关账号：严禁让客户重复截图或再次发送！"
            "必须明确引用客户发出的笔记主题，直接正面确认新作2.0完全支持这种3:4图文排版，并顺势引导留微信开通电脑端体验通道。"
        )

    time_strategy_note = ""
    if latest_user_ts:
        gap_sec = int((now_ts - latest_user_ts) / 1000)
        if gap_sec < 600:
            time_strategy_note = "\n【当前处于即时互动期（客户 <10分钟前 刚发送）】：客户当前大概率在线，回复极简、口语化空格断句，直接推进，切忌长篇大论。"
        elif gap_sec < 86400:
            time_strategy_note = f"\n【当前属于日内跟进（距离客户消息已过去 {gap_sec // 3600} 小时）】：自然承接，不刻意道歉，直接给出一句话回应。"
        else:
            days = max(1, gap_sec // 86400)
            time_strategy_note = f"\n【当前属于跨天/沉睡唤醒（距离客户消息已过去 {days} 天）】：客户可能已淡忘当时语境，首句需轻量唤醒主题（如“之前聊到的那个…”、“上次您问的…”），不可当成刚刚在聊。"

    if wecom_card_clicked:
        time_strategy_note += "\n【重点：客户刚点击了企业微信联系卡】：客户已在企微端发起连接，绝不要再问客户要微信号或手机号！回复确认收到，并在企微及时通过/发送资料。"

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
    user_prompt = (
        f"客户昵称：{user_name}\n"
        f"客户最后一条消息：{latest_msg}\n"
        f"任务：{action_note}\n\n"
        f"{time_strategy_note}\n\n"
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
        return request_model(config, request_payload["messages"], request_payload.get("temperature", 0.55), request_payload.get("max_tokens", 120))

    try:
        reply = request_once(payload)
        if len(latest_msg.strip()) >= 15 and len(reply) < 10:
            retry_payload = dict(payload)
            retry_payload["messages"] = payload["messages"] + [
                {"role": "assistant", "content": reply},
                {
                    "role": "user",
                    "content": "这条回复太短且没有回应客户具体问题。请用一两句自然的口语回答并承接下一步，控制在25~60字。"
                }
            ]
            reply = request_once(retry_payload)
        sources = [{key: item[key] for key in ("document_id", "title", "source_type", "source_uri", "version", "score")} for item in knowledge_hits]
        return (reply if len(reply) >= 6 else "", len(examples), sources)
    except Exception as e:
        print(f"[LLM Error] {e}")
        return "", 0, []



SESSION_CALL_TIMES: dict[str, list[float]] = {}
TENANT_CALL_TIMES: dict[str, list[float]] = {}
RATE_LIMIT_LOCK = threading.Lock()


def check_rate_limits(tenant_id: str, session_id: str) -> tuple[bool, str]:
    now = time.monotonic()
    with RATE_LIMIT_LOCK:
        if len(SESSION_CALL_TIMES) > 5000:
            SESSION_CALL_TIMES.clear()
        if len(TENANT_CALL_TIMES) > 5000:
            TENANT_CALL_TIMES.clear()

        if session_id:
            s_times = [t for t in SESSION_CALL_TIMES.get(session_id, []) if now - t < 600.0]
            # 60秒内最多允许2次请求，坚决阻断由于DOM重绘引起的秒级死循环
            recent_1m = [t for t in s_times if now - t < 60.0]
            if len(recent_1m) >= 2:
                return False, "同一会话 60 秒内仅允许请求 2 次，防死循环保护已触发"
            # 10分钟内最多允许8次请求
            if len(s_times) >= 8:
                return False, "同一会话 10 分钟内已达 8 次上限，防死循环保护已触发"
            s_times.append(now)
            SESSION_CALL_TIMES[session_id] = s_times

        if tenant_id:
            t_times = [t for t in TENANT_CALL_TIMES.get(tenant_id, []) if now - t < 3600.0]
            if len(t_times) >= 120:
                return False, "工作区每小时调用已达 120 次硬上限，已触发防刷熔断"
            t_times.append(now)
            TENANT_CALL_TIMES[tenant_id] = t_times

    return True, ""


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
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self._send_cors()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Model-Key, X-Model-Base-Url, X-Model-Name, X-Embedding-Key, X-Embedding-Base-Url, X-Embedding-Model, X-Feishu-App-Id, X-Feishu-App-Secret")
        self.send_header("Access-Control-Allow-Private-Network", "true")
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

        if path in {"/reply", "/feedback", "/feedback/delete", "/feedback/status", "/tenant/config", "/tenant/learn-history", "/tenant/webhook", "/comments/list", "/knowledge/upload", "/knowledge/feishu", "/knowledge/status", "/knowledge/faq/add", "/knowledge/faq/delete", "/knowledge/retrieve", "/leads/capture", "/leads/delete", "/leads/clear"}:
            tenant = self._tenant()
            if PRODUCT_MODE and not tenant:
                return
            try:
                payload = self._read_payload()
            except ValueError:
                self._send_json(413, {"ok": False, "error": "request_too_large"})
                return
            scope = tenant_scope(tenant, payload.get("knowledge_scope") or "default")

            if path == "/leads/capture":
                if not tenant:
                    self._send_json(401, {"ok": False, "error": "tenant_required"})
                    return
                try:
                    created = record_explicit_tenant_lead(
                        tenant["id"], str(payload.get("session_id") or ""),
                        str(payload.get("user_name") or "客户"), str(payload.get("lead_type") or ""),
                        str(payload.get("lead_value") or ""), str(payload.get("context_summary") or ""),
                        lead_timestamp=payload.get("lead_timestamp"),
                    )
                except ValueError as error:
                    self._send_json(400, {"ok": False, "error": str(error)})
                    return
                self._send_json(200, {"ok": True, "created": created})
                return

            if path == "/knowledge/retrieve":
                query = str(payload.get("query") or "").strip()
                tenant_id = tenant["id"] if tenant else ""
                chunks = retrieve_knowledge_chunks(query, tenant_id, None, limit=5)
                faqs = retrieve_faq_matches(query, tenant_id)
                self._send_json(200, {"ok": True, "query": query, "chunks": chunks, "faqs": faqs})
                return

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

            if path == "/tenant/learn-history":
                if not tenant:
                    self._send_json(400, {"ok": False, "error": "tenant_required"})
                    return
                try:
                    model_config = resolve_model_config(self.headers)
                    sessions, sample_stats = sanitize_history_samples(payload.get("sessions"))
                    config, summary = learn_tenant_history(tenant, sessions, model_config)
                except ValueError as error:
                    self._send_json(400, {"ok": False, "error": str(error)})
                    return
                except Exception as error:
                    print(f"[History Learning Error] {error}")
                    self._send_json(500, {"ok": False, "error": "history_learning_failed"})
                    return
                self._send_json(200, {
                    "ok": True, "config": config, "summary": summary,
                    "sample_stats": sample_stats,
                })
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
                    try:
                        model_config = resolve_model_config(self.headers)
                        embedding_config = resolve_embedding_config(self.headers, model_config)
                    except Exception:
                        model_config = None
                        embedding_config = None
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
                        # 优先借助本地 lark-cli 导入，若无配置才校验 app_id
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
                lead_ts = payload.get("lead_timestamp")
                record_tenant_lead(tenant["id"], sid, user_name, latest_msg, lead_timestamp=lead_ts)
                for t in turns:
                    if isinstance(t, dict) and t.get("role") == "user":
                        t_ts = t.get("timestamp")
                        record_tenant_lead(tenant["id"], sid, user_name, str(t.get("content") or ""), lead_timestamp=t_ts)
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

            # 服务端会话级与租户级防死循环硬熔断
            sid = str(payload.get("session_id") or "")
            passed, limit_err = check_rate_limits(tenant["id"] if tenant else "", sid)
            if not passed:
                self._send_json(429, {"ok": False, "error": "rate_limited", "message": limit_err})
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
            quality_issues = reply_quality_issues(latest_msg, turns, llm_reply, action)
            if quality_issues:
                llm_reply = rewrite_failed_reply(latest_msg, turns, llm_reply, quality_issues, tenant, model_config)

            used_safety_fallback = False
            if not llm_reply and action != "comment_reply":
                # 模型已读取完整上下文但两次输出都未通过安全质检时，才使用最小兜底；
                # 兜底不能代替模型做意图识别，更不能绕过 BYOK 配置。
                llm_reply = post_model_safety_fallback(latest_msg, turns, action)
                used_safety_fallback = bool(llm_reply)

            if not llm_reply:
                # 全自动场景宁可不发，也不能用无上下文模板误伤真实客户。
                self._send_json(503, {"ok": False, "error": "llm_unavailable"})
                return

            clean_reply, send_card = parse_card_directive(llm_reply, latest_msg, turns)

            log_reply(
                tenant["id"] if tenant else "", str(payload.get("session_id") or ""),
                user_name, latest_msg, clean_reply, action, int((time.monotonic() - request_started) * 1000),
            )

            last_usage = get_last_usage()
            self._send_json(200, {
                "ok": True,
                "reply": clean_reply,
                "usage": last_usage,
                "send_card": send_card,
                "engine": (
                    f"{model_config['model']} / OpenAI-compatible"
                    + (" + safety fallback" if used_safety_fallback else "")
                ),
                "memory_hits": memory_hits,
                "knowledge_scope": knowledge_scope,
                "knowledge_sources": knowledge_sources,
                "compliance_flags": compliance_flags(clean_reply),
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
