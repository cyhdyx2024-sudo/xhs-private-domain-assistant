"""模型网关：BYOK 配置解析、系统提示词与模型调用。"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Any
from urllib.parse import urlparse

OPENCODEX_URL = os.environ.get("OPENCODEX_URL", "http://127.0.0.1:10100/v1/chat/completions")


OPENCODEX_API_KEY = os.environ.get("OPENCODEX_API_KEY", "")


OPENCODEX_MODEL = os.environ.get("OPENCODEX_MODEL", "google-antigravity/gemini-3.7-flash")


PRODUCT_MODE = os.environ.get("XHS_PRODUCT_MODE", "1") == "1"


ALLOWED_MODEL_HOSTS = {
    host.strip().lower() for host in os.environ.get(
        "XHS_ALLOWED_MODEL_HOSTS",
        "api.openai.com,api.deepseek.com,dashscope.aliyuncs.com,open.bigmodel.cn,api.moonshot.cn,api.siliconflow.cn,ark.cn-beijing.volces.com,api.minimax.chat,openrouter.ai",
    ).split(",") if host.strip()
}


SYSTEM_PROMPT = """你是一个在小红书做业务的真人老板。你在手机端随手回私信。

【绝对铁律：彻底实现“0承诺”！绝不给自己揽任何售后和作业】：
1. 严禁任何形式的承诺！
   - 绝不说“我帮你评估/我帮你瞅一眼/我帮你把脉” ❌（客户加上微信就会找你要诊断报告，烦死！）
   - 绝不说“我告诉你怎么切流量/我教你怎么做” ❌（不要给自己揽老师的包袱！）
   - 绝不说“我发你案例库/发你明细” ❌（不要承诺任何现成资产！）
2. 真实人类加微信的最纯粹理由：
   - 纯粹因为“小红书私信沟通不方便/容易吞消息/随时断联”，所以“加个微信方便联系/微信聊”。
   - 没有任何附加承诺，加上微信就只是加了个好友，你想聊就聊，不想聊就不聊，零心理负担！

【真实人类人声示范（极简、0承诺、真人口语）】：
- 问怎么做/怎么用：“做图文关键是踩准人群痛点 小红书私信老漏消息 加个v 微信聊更方便”
- 问价格/多少钱：“价格要看具体版本和需求 小红书这不好细说 加个v 微信发你”
- 问美业/家装/教培等行业：“美业能做的 转化挺直接 平台私信容易吞 加个v 微信详聊”
- 客户发了参考笔记/对标卡片（如考证笔记、图文对标）问能不能做：“看到了！像您发的《中级审计师》这种考证多页图文新作完全能做，自带3:4排版模板。方便留个微信吗？我发您电脑端体验通道和算力先跑一套看看～”
- 客户抱怨没流量/投流亏：“同城聚光没卡对人群确实容易亏 小红书这说话不方便 加个v 微信聊”
- 客户问在吗/发问号：“在的 怎么称呼？您主要做哪块？”
- 客户点开企微名片：“收到 看到您点开名片了 如果没跳转过去跟我说一声 我直接微信发你电脑端通道”
- 客户留了微信号：“收到 备注小红书”

