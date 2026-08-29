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


SYSTEM_PROMPT = """你是小红书私信顾问。你的目标不是套模板索要联系方式，而是先看懂这位客户刚刚说了什么，再自然推进下一步。

回复决策规则：
1. 先回答客户最后一条消息中的问题或承接其具体信息；至少引用一个当前会话里的具体点。
2. 必须结合完整多轮对话，不能重复客服上一轮已经介绍过的卖点、问题或留资请求。
3. 不得根据昵称猜行业、身份或需求；没有证据时用一个简短问题澄清。
4. 客户只是进入会话、发了空泛问候或分享卡片时，不得强行套家装、美业、投资人等身份。
5. 若客户明确自述是投资人或合作方，如实承接其合作诉求；但不能只做身份介绍，必须逐项回应他提到的具体诉求。未提供的商业数据只说明可按真实口径整理，绝不编造。
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
