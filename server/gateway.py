"""模型网关：BYOK 配置解析、系统提示词与模型调用。"""
from __future__ import annotations

import json
import os
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
- 客户抱怨没流量/投流亏：“同城聚光没卡对人群确实容易亏 小红书这说话不方便 加个v 微信聊”
- 客户问在吗/发问号：“在的 怎么称呼？您主要做哪块？”
- 客户留了微信号：“收到 稍后加你 备注小红书”

【输出规则】：纯文本，字数 15~35 字，极简干脆、完全零承诺、口语化空格断句，绝不给自己找事。"""


OWNER_DEFAULTS = {
    "workspace_name": "我的工作区",
    "account_id": "",
    "business_line": "default",
    "brand_name": "",
    "business_profile": "",
    "knowledge_text": "",
    "reply_preferences": "先回应具体问题，一次只推进一个动作；少寒暄、少销售腔，不主动索要联系方式。",
}


def resolve_model_config(headers: Any) -> dict:
    header_url = str(headers.get("X-Model-Base-Url") or "").strip()
    header_key = str(headers.get("X-Model-Key") or "").strip()
    header_model = str(headers.get("X-Model-Name") or "").strip()
    if not header_key:
        # 没有客户 Key 就是不带 BYOK：完全使用服务端自身网关配置，
        # 绝不把服务端 Key 转发到调用方指定的地址。
        url, key, model = OPENCODEX_URL, OPENCODEX_API_KEY, OPENCODEX_MODEL
    else:
        url, key, model = header_url, header_key, header_model
    parsed = urlparse(url)
    if PRODUCT_MODE:
        # 如果调用方没有自带外网 Key，或者使用的是本地测试回路，一律默认走服务端网关（Gemini 3.7 Flash）
        if not header_key or (parsed.hostname in ("127.0.0.1", "localhost")):
            return {"url": OPENCODEX_URL, "key": OPENCODEX_API_KEY, "model": OPENCODEX_MODEL}
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