【输出规则】：纯文本，字数 15~35 字，极简干脆、完全零承诺、口语化空格断句，绝不给自己找事。"""
OWNER_DEFAULTS = {
    "workspace_name": "我的工作区",
    "account_id": "",
    "business_line": "default",
    "brand_name": "新作AI",
    "business_profile": "【产品定位】新作AI（新作2.0）：面向中小企业与内容创作者的电脑网页端获客图文工具，支持3:4多页图文排版、业务资料知识库与小红书私信副驾。",
    "knowledge_text": "",
    "reply_preferences": "先回应客户具体问题，一次推进一个动作；语气自然干练，像真人主理人；结合上下文自然引导开通电脑端体验与留微信。",
}


def _is_local_opencodex_endpoint(url: str) -> bool:
    parsed = urlparse(url)
    return (
        parsed.scheme in {"http", "https"}
        and (parsed.hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}
        and parsed.path.rstrip("/") == "/v1/chat/completions"
    )


def resolve_model_config(headers: Any) -> dict:
    header_url = str(headers.get("X-Model-Base-Url") or "").strip()
    header_key = str(headers.get("X-Model-Key") or "").strip()
    header_model = str(headers.get("X-Model-Name") or "").strip()
    url = header_url or OPENCODEX_URL
    key = header_key or OPENCODEX_API_KEY
    model = header_model or OPENCODEX_MODEL
    parsed = urlparse(url)
    if PRODUCT_MODE:
        local_opencodex = _is_local_opencodex_endpoint(url)
        if not local_opencodex and not key:
            raise ValueError("model_api_key_required")
        if not url:
            raise ValueError("model_endpoint_required")
        if not model:
            raise ValueError("model_name_required")
        if not local_opencodex and (
            parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_MODEL_HOSTS
        ):
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
    headers = {"Content-Type": "application/json"}
    if model_config.get("key"):
        headers["Authorization"] = f"Bearer {model_config['key']}"
    req = urllib.request.Request(model_config["url"], data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        result = json.loads(resp.read().decode("utf-8"))
    choice = result["choices"][0] if result.get("choices") else {}
    msg = choice.get("message", {})
    content = str(msg.get("content") or "").strip().strip('"“”')
    return content


def learn_tenant_history(tenant: dict, sessions: list[dict], model_config: dict) -> tuple[dict, str]:
    """从当前租户的人工历史回复中学习业务画像和表达偏好，并立即写回租户。"""
    from db import clean_analysis_text, update_tenant

    sample_blocks = []
    for index, session in enumerate(sessions, 1):
        lines = []
        for turn in session.get("turns", []):
            role = "客服" if turn.get("role") == "assistant" else "客户"
            lines.append(f"{role}：{turn.get('content', '')}")
        if lines:
            sample_blocks.append(f"【会话 {index}】\n" + "\n".join(lines))
    if not sample_blocks:
        raise ValueError("no_valid_assistant_samples")

    messages = [
        {
            "role": "system",
            "content": (
                "你是客服话术分析员。只学习客服历史回复体现出的业务定位、推进目标、表达风格和禁忌。"
                "客户发言仅用于理解场景，绝不能把客户说法当成商家的产品事实。严格输出 JSON。"
            ),
        },
        {
            "role": "user",
            "content": (
                "请分析以下小红书私信历史。只从标记为客服的回复总结；不补充价格、功能或服务承诺。\n\n"
                + "\n\n".join(sample_blocks)
                + "\n\n只输出 JSON："
                '{"business_profile":"客服回复中反复确认的业务定位，未确认则留空",'
                '"reply_preferences":"推进目标、语气、句式、节奏和禁忌",'
                '"summary":"本次学习摘要"}'
            ),
        },
    ]
    raw = request_model(model_config, messages, temperature=0.2, max_tokens=1200)
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise ValueError("history_learning_invalid_output")
    try:
        learned = json.loads(match.group(0))
    except json.JSONDecodeError as error:
        raise ValueError("history_learning_invalid_output") from error

    business_profile = clean_analysis_text(learned.get("business_profile") or "", 4000)
    reply_preferences = clean_analysis_text(learned.get("reply_preferences") or "", 3000)
    if not (business_profile or reply_preferences):
        raise ValueError("history_learning_empty_output")

    # update_tenant 目前接收完整配置；显式合并可防止学习话术时清空工作区身份和知识资料。
    payload = {
        key: tenant.get(key) or ""
        for key in (
            "workspace_name", "account_id", "business_line", "brand_name",
            "business_profile", "knowledge_text", "reply_preferences",
        )
    }
    if business_profile:
        payload["business_profile"] = business_profile
    if reply_preferences:
        payload["reply_preferences"] = reply_preferences
    updated = update_tenant(tenant["id"], payload)
    summary = clean_analysis_text(learned.get("summary") or "已学习历史回复", 500)
    return updated, summary
