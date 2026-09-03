// Background Service Worker for XHS Copilot Pro
// Background Service Worker for XHS Copilot Pro
const sendLeases = new Map();

function leaseOwner(sender) {
  return `${sender?.tab?.id ?? 'no-tab'}:${sender?.frameId ?? 0}`;
}

function acquireSendLease(key, sender, now = Date.now(), ttlMs = 90_000) {
  const owner = leaseOwner(sender);
  const current = sendLeases.get(key);
  if (current && current.expiresAt > now && current.owner !== owner) {
    return { acquired: false, expiresAt: current.expiresAt };
  }
  const lease = { owner, expiresAt: now + Math.max(10_000, Math.min(Number(ttlMs) || 90_000, 180_000)) };
  sendLeases.set(key, lease);
  return { acquired: true, expiresAt: lease.expiresAt };
}

function releaseSendLease(key, sender) {
  const current = sendLeases.get(key);
  if (!current || current.owner !== leaseOwner(sender)) return false;
  sendLeases.delete(key);
  return true;
}

async function handleDirectModelFallback(url, options) {
  const storage = await new Promise(res => chrome.storage.local.get(null, res));
  const headers = options.headers || {};
  const modelUrl = headers['X-Model-Base-Url'] || storage.modelBaseUrl || 'http://127.0.0.1:10100/v1/chat/completions';
  const modelName = headers['X-Model-Name'] || storage.modelName || 'google-antigravity/gemini-3.7-flash';
  const modelKey = headers['X-Model-Key'] || storage.modelApiKey || '';

  if (url.includes('/healthz')) {
    return { ok: true, status: 200, data: { ok: true, service: 'Direct Local Mode', product_mode: true }, text: '{"ok":true}' };
  }

  if (url.includes('/tenant/config')) {
    const cfg = {
      brand_name: storage.brandName || '新作AI',
      business_profile: storage.businessProfile || '【产品定位】新作AI（新作2.0）：面向中小企业与内容创作者的电脑网页端获客图文工具，支持3:4多页图文排版、业务资料知识库与小红书私信副驾。包含专属内测邀请码与算力福利。',
      reply_preferences: storage.replyPreferences || '先回应客户最后一条消息中的具体问题；结合上下文自然引导体验电脑端或留微信号；语气像真人主理人，自然干练，不堆Emoji，不生硬推销。'
    };
    return { ok: true, status: 200, data: { ok: true, config: cfg }, text: JSON.stringify({ ok: true, config: cfg }) };
  }

  if (url.includes('/report/today')) {
    return { ok: true, status: 200, data: { ok: true, replies: Number(storage.repliedCount || 0), leads: Number(storage.leadsCount || 0), avg_latency_ms: 800, top_intents: [] }, text: '{"ok":true}' };
  }

  if (url.includes('/tenant/learn-history')) {
    let payload = {};
    try { payload = JSON.parse(options.body || '{}'); } catch (_) {}
    const sessions = payload.sessions || [];
    const sampleLines = [];
    sessions.forEach((s, idx) => {
      const turns = (s.turns || []).map(t => (t.role === 'assistant' ? '客服：' : '客户：') + t.content).join('\n');
      sampleLines.push('【会话 ' + (idx + 1) + '】\n' + turns);
    });
    const prompt = '请根据以下小红书历史私信会话，提炼客服的人设画像、表达风格与语气偏好。\n【特别规则】：客户发言仅作为场景，严禁从客户发言推断硬产品事实！\n\n' + sampleLines.join('\n\n') + '\n\n只返回 JSON 对象，不要其他文字：\n{"business_profile":"客服表现出的业务定位与核心服务介绍（200字以内）","reply_preferences":"客服的话术风格、推进策略、语气、禁忌等（200字以内）","summary":"本次学习总结（100字以内）"}';
    const modelHeaders = { 'Content-Type': 'application/json' };
    if (modelKey) modelHeaders.Authorization = 'Bearer ' + modelKey;
    const modelResp = await fetch(modelUrl, {
      method: 'POST',
      headers: modelHeaders,
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: '你是资深客服话术分析专家。必须只输出标准 JSON。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 800
      })
    });
    const rawText = await modelResp.text();
    const modelData = JSON.parse(rawText);
    const replyContent = modelData.choices?.[0]?.message?.content || '';
    const match = replyContent.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const patch = {
      businessProfile: parsed.business_profile || storage.businessProfile,
      replyPreferences: parsed.reply_preferences || storage.replyPreferences,
      historyLearnedAt: Date.now(),
      learnedSummary: parsed.summary || '已学习历史回复',
      configVersion: Date.now()
    };
    await new Promise(res => chrome.storage.local.set(patch, res));
    return {
      ok: true,
      status: 200,
      data: { ok: true, config: { business_profile: patch.businessProfile, reply_preferences: patch.replyPreferences }, summary: patch.learnedSummary },
      text: JSON.stringify({ ok: true, config: patch, summary: patch.learnedSummary })
    };
  }

  if (url.includes('/reply')) {
    let payload = {};
    try { payload = JSON.parse(options.body || '{}'); } catch (_) {}
    const latestMsg = payload.latest_msg || '';
    const turns = payload.turns || [];
    const brandName = storage.brandName || '新作AI';
    const businessProfile = storage.businessProfile || '【产品定位】新作AI（新作2.0）：面向中小企业与内容创作者的电脑网页端获客图文工具，支持3:4多页图文排版、业务资料知识库与小红书私信副驾。包含专属内测邀请码与算力福利。';
    const replyPreferences = storage.replyPreferences || '先回应客户最后一条消息中的具体问题；结合上下文自然引导体验电脑端或留微信号；语气像真人主理人，自然干练，不堆Emoji，不生硬推销。';

    const contextLines = turns.map(t => (t.role === 'assistant' ? '客服：' : (t.role === 'system' ? '系统：' : '客户：')) + (t.content || '')).join('\n');
    const isWecomClick = turns.some(t => String(t.content || '').includes('对方已点击你的企业微信联系卡'));
    if (isWecomClick) {
      const directReply = '看到你点开名片了 如果没跳转成功跟我说一声就行';
      return { ok: true, status: 200, data: { ok: true, reply: directReply, send_card: null, compliance_flags: [] }, text: JSON.stringify({ ok: true, reply: directReply }) };
    }

    const systemPrompt = '你是在小红书接待客户咨询的真人业务主理人。请基于已确认资料与上下文如实回复。\n\n【当前工作区资料】：\n品牌/项目：' + brandName + '\n业务介绍：' + businessProfile + '\n回复偏好：' + replyPreferences + '\n\n【规则】：输出纯文本，15~40字，自然口语短句，先解答问题，一次推进一个动作，严禁承诺未核验动作（如稍后加你/正在通过）。';
    const userPrompt = '客户昵称：' + (payload.user_name || '客户') + '\n客户最后一条消息：' + latestMsg + '\n\n真实会话记录：\n' + contextLines;

    const modelHeaders = { 'Content-Type': 'application/json' };
    if (modelKey) modelHeaders.Authorization = 'Bearer ' + modelKey;
    const modelResp = await fetch(modelUrl, {
      method: 'POST',
      headers: modelHeaders,
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
        max_tokens: 600
      })
    });
    const rawText = await modelResp.text();
    const modelData = JSON.parse(rawText);
    const replyContent = (modelData.choices?.[0]?.message?.content || '').trim().replace(/^[\"“”]|[\"“”]$/g, '');
    return {
      ok: true,
      status: 200,
      data: { ok: true, reply: replyContent || '收到，这就为您安排', send_card: null, compliance_flags: [] },
      text: JSON.stringify({ ok: true, reply: replyContent })
    };
  }

  return { ok: false, status: 502, error: 'Bridge 服务未启动，直连模式不支持该接口' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'BRIDGE_FETCH') {
    const { url, options } = message;
    fetch(url, options)
      .then(async response => {
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        sendResponse({
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          data: json,
          text
        });
      })
      .catch(async () => {
        try {
          const fallbackResult = await handleDirectModelFallback(url, options);
          sendResponse(fallbackResult);
        } catch (fbErr) {
          sendResponse({
            ok: false,
            status: 0,
            error: fbErr.message || '网络连接失败',
            data: { ok: false, error: fbErr.message || '网络连接失败' },
            text: JSON.stringify({ ok: false, error: fbErr.message || '网络连接失败' })
          });
        }
      });
    return true;
  }
  if (message?.type === 'ACQUIRE_SEND_LEASE') {
    const key = String(message.key || '').slice(0, 500);
    sendResponse(key ? acquireSendLease(key, sender, Date.now(), message.ttlMs) : { acquired: false });
    return false;
  }
  if (message?.type === 'RELEASE_SEND_LEASE') {
    sendResponse({ released: releaseSendLease(String(message.key || ''), sender) });
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});
