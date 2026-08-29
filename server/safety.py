"""安全护栏：事实守卫、对话守卫与质检重写。"""
from __future__ import annotations

import re

from db import clean_analysis_text
from gateway import build_system_prompt, request_model

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
        r"|(?:加|通过).{0,4}(?:了吗|没呀|没啊)"
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

    if _is_presence_ping(latest) and (_asks_for_contact(current) or len(current) > 105 or re.search(r"内测|专属邀请码|行业模板", current)):
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
        if re.search(
            r"(?:已经?|刚刚?|正在|这就)(?:[^。！？\n]{0,10})?(?:发送|发出|添加|加好|通过|处理|提交|申请|搜索)"
            r"|加好了|发好了|提交了好友申请|通过了好友申请",
            current,
        ) and not re.search(r"无法确认|不能确认|暂时看不到|需要核对|还没法|尚未", current):
            issues.append("当前会话无法核验外部动作状态，回复却声称已经完成")
    if re.search(
        r"(?:我|这边)?(?:这就|马上|稍后|待会儿?|现在|回头).{0,10}(?:添加|加|发送|发|通过|处理|提交|申请|标记|记录)|"
        r"(?:我|这边)?帮您?.{0,6}(?:添加|加|发送|发|通过|标记|提交)(?:一下)?(?:申请|好友|资料|链接)?",
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

