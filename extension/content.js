/**
 * 小红书专业号私信智能顾问 V1.0
 * 会话以 data-key（UID）隔离；副驾只预填；全自动发送前会再次核验会话与消息签名。
 */
(function () {
  'use strict';
  if (window.top !== window) return;

  const VERSION = '1.0.1';
  const Safety = globalThis.XhsSafety;
  const DEFAULTS = {
    enabled: false, onboardingComplete: false, runMode: 'copilot', timeScope: 'all_day', fullAutoArmedAt: 0, operatorAway: false,
    cooldownMinutes: 30, maxRepliesPerHour: 12, autoReplyMaxAgeMinutes: 120,
    repliedCount: 0, leadsCount: 0, statsDate: '', contactBlacklist: [],
    processedMap: {}, hourlySendTimestamps: [], uncertainSendMap: {},
    bridgeUrl: 'https://xhs.chenyaohui.com/xhs-agent', workspaceToken: '', accountId: '',
    knowledgeScope: 'default', modelBaseUrl: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini', modelApiKey: '', embeddingBaseUrl: '', embeddingModel: '', embeddingApiKey: '',
    feishuAppId: '', feishuAppSecret: '',
    monitor: { lastLlmAt: 0, lastLlmLatencyMs: 0, llmSuccessCount: 0, llmFailureCount: 0,
      sendSuccessCount: 0, sendFailureCount: 0, readbackFailureCount: 0, lastError: '' }
  };

  if (window.__XHS_REPLY_V11__?.destroy) window.__XHS_REPLY_V11__.destroy();
  else if (window.__XHS_REPLY_V10__?.destroy) window.__XHS_REPLY_V10__.destroy();
  document.getElementById('xhs-reply-dock-root')?.remove();

  let state = { ...DEFAULTS, logs: [] };
  let destroyed = false;
  let requestSerial = 0;
  let requestController = null;
  let autoProcessing = false;
  let lastUserActivityAt = Date.now();
  let currentSessionId = '';
  let currentDraftSessionId = '';
  let senseTimer = null;
  let autoTimer = null;
  let observer = null;
  let senseDebounce = null;
  let feedbackCandidate = null;
  const feedbackCandidates = new Map();
  let lastVirtualSweepAt = 0;

  const draftCache = new Map();
  const inFlightSignatures = new Set();
  const messageRetryUntil = new Map();
  const contactRetryUntil = new Map();
  const signatureFailureCounts = new Map();
  const scanSeenIds = new Set();
  let globalCircuitUntil = 0;
  let scanPassStartedAt = Date.now();
  const storageGet = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const storageSet = values => new Promise(resolve => chrome.storage.local.set(values, resolve));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();

  async function ensureDailyStats() {
    const next = Safety.normalizeDailyStats(state);
    if (next.statsDate === state.statsDate) return;
    Object.assign(state, next);
    await storageSet(next);
  }

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isVirtualGhost(element) {
    const virtualView = element?.closest?.('.vue-recycle-scroller__item-view');
    return /translateY\(\s*-9999px\s*\)/.test(virtualView?.style?.transform || '');
  }

  function getReplyTextarea() {
    return Array.from(document.querySelectorAll('textarea.reply-textarea, textarea'))
      .find(el => isVisible(el) && /发送信息|快捷回复/.test(el.placeholder || '')) ||
      Array.from(document.querySelectorAll('textarea.reply-textarea')).find(isVisible) || null;
  }

  function getActiveCard() {
    const cards = Array.from(document.querySelectorAll('.sx-contact-item.active'));
    return cards.find(card => isVisible(card) && !isVirtualGhost(card)) || null;
  }

  function extractAccountFromHeader() {
    // 锁定页面顶部右上角的店铺小红书号，避免在正文/客资区匹配到客户号
    const headerCandidates = Array.from(document.querySelectorAll('[class*="header"] [class*="account"], [class*="header"] [class*="xhs-id"], .user-profile-card, .account-info'));
    for (const el of headerCandidates) {
      const match = cleanText(el.innerText).match(/小红书号[：:]\s*(\S+)/);
      if (match) return match[1];
    }
    // 回退：搜索页面顶部（y < 80px）且 x > 60%宽度的"小红书号"文本
    const allTexts = Array.from(document.querySelectorAll('span, div, p')).filter(el => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.top < 80 && rect.left > window.innerWidth * 0.6 && cleanText(el.innerText).includes('小红书号');
    });
    for (const el of allTexts) {
      const match = cleanText(el.innerText).match(/小红书号[：:]\s*(\S+)/);
      if (match) return match[1];
    }
    return '';
  }

  function getRightPanelCustomerName() {
    const candidates = Array.from(document.querySelectorAll('.user-nickname'))
      .filter(el => isVisible(el) && cleanText(el.innerText) && cleanText(el.innerText) !== '新作AI')
      .filter(el => el.getBoundingClientRect().left > window.innerWidth * 0.68);
    return cleanText(candidates[0]?.innerText);
  }

  function getActiveSession() {
    const card = getActiveCard();
    if (!card) return null;
    const name = cleanText(card.querySelector('.nick-name')?.innerText);
    const dataKey = card.getAttribute('data-key') || '';
    const rightName = getRightPanelCustomerName();
    const id = dataKey || `name:${name}`;
    if (!name || !id) return null;
    return { id, uid: dataKey.replace(/^.*?-/, ''), name, card, stable: !rightName || rightName === name };
  }

  function getKnowledgeScope() {
    // 优先从页面顶部提取店铺号，保证即使 state.accountId 配错也能正确隔离
    const pageAccount = extractAccountFromHeader();
    const account = cleanText(pageAccount || state.accountId);
    const businessLine = state.knowledgeScope || 'new-ai';
    return `xhs:${location.hostname}:${account || 'unconfigured'}:${businessLine}`;
  }

  function getBridgeUrl() {
    return String(state.bridgeUrl || DEFAULTS.bridgeUrl).replace(/\/+$/, '');
  }

  function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (state.workspaceToken) headers.Authorization = `Bearer ${state.workspaceToken}`;
    if (state.modelApiKey) headers['X-Model-Key'] = state.modelApiKey;
    if (state.modelBaseUrl) headers['X-Model-Base-Url'] = state.modelBaseUrl;
    if (state.modelName) headers['X-Model-Name'] = state.modelName;
    if (state.embeddingBaseUrl) headers['X-Embedding-Base-Url'] = state.embeddingBaseUrl;
    if (state.embeddingModel) headers['X-Embedding-Model'] = state.embeddingModel;
    if (state.embeddingApiKey) headers['X-Embedding-Key'] = state.embeddingApiKey;
    return headers;
  }

  function feishuHeaders() {
    const headers = apiHeaders();
    if (state.feishuAppId) headers['X-Feishu-App-Id'] = state.feishuAppId;
    if (state.feishuAppSecret) headers['X-Feishu-App-Secret'] = state.feishuAppSecret;
    return headers;
  }

  function recordMonitor(patch) {
    state.monitor = { ...(state.monitor || {}), ...patch };
    storageSet({ monitor: state.monitor });
    syncMonitorUI();
  }

  function parseTimestamp(text) {
    return Safety.parseMessageTimestamp(text);
  }

  function emptyHistory(session) {
    return {
      sessionId: session?.id || '', contactName: session?.name || '', turns: [], userMessages: [],
      botMessages: [], sharedCards: [], latestUserMsg: '', latestUserTurn: null,
      latestAssistantTurn: null, newestTurn: null, needsReply: false,
      signature: `${session?.id || 'unknown'}::empty`
    };
  }

  function parseConversationHistory(session) {
    const scroller = Array.from(document.querySelectorAll('.vue-recycle-scroller.recyScroll1'))
      .find(el => isVisible(el) && el.querySelector('.im-msg-item'));
    if (!scroller) return emptyHistory(session);

    const records = Array.from(scroller.querySelectorAll('.im-msg-item'))
      .filter(item => {
        if (!isVisible(item)) return false;
        // 切换客户后，Vue 会把上一会话的复用节点移到 -9999px，但节点尺寸仍非 0。
        // 这些节点若不排除，会把 A 客户的消息混入 B 客户上下文。
        return !isVirtualGhost(item);
      })
      .map((item, domIndex) => {
        const bubble = item.querySelector('.text-message, .card_container');
        if (!bubble || !isVisible(bubble)) return null;
        const content = cleanText(bubble.innerText || bubble.textContent);
        if (!content) return null;
        const itemRect = item.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        const hasRightDirection = Boolean(item.querySelector('.right'));
        const hasLeftDirection = Boolean(item.querySelector('.left'));
        return {
          role: hasRightDirection || (!hasLeftDirection && bubbleRect.left >= itemRect.left + itemRect.width * 0.43)
            ? 'assistant'
            : 'user',
          content,
          type: bubble.classList.contains('card_container') ? 'card' : 'text',
          timestamp: parseTimestamp(cleanText(item.innerText || item.textContent)),
          domIndex
        };
      }).filter(Boolean);

    // 宽窄屏与虚拟列表重排会改变 DOM/坐标顺序；时间戳才是“最后发言方”的真源。
    const newestFirst = records.sort((a, b) => {
      if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      return a.domIndex - b.domIndex;
    });

    // 页面 DOM 是最新到最旧；给 LLM 的多轮上下文必须是最旧到最新。
    const turns = newestFirst.slice().reverse();
    const latestUserTurn = newestFirst.find(turn => turn.role === 'user') || null;
    const latestAssistantTurn = newestFirst.find(turn => turn.role === 'assistant') || null;
    const newestTurn = newestFirst[0] || null;
    const userMessages = turns.filter(t => t.role === 'user' && t.type === 'text').map(t => t.content);
    const botMessages = turns.filter(t => t.role === 'assistant').map(t => t.content);
    const sharedCards = turns.filter(t => t.role === 'user' && t.type === 'card').map(t => t.content);
    const sig = latestUserTurn ? `${latestUserTurn.timestamp || latestUserTurn.domIndex}:${latestUserTurn.content}` : 'no-user';
    return {
      sessionId: session.id, contactName: session.name, turns, userMessages, botMessages, sharedCards,
      latestUserMsg: latestUserTurn?.content || '', latestUserTurn, latestAssistantTurn, newestTurn,
      needsReply: Boolean(latestUserTurn && newestTurn?.role === 'user'),
      signature: `${session.id}::${sig}`
    };
  }

  function extractLead(text) {
    if (!text) return null;
    const phone = text.match(/(?:1[3-9]\d{9})/);
    const wechat = text.match(/(?:微信号?|vx|wx|VX)[\s:：_\-]*([a-zA-Z][a-zA-Z0-9_-]{5,19}|1[3-9]\d{9})/i);
    if (phone) return { type: '手机号', value: phone[0] };
    if (wechat) return { type: '微信号', value: wechat[1] || wechat[0] };
    return null;
  }

  function safeSetNativeValue(element, value) {
    if (!element) return;
    element.focus();
    const proto = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function syncLeadToRightPanel(lead) {
    if (!lead) return;
    const selector = lead.type === '手机号' ? 'input[placeholder="请填写手机号码"]' : 'input[placeholder="请填写微信账号"]';
    const input = document.querySelector(selector);
    if (input && !cleanText(input.value)) {
      safeSetNativeValue(input, lead.value);
      ensureDailyStats().then(() => {
        state.leadsCount += 1;
        storageSet({ leadsCount: state.leadsCount, statsDate: state.statsDate });
      });
      addLog('lead', `已识别${lead.type}并预填右侧客资：${lead.value}`);
    }
  }

  function abortPendingRequest(reason) {
    requestSerial += 1;
    requestController?.abort(reason || 'session_changed');
    requestController = null;
    inFlightSignatures.clear();
  }

  async function suspendForAuthFailure() {
    state.enabled = false;
    state.onboardingComplete = false;
    state.fullAutoArmedAt = 0;
    state.operatorAway = false;
    state.workspaceToken = '';
    globalCircuitUntil = Infinity;
    await storageSet({ enabled: false, onboardingComplete: false, fullAutoArmedAt: 0, operatorAway: false, workspaceToken: '' });
    syncDockFromState();
    addLog('error', '工作区凭据已失效，系统已停机。请打开完整管理控制台重新保存配置');
  }

  async function fetchLLMReply(history, session, action) {
    if (!history.latestUserMsg && action !== 'manual_followup') return '';
    if (inFlightSignatures.has(history.signature)) return '';
    const retryAt = Math.max(Number(messageRetryUntil.get(history.signature) || 0), Number(globalCircuitUntil || 0));
    if (retryAt > Date.now()) return '';
    const serial = ++requestSerial;
    requestController?.abort('superseded');
    const controller = new AbortController();
    requestController = controller;
    inFlightSignatures.add(history.signature);
    const requestStartedAt = Date.now();
    addLog('info', `分析 [${session.name}] 的 ${history.turns.length} 条会话记录…`);
    try {
      const response = await fetch(`${getBridgeUrl()}/reply`, {
        method: 'POST', headers: apiHeaders(), signal: controller.signal,
        body: JSON.stringify({
          session_id: session.id, user_name: session.name, action,
          latest_msg: history.latestUserMsg, turns: history.turns.slice(-12),
          user_messages: history.userMessages.slice(-6), bot_messages: history.botMessages.slice(-6),
          shared_cards: history.sharedCards.slice(-3), knowledge_scope: getKnowledgeScope()
        })
      });
      if (!response.ok) {
        let detail = {};
        try { detail = await response.json(); } catch (_) { /* non-JSON upstream error */ }
        const requestError = new Error(detail.error || `HTTP ${response.status}`);
        requestError.status = response.status;
        throw requestError;
      }
      const data = await response.json();
      const active = getActiveSession();
      const activeHistory = active ? parseConversationHistory(active) : null;
      if (serial !== requestSerial || !active || active.id !== session.id || activeHistory?.signature !== history.signature) {
        addLog('info', `会话已切换，丢弃 [${session.name}] 的过期结果`);
        return '';
      }
      let reply = cleanText(data.reply);
      // P1 fix: 检测兜底模板并尝试 LLM 低温重写
      const isFallbackTemplate = Boolean(data.is_fallback) || isLikelyTemplate(reply, history);
      if (reply && isFallbackTemplate && !controller.signal.aborted && serial === requestSerial) {
        addLog('info', '命中兜底模板，尝试 LLM 低温重写…');
        try {
          const retryBody = JSON.stringify({
            session_id: session.id, user_name: session.name, action: 'rewrite_fallback',
            latest_msg: history.latestUserMsg, turns: history.turns.slice(-12),
            user_messages: history.userMessages.slice(-6), bot_messages: history.botMessages.slice(-6),
            shared_cards: history.sharedCards.slice(-3), knowledge_scope: getKnowledgeScope(),
            fallback_text: reply, temperature: 0.3
          });
          const retryResponse = await fetch(getBridgeUrl() + '/reply', {
            method: 'POST', headers: apiHeaders(), signal: controller.signal, body: retryBody
          });
          if (retryResponse.ok) {
            const retryData = await retryResponse.json();
            const rewritten = cleanText(retryData.reply);
            if (rewritten && rewritten !== reply) { reply = rewritten; addLog('success', '兜底已重写为个性化回复'); }
          }
        } catch (_rewriteErr) { /* 重写失败时保留原始兜底 */ }
      }
      if (reply) {
        signatureFailureCounts.delete(history.signature);
        messageRetryUntil.delete(history.signature);
        recordMonitor({ lastLlmAt: Date.now(), lastLlmLatencyMs: Date.now() - requestStartedAt,
          llmSuccessCount: Number(state.monitor?.llmSuccessCount || 0) + 1, lastError: '' });
        const sourceCount = Array.isArray(data.knowledge_sources) ? data.knowledge_sources.length : 0;
        addLog('success', `已为 [${session.name}] 生成上下文专属回复${sourceCount ? ` · 命中${sourceCount}段业务资料` : ''}${data.memory_hits ? ` · ${data.memory_hits}条人工案例` : ''}`);
      }
      return reply;
    } catch (error) {
      if (!controller.signal.aborted && serial === requestSerial && error?.name !== 'AbortError') {
        const status = Number(error?.status || 0);
        const failures = Number(signatureFailureCounts.get(history.signature) || 0) + 1;
        signatureFailureCounts.set(history.signature, failures);
        const delay = Safety.retryDelayMs(status, failures);
        if (status === 401 || status === 403) await suspendForAuthFailure();
        else {
          messageRetryUntil.set(history.signature, Date.now() + delay);
          if (status === 429 || status >= 500 || status === 0) globalCircuitUntil = Date.now() + Math.min(delay, 5 * 60 * 1000);
        }
        console.warn('[XHS Reply] LLM request failed', error);
        recordMonitor({ lastLlmAt: Date.now(), lastLlmLatencyMs: Date.now() - requestStartedAt,
          llmFailureCount: Number(state.monitor?.llmFailureCount || 0) + 1, lastError: error.message || '请求失败' });
        if (status !== 401 && status !== 403) addLog('error', `大模型暂时不可用：${error.message || '请求失败'}；同一消息将在 ${Math.ceil(delay / 1000)} 秒后重试`);
      }
      return '';
    } finally {
      inFlightSignatures.delete(history.signature);
      if (serial === requestSerial) requestController = null;
    }
  }

  function isLikelyTemplate(reply, history) {
    if (!reply) return false;
    // 回复中原样引用了客户最后一句话（鹦鹉学舌）
    var userMsg = cleanText(history.latestUserMsg);
    if (userMsg.length > 6 && reply.includes(userMsg)) return true;
    // 高频固定开头模板
    var templateStarters = [
      '您好！感谢您的关注', '亲，感谢您的咨询', '您好，很高兴为您服务',
      '收到！感谢您的关注', '您好！欢迎咨询'
    ];
    if (templateStarters.some(function(t) { return reply.startsWith(t); })) return true;
    // 回复与上一条机器人回复高度相似（> 80% 重合）
    var lastBot = cleanText(history.latestAssistantTurn && history.latestAssistantTurn.content || '');
    if (lastBot && lastBot.length > 20) {
      var overlap = 0;
      for (var i = 0; i < reply.length && i < lastBot.length; i++) { if (reply[i] === lastBot[i]) overlap++; }
      if (overlap / Math.max(reply.length, lastBot.length) > 0.8) return true;
    }
    return false;
  }

  function releasePreviousPluginDraft(nextSessionId) {
    if (!currentDraftSessionId || currentDraftSessionId === nextSessionId) return;
    const textarea = getReplyTextarea();
    const cached = draftCache.get(currentDraftSessionId);
    if (textarea && cached && cleanText(textarea.value) === cleanText(cached.reply)) safeSetNativeValue(textarea, '');
    currentDraftSessionId = '';
  }

  function placeDraft(session, history, reply) {
    if (!reply || getActiveSession()?.id !== session.id) return false;
    const textarea = getReplyTextarea();
    if (!textarea) return false;
    const previousDraft = draftCache.get(session.id)?.reply || '';
    const currentValue = cleanText(textarea.value);
    if (currentValue && currentValue !== cleanText(previousDraft)) {
      addLog('info', `检测到人工输入，未覆盖 [${session.name}] 的现有草稿`);
      return false;
    }
    safeSetNativeValue(textarea, reply);
    draftCache.set(session.id, { signature: history.signature, reply });
    currentDraftSessionId = session.id;
    feedbackCandidate = {
      session: { id: session.id, name: session.name },
      history: JSON.parse(JSON.stringify(history)), aiReply: reply, humanReply: reply,
      knowledgeScope: getKnowledgeScope(), sent: false
    };
    feedbackCandidates.set(session.id, feedbackCandidate);
    showFeedbackCard(feedbackCandidate);
    return true;
  }

  function showFeedbackCard(candidate, sent = false) {
    const card = document.getElementById('xhsFeedbackCard');
    const hint = document.getElementById('xhsFeedbackHint');
    if (!card || state.runMode !== 'copilot' || !candidate) return;
    card.hidden = false;
    if (hint) hint.textContent = sent
      ? `已捕获发给「${candidate.session.name}」的人工版本，可评价后写入知识库。`
      : `可直接修改输入框中的话术，再把更好的版本反哺给机器人。`;
  }

  function hideFeedbackCard() {
    const card = document.getElementById('xhsFeedbackCard');
    if (card) card.hidden = true;
    const status = document.getElementById('xhsFeedbackStatus');
    if (status) status.textContent = '';
  }

  function captureFeedbackCandidate() {
    if (state.runMode !== 'copilot') return;
    const session = getActiveSession();
    const cached = session ? draftCache.get(session.id) : null;
    const humanReply = cleanText(getReplyTextarea()?.value);
    if (!session || !cached || !humanReply) return;
    const history = parseConversationHistory(session);
    feedbackCandidate = {
      session: { id: session.id, name: session.name },
      history: JSON.parse(JSON.stringify(history)), aiReply: cached.reply, humanReply,
      knowledgeScope: getKnowledgeScope(), sent: true
    };
    feedbackCandidates.set(session.id, feedbackCandidate);
    showFeedbackCard(feedbackCandidate, true);
  }

  async function saveHumanFeedback() {
    if (state.runMode !== 'copilot') return;
    const button = document.getElementById('xhsBtnSaveFeedback');
    const status = document.getElementById('xhsFeedbackStatus');
    const reasonInput = document.getElementById('xhsFeedbackReason');
    const currentText = cleanText(getReplyTextarea()?.value);
    if (feedbackCandidate && currentText && getActiveSession()?.id === feedbackCandidate.session.id) {
      feedbackCandidate.humanReply = currentText;
    }
    const candidate = feedbackCandidate;
    if (!candidate?.history?.latestUserMsg || !cleanText(candidate.humanReply)) {
      if (status) status.textContent = '没有可保存的人工话术，请先生成并修改草稿。';
      return;
    }
    if (button) button.disabled = true;
    if (status) status.textContent = cleanText(reasonInput?.value) ? '正在保存人工经验…' : '正在分析为什么这样回更好…';
    try {
      const response = await fetch(`${getBridgeUrl()}/feedback`, {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({
          session_id: candidate.session.id, user_name: candidate.session.name,
          latest_msg: candidate.history.latestUserMsg, turns: candidate.history.turns.slice(-12),
          ai_reply: candidate.aiReply, human_reply: candidate.humanReply,
          reason: cleanText(reasonInput?.value), auto_analyze: true,
          knowledge_scope: candidate.knowledgeScope || getKnowledgeScope()
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (status) status.textContent = `已记住 · 知识库 ${data.knowledge_count} 条${data.reason ? ` · ${data.reason}` : ''}`;
      if (reasonInput) reasonInput.value = '';
      candidate.saved = true;
      addLog('success', `已把 [${candidate.session.name}] 的人工优质话术写入知识库`);
    } catch (error) {
      if (status) status.textContent = `保存失败：${error.message || '本地 Agent 不可用'}`;
      addLog('error', `人工反馈保存失败：${error.message || '请求失败'}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function handleCopilotSession(force = false) {
    if (destroyed || !state.enabled || state.runMode !== 'copilot') return;
    const session = getActiveSession();
    if (!session?.stable) return;
    if (session.id !== currentSessionId) {
      releasePreviousPluginDraft(session.id);
      currentSessionId = session.id;
      updateSessionLabel(session);
    }
    const history = parseConversationHistory(session);
    if (!force && Number(messageRetryUntil.get(history.signature) || 0) > Date.now()) return;
    const cached = draftCache.get(session.id);
    if (!force && !history.needsReply) {
      updateRuntimeStatus('copilot', '等待客户新消息');
      return;
    }
    if (!force && cached?.signature === history.signature) {
      if (!cleanText(getReplyTextarea()?.value)) placeDraft(session, history, cached.reply);
      return;
    }
    const lead = extractLead(history.latestUserMsg);
    if (lead) syncLeadToRightPanel(lead);
    const action = force && !history.needsReply ? 'manual_followup' : 'reply';
    const reply = await fetchLLMReply(history, session, action);
    if (placeDraft(session, history, reply)) updateRuntimeStatus('copilot', '草稿已按当前会话生成');
  }

  function isWithinTimeScope() {
    if (state.timeScope !== 'night_only') return true;
    const hour = new Date().getHours();
    return hour >= 22 || hour < 9;
  }

  function isFullAutoArmed() {
    return state.enabled && state.runMode === 'full_auto' && state.operatorAway === true && Number(state.fullAutoArmedAt) > 0;
  }

  function pruneProcessedMap() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    state.processedMap = Object.fromEntries(Object.entries(state.processedMap || {}).filter(([, at]) => Number(at) >= cutoff));
  }

  function hasProcessedSignature(signature) {
    const at = Number(state.processedMap?.[signature] || 0);
    return at > 0 && Date.now() - at < Number(state.cooldownMinutes || 30) * 60 * 1000;
  }

  function underHourlyLimit() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    state.hourlySendTimestamps = (state.hourlySendTimestamps || []).filter(ts => Number(ts) >= cutoff);
    return state.hourlySendTimestamps.length < Number(state.maxRepliesPerHour || 12);
  }

  function isExternalActionStatusCheck(value) {
    const text = cleanText(value).replace(/[，。！!？?~～\s]+/g, '');
    if (!text || text.length > 28) return false;
    return /(?:加|添加|通过|申请|发送|发)(?:了|上|好|过)?(?:没|没有|了吗|了没|没啊|没有啊)|(?:好友申请|资料|链接|邀请码).{0,6}(?:收到没|收到了吗|发了吗|发了没)/.test(text);
  }

  function findPendingCards() {
    const seen = new Set();
    return Array.from(document.querySelectorAll('.sx-contact-item')).map(card => {
      // 页面同时保留隐藏的旧列表与当前可见列表。隐藏节点也会带未读/超时标记，
      // 若不先排除，会反复点击一个用户看不见、也无法切换成功的会话。
      if (!isVisible(card) || isVirtualGhost(card)) return null;
      const key = card.getAttribute('data-key') || cleanText(card.querySelector('.nick-name')?.innerText);
      if (!key || seen.has(key)) return null;
      seen.add(key);
      const cardText = cleanText(card.innerText);
      const name = cleanText(card.querySelector('.nick-name')?.innerText);
      if (Safety.isExcludedContact(name, cardText, state.contactBlacklist)) return null;
      const hasTimeout = cardText.includes('[超时未回复]');
      const hasUnreadDot = Boolean(card.querySelector('[class*="unread"], .red-dot, .d-badge-dot'));
      if (!hasTimeout && !hasUnreadDot) return null;
      if (Number(contactRetryUntil.get(key) || 0) > Date.now()) return null;
      return { card, id: card.getAttribute('data-key') || '', name };
    }).filter(Boolean);
  }

  function getVisibleContactScroller() {
    return Array.from(document.querySelectorAll('.vue-recycle-scroller'))
      .filter(scroller => isVisible(scroller) && scroller.querySelector('.sx-contact-item'))
      .find(scroller => scroller.scrollHeight > scroller.clientHeight + 8) || null;
  }

  function advanceVirtualContactWindow() {
    // 只扫描当前可见且真实可滚动的会话列表，避免命中页面保留的 0 高度旧列表。
    if (Date.now() - lastVirtualSweepAt < 800 || Date.now() - lastUserActivityAt < 60_000) return false;
    const scroller = getVisibleContactScroller();
    if (!scroller) return false;
    Array.from(scroller.querySelectorAll('.sx-contact-item')).forEach(card => {
      if (!isVisible(card) || isVirtualGhost(card)) return;
      const id = card.getAttribute('data-key') || cleanText(card.querySelector('.nick-name')?.innerText);
      if (id) scanSeenIds.add(id);
    });
    lastVirtualSweepAt = Date.now();
    const next = scroller.scrollTop + Math.max(240, Math.floor(scroller.clientHeight * 0.9));
    const atBottom = next >= scroller.scrollHeight - scroller.clientHeight - 8;
    scroller.scrollTop = atBottom ? 0 : next;
    if (atBottom) {
      recordMonitor({ scanSeenCount: scanSeenIds.size, lastFullScanAt: Date.now(), lastScanDurationMs: Date.now() - scanPassStartedAt });
      addLog('info', `完整巡检结束：覆盖 ${scanSeenIds.size} 个会话`);
      scanSeenIds.clear();
      scanPassStartedAt = Date.now();
    }
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  }

  async function waitForSession(targetId, timeoutMs = 1800) {
    const started = Date.now();
    let consecutive = 0;
    while (Date.now() - started < timeoutMs) {
      const session = getActiveSession();
      consecutive = session?.id === targetId && session.stable ? consecutive + 1 : 0;
      if (consecutive >= 2) return session;
      await sleep(90);
    }
    return null;
  }

  async function humanTypeAndSend(session, history, reply, operationStartedAt) {
    const textarea = getReplyTextarea();
    if (!textarea) return { clicked: false, confirmed: false };
    safeSetNativeValue(textarea, '');
    let typed = '';
    await sleep(450 + Math.floor(Math.random() * 650));
    for (const char of Array.from(reply)) {
      if (!isFullAutoArmed() || lastUserActivityAt > operationStartedAt || getActiveSession()?.id !== session.id) return { clicked: false, confirmed: false };
      typed += char;
      safeSetNativeValue(textarea, typed);
      await sleep(20 + Math.floor(Math.random() * 26));
    }
    const finalSession = getActiveSession();
    const finalHistory = finalSession ? parseConversationHistory(finalSession) : null;
    if (!finalSession || finalSession.id !== session.id || finalHistory?.signature !== history.signature || lastUserActivityAt > operationStartedAt) return { clicked: false, confirmed: false };
    const sendButton = Array.from(document.querySelectorAll('button')).find(btn => isVisible(btn) && cleanText(btn.innerText) === '发送');
    if (!sendButton || sendButton.disabled) return { clicked: false, confirmed: false };
    sendButton.click();
    const confirmed = await waitForSentMessage(session.id, reply, 6500);
    return { clicked: true, confirmed };
  }

  async function waitForSentMessage(sessionId, reply, timeoutMs = 6500) {
    const expected = cleanText(reply);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (getActiveSession()?.id !== sessionId) return false;
      const history = parseConversationHistory(getActiveSession());
      if (history.turns.some(turn => turn.role === 'assistant' && cleanText(turn.content) === expected)) return true;
      await sleep(140);
    }
    return false;
  }

  async function restoreSession(originalId, operationStartedAt) {
    if (!originalId || lastUserActivityAt > operationStartedAt) return;
    const card = Array.from(document.querySelectorAll('.sx-contact-item')).find(item => item.getAttribute('data-key') === originalId);
    if (card && getActiveSession()?.id !== originalId) card.click();
  }

  async function runFullAutoCycle() {
    if (destroyed || autoProcessing || !isFullAutoArmed() || !isWithinTimeScope()) return;
    if (document.hasFocus() && Date.now() - lastUserActivityAt < 60_000) {
      updateRuntimeStatus('full_auto', '人工操作中，暂缓切换');
      return;
    }
    if (!underHourlyLimit()) {
      updateRuntimeStatus('full_auto', '已达每小时安全上限');
      return;
    }
    const pending = findPendingCards()[0];
    if (!pending) {
      const sweeping = advanceVirtualContactWindow();
      updateRuntimeStatus('full_auto', sweeping ? '巡检未渲染会话中' : '监听新进线中');
      return;
    }
    autoProcessing = true;
    const operationStartedAt = Date.now();
    const originalSessionId = getActiveSession()?.id || '';
    const targetId = pending.id;
    try {
      if (!targetId) return;
      if (getActiveSession()?.id !== targetId) pending.card.click();
      const session = await waitForSession(targetId);
      if (!session) {
        contactRetryUntil.set(targetId, Date.now() + 60_000);
        return;
      }
      const history = parseConversationHistory(session);
      if (!history.needsReply || !history.latestUserMsg) {
        // 例如仅有“温馨提示”的空会话，短暂跳过并继续扫描下一位。
        messageRetryUntil.set(history.signature, Date.now() + 60_000);
        return;
      }
      const retryAt = Math.max(Number(messageRetryUntil.get(history.signature) || 0), Number(state.uncertainSendMap?.[history.signature] || 0));
      if (retryAt > Date.now()) return;
      if (hasProcessedSignature(history.signature)) {
        messageRetryUntil.set(history.signature, Date.now() + Number(state.cooldownMinutes || 30) * 60_000);
        return;
      }
      const age = Safety.messageAgeDecision(history.latestUserTurn?.timestamp, Date.now(), Number(state.autoReplyMaxAgeMinutes || 120) * 60_000);
      if (age.action !== 'auto') {
        messageRetryUntil.set(history.signature, Date.now() + (age.action === 'skip' ? 24 * 60 * 60_000 : 60 * 60_000));
        addLog('info', `已将 [${session.name}] 交给人工：${age.reason}`);
        return;
      }
      if (isExternalActionStatusCheck(history.latestUserMsg)) {
        // “加了没/发了吗”依赖外部动作状态，页面会话本身无法证明结果。
        // 全自动宁可交给人工，也不能假装已完成或把话题岔到产品介绍。
        messageRetryUntil.set(history.signature, Date.now() + 30 * 60_000);
        addLog('info', `已将 [${session.name}] 的外部状态确认交给人工处理`);
        return;
      }
      const lead = extractLead(history.latestUserMsg);
      if (lead) syncLeadToRightPanel(lead);
      const reply = await fetchLLMReply(history, session, 'auto_reply');
      if (!reply) {
        if (!messageRetryUntil.has(history.signature)) messageRetryUntil.set(history.signature, Date.now() + 60_000);
        return;
      }
      const sendResult = await humanTypeAndSend(session, history, reply, operationStartedAt);
      if (!sendResult.confirmed) {
        if (sendResult.clicked) {
          state.uncertainSendMap[history.signature] = Date.now() + 24 * 60 * 60 * 1000;
          await storageSet({ uncertainSendMap: state.uncertainSendMap });
          recordMonitor({ readbackFailureCount: Number(state.monitor?.readbackFailureCount || 0) + 1,
            lastError: `${session.name} 发送结果未回读` });
          addLog('error', `已点击发送但未回读到消息，已暂停该会话自动重试：${session.name}`);
        } else {
          recordMonitor({ sendFailureCount: Number(state.monitor?.sendFailureCount || 0) + 1,
            lastError: `${session.name} 发送前校验未通过` });
          addLog('error', `发送前校验未通过，已停止 [${session.name}] 自动回复`);
        }
        return;
      }
      state.processedMap[history.signature] = Date.now();
      messageRetryUntil.set(history.signature, Date.now() + Number(state.cooldownMinutes || 30) * 60_000);
      state.hourlySendTimestamps.push(Date.now());
      await ensureDailyStats();
      state.repliedCount += 1;
      recordMonitor({ sendSuccessCount: Number(state.monitor?.sendSuccessCount || 0) + 1, lastError: '' });
      pruneProcessedMap();
      await storageSet({ processedMap: state.processedMap, hourlySendTimestamps: state.hourlySendTimestamps, repliedCount: state.repliedCount, statsDate: state.statsDate });
      addLog('success', `已自动回复 [${session.name}]；会话签名已锁定防重复`);
    } finally {
      await restoreSession(originalSessionId, operationStartedAt);
      autoProcessing = false;
      advanceVirtualContactWindow();
    }
  }

  function updateSessionLabel(session) {
    const label = document.getElementById('xhsActiveCustomerName');
    if (label) label.textContent = session ? `当前客户：${session.name}` : '当前客户：识别中';
  }

  function updateRuntimeStatus(mode, detail) {
    const text = document.getElementById('xhsPillModeText');
    const pulse = document.getElementById('xhsPulseDot');
    if (text) text.textContent = !state.enabled ? '已暂停' : mode === 'full_auto' ? `全自动 · ${detail}` : `副驾 · ${detail}`;
    pulse?.classList.toggle('paused', !state.enabled);
  }

  function syncMonitorUI() {
    const box = document.getElementById('xhsMonitorSummary');
    if (!box) return;
    const monitor = state.monitor || {};
    const last = monitor.lastLlmAt ? new Date(monitor.lastLlmAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未调用';
    const latency = monitor.lastLlmLatencyMs ? `${monitor.lastLlmLatencyMs}ms` : '-';
    const scan = monitor.lastFullScanAt ? ` · 巡检 ${monitor.scanSeenCount || 0} 个 @ ${new Date(monitor.lastFullScanAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ' · 巡检尚未完成';
    box.textContent = `LLM：${last} · 最近 ${latency} · 成功 ${monitor.llmSuccessCount || 0} · 失败 ${monitor.llmFailureCount || 0} · 回读失败 ${monitor.readbackFailureCount || 0}${scan}`;
    box.title = monitor.lastError ? `最近异常：${monitor.lastError}` : '当前没有记录异常';
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadKnowledgeFiles(files) {
    const status = document.getElementById('xhsKnowledgeIngestStatus');
    for (const file of Array.from(files || [])) {
      if (file.size > 10 * 1024 * 1024) { if (status) status.textContent = `${file.name} 超过 10MB`; continue; }
      try {
        if (status) status.textContent = `正在解析并索引 ${file.name}…`;
        const response = await fetch(`${getBridgeUrl()}/knowledge/upload`, {
          method: 'POST', headers: apiHeaders(),
          body: JSON.stringify({ filename: file.name, content_base64: await readFileBase64(file) })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (status) status.textContent = `${file.name} 已入库 · ${data.document.chunk_count} 个知识片段`;
      } catch (error) {
        if (status) status.textContent = `${file.name} 导入失败：${error.message || '解析失败'}`;
      }
    }
    loadKnowledgeDocuments();
  }

  async function importFeishuKnowledge() {
    const input = document.getElementById('xhsFeishuUrl');
    const status = document.getElementById('xhsKnowledgeIngestStatus');
    const url = cleanText(input?.value);
    if (!url) { if (status) status.textContent = '请粘贴飞书文档或知识库链接'; return; }
    try {
      if (status) status.textContent = '正在读取飞书文档并建立索引…';
      const response = await fetch(`${getBridgeUrl()}/knowledge/feishu`, {
        method: 'POST', headers: feishuHeaders(), body: JSON.stringify({ url })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (input) input.value = '';
      if (status) status.textContent = `飞书文档已入库 · ${data.document.chunk_count} 个知识片段`;
      loadKnowledgeDocuments();
    } catch (error) {
      if (status) status.textContent = `飞书导入失败：${error.message || '请检查应用授权'}`;
    }
  }

  async function setKnowledgeDocumentEnabled(id, enabled) {
    // P2 fix: 软停用确认，不做永久删除
    if (!enabled && !window.confirm('停用这份业务资料？资料会保留，可随时恢复。')) return;
    const response = await fetch(`${getBridgeUrl()}/knowledge/status`, {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({ id, enabled, soft: true })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    loadKnowledgeDocuments();
  }

  async function loadKnowledgeDocuments() {
    const list = document.getElementById('xhsDocumentList');
    if (!list) return;
    list.textContent = '正在读取业务资料…';
    try {
      const response = await fetch(`${getBridgeUrl()}/knowledge/documents`, { headers: apiHeaders() });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      list.replaceChildren();
      if (!data.items.length) { list.textContent = '还没有业务资料，可拖入 PDF、Word、PPT、TXT 或 Markdown。'; return; }
      data.items.forEach(item => {
        const row = document.createElement('div'); row.className = 'xhs-knowledge-item';
        const title = document.createElement('div'); title.className = 'xhs-knowledge-question'; title.textContent = `${item.title} · v${item.version}`;
        const meta = document.createElement('div'); meta.className = 'xhs-knowledge-meta'; meta.textContent = `${item.source_type.toUpperCase()} · ${item.chunk_count} 段 · ${item.status === 'ready' ? '向量+关键词' : '仅关键词'}`;
        const detail = document.createElement('div'); detail.className = 'xhs-knowledge-why'; detail.textContent = item.status_detail || '';
        const button = document.createElement('button'); button.className = 'xhs-btn xhs-btn-secondary'; button.textContent = item.enabled ? '停用' : '恢复';
        button.addEventListener('click', () => setKnowledgeDocumentEnabled(item.id, !item.enabled).catch(error => { detail.textContent = error.message; }));
        row.append(title, meta, detail, button); list.append(row);
      });
    } catch (error) {
      list.textContent = `业务资料读取失败：${error.message || '服务不可用'}`;
    }
  }

  async function loadKnowledge() {
    const list = document.getElementById('xhsKnowledgeList');
    const count = document.getElementById('xhsKnowledgeCount');
    loadKnowledgeDocuments();
    if (!list) return;
    list.textContent = '正在读取当前知识空间…';
    try {
      const scope = encodeURIComponent(getKnowledgeScope());
      const response = await fetch(`${getBridgeUrl()}/feedback/list?scope=${scope}&limit=30`, { headers: apiHeaders() });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (count) count.textContent = `${data.items.length} 条案例 · ${data.scope}`;
      list.replaceChildren();
      if (!data.items.length) {
        list.textContent = '还没有人工优质案例。生成一条草稿并保存后，会出现在这里。';
        return;
      }
      data.items.forEach(item => {
        const row = document.createElement('div');
        row.className = 'xhs-knowledge-item';
        const meta = document.createElement('div'); meta.className = 'xhs-knowledge-meta';
        meta.textContent = `${item.created_at || ''} · 调用 ${item.usage_count || 0} 次`;
        const question = document.createElement('div'); question.className = 'xhs-knowledge-question';
        question.textContent = `客户：${item.latest_msg}`;
        const answer = document.createElement('div'); answer.className = 'xhs-knowledge-answer';
        answer.textContent = `采用：${item.human_reply}`;
        const why = document.createElement('div'); why.className = 'xhs-knowledge-why';
        why.textContent = `原因：${item.reason || '未填写'}`;
        const actions = document.createElement('div'); actions.className = 'xhs-knowledge-actions';
        const remove = document.createElement('button'); remove.className = 'xhs-btn xhs-btn-secondary';
        remove.textContent = item.enabled ? '停用案例' : '恢复案例';
        remove.addEventListener('click', () => setKnowledgeEnabled(item.id, !item.enabled));
        actions.append(remove); row.append(meta, question, answer, why, actions); list.append(row);
      });
    } catch (error) {
      list.textContent = `知识库读取失败：${error.message || 'Agent 不可用'}`;
    }
  }

  async function setKnowledgeEnabled(id, enabled) {
    if (!enabled && !window.confirm('停用这条人工案例？它会保留，可随时恢复。')) return;
    try {
      const response = await fetch(`${getBridgeUrl()}/feedback/status`, {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({ id, enabled, knowledge_scope: getKnowledgeScope() })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      addLog('success', `已${enabled ? '恢复' : '停用'}人工案例 #${id}`);
      loadKnowledge();
    } catch (error) {
      addLog('error', `案例状态修改失败：${error.message || '请求失败'}`);
    }
  }

  function addLog(type, text) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    state.logs.unshift({ type, text: cleanText(text), time });
    state.logs = state.logs.slice(0, 40);
    const box = document.getElementById('xhsLogContainer');
    if (!box) return;
    box.replaceChildren(...state.logs.map(log => {
      const row = document.createElement('div'); row.className = `xhs-log-item ${log.type}`;
      const clock = document.createElement('div'); clock.className = 'xhs-log-time'; clock.textContent = log.time;
      const message = document.createElement('div'); message.className = 'xhs-log-text'; message.textContent = log.text;
      row.append(clock, message); return row;
    }));
  }

  async function saveConfig(patch, { arm = false } = {}) {
    state = { ...state, ...patch };
    if (state.runMode !== 'full_auto' || !state.enabled || !arm) {
      state.fullAutoArmedAt = 0;
      state.operatorAway = false;
    } else {
      state.fullAutoArmedAt = Date.now();
      state.operatorAway = true;
    }
    await storageSet({ enabled: state.enabled, runMode: state.runMode, timeScope: state.timeScope, fullAutoArmedAt: state.fullAutoArmedAt, operatorAway: state.operatorAway });
    if (!isFullAutoArmed()) autoProcessing = false;
    abortPendingRequest('config_changed');
    syncDockFromState();
    if (state.enabled && state.runMode === 'copilot') scheduleSense(80);
  }

  function syncDockFromState() {
    const master = document.getElementById('xhsDockMasterToggle');
    const mode = document.getElementById('xhsDockRunMode');
    const time = document.getElementById('xhsDockTimeScope');
    if (master) master.checked = Boolean(state.enabled);
    if (mode) mode.value = state.runMode;
    if (time) time.value = state.timeScope;
    const armed = isFullAutoArmed();
    const hint = document.getElementById('xhsAutoArmHint');
    if (hint) hint.textContent = state.runMode === 'full_auto'
      ? (armed ? '已武装：无人操作时自动回复' : '未武装：请点击“开始无人值守”')
      : '副驾只预填草稿，不会自动发送';
    const awayButton = document.getElementById('xhsBeginAwayMode');
    if (awayButton) {
      awayButton.hidden = state.runMode !== 'full_auto';
      awayButton.textContent = armed ? '结束无人值守' : '开始无人值守';
    }
    const button = document.getElementById('xhsBtnGenNow');
    if (button) button.textContent = state.runMode === 'full_auto' ? '立即扫描待回复会话' : '为当前会话生成专属草稿';
    updateRuntimeStatus(state.runMode, state.runMode === 'full_auto' ? (armed ? '监听新进线中' : '等待武装') : '等待客户新消息');
    syncMonitorUI();
  }

  function renderFloatingDock() {
    const root = document.createElement('div');
    root.id = 'xhs-reply-dock-root';
    root.innerHTML = `
      <div class="xhs-dock-pill" id="xhsPillTrigger" title="点击展开私信智能控制台">
        <div class="xhs-dock-status-dot" id="xhsPulseDot"></div><span style="font-weight:700;font-size:12px;">私信顾问</span>
        <span style="font-size:11px;color:#cbd5e1;" id="xhsPillModeText">加载中</span>
      </div>
      <div class="xhs-dock-panel" id="xhsExpandedPanel">
        <div class="xhs-dock-header"><div class="xhs-dock-title">私信智能控制台 <span class="badge">V1.0</span></div>
          <button class="xhs-dock-btn-icon" id="xhsClosePanelBtn" aria-label="关闭">✕</button></div>
        <div class="xhs-dock-tabs"><div class="xhs-dock-tab active" data-tab="quick">快捷操作</div><div class="xhs-dock-tab" data-tab="settings">开关与设置</div><div class="xhs-dock-tab" data-tab="knowledge">案例库</div></div>
        <div class="xhs-dock-body" id="xhsTabQuick">
          <button class="xhs-btn xhs-btn-primary" style="width:100%;padding:9px;" id="xhsBtnGenNow">生成专属草稿</button>
          <div style="font-size:11px;color:#64748b;margin:8px 0;" id="xhsAutoArmHint"></div>
          <div class="xhs-feedback-card" id="xhsFeedbackCard" hidden>
            <div class="xhs-feedback-title"><span>人工校准</span><span class="xhs-feedback-kb">持续学习</span></div>
            <div class="xhs-feedback-hint" id="xhsFeedbackHint">修改输入框中的话术后，将更好的版本反哺给机器人。</div>
            <textarea class="xhs-textarea" id="xhsFeedbackReason" placeholder="为什么这样回更好？可不填，AI 会自动分析"></textarea>
            <button class="xhs-btn xhs-btn-secondary" style="width:100%;" id="xhsBtnSaveFeedback">记住当前人工话术</button>
            <div class="xhs-feedback-status" id="xhsFeedbackStatus"></div>
          </div>
          <div style="font-size:11px;font-weight:600;color:#64748b;margin:10px 0 6px;display:flex;justify-content:space-between;gap:8px;">
            <span>执行轨迹</span><span id="xhsActiveCustomerName" style="color:#ff2442;text-align:right;">当前客户：识别中</span></div>
          <div class="xhs-log-list" id="xhsLogContainer"><div style="color:#94a3b8;font-size:11px;text-align:center;padding:10px;">等待会话变化</div></div>
        </div>
        <div class="xhs-dock-body" id="xhsTabSettings" style="display:none;">
          <div class="xhs-status-card"><div><div style="font-weight:600;">总开关</div><div style="font-size:11px;color:#64748b;">关闭后不读取也不生成</div></div>
            <label class="xhs-toggle-switch"><input type="checkbox" id="xhsDockMasterToggle"><span class="xhs-toggle-slider"></span></label></div>
          <div class="xhs-field-group"><label class="xhs-field-label">工作模式</label><select class="xhs-input-text" id="xhsDockRunMode">
            <option value="copilot">半自动副驾（只预填）</option><option value="full_auto">全自动秒回（自动发送）</option></select></div>
          <div class="xhs-field-group"><label class="xhs-field-label">生效时段</label><select class="xhs-input-text" id="xhsDockTimeScope">
            <option value="all_day">全天运行</option><option value="night_only">仅夜间 22:00–09:00</option></select></div>
          <button class="xhs-btn xhs-btn-primary" style="width:100%;margin-bottom:10px;" id="xhsBeginAwayMode" hidden>开始无人值守</button>
          <div class="xhs-field-group"><label class="xhs-field-label">运行监控</label><div class="xhs-monitor-summary" id="xhsMonitorSummary">等待数据</div></div>
          <div style="font-size:11px;color:#64748b;line-height:1.6;">全自动会在人工操作页面时暂停；同一条客户消息 30 分钟内不会重复发送，每小时最多 ${state.maxRepliesPerHour} 条。</div>
        </div>
        <div class="xhs-dock-body" id="xhsTabKnowledge" style="display:none;">
          <label class="xhs-knowledge-drop" id="xhsKnowledgeDrop">拖入或选择 PDF / Word / PPT / TXT / Markdown<input id="xhsKnowledgeFiles" type="file" accept=".pdf,.docx,.pptx,.txt,.md,.csv" multiple hidden></label>
          <div class="xhs-feishu-row"><input class="xhs-input-text" id="xhsFeishuUrl" placeholder="粘贴飞书文档 / 知识库链接"><button class="xhs-btn xhs-btn-secondary" id="xhsBtnImportFeishu">导入</button></div>
          <div class="xhs-knowledge-ingest-status" id="xhsKnowledgeIngestStatus">资料会自动解析、分段并建立检索索引</div>
          <div class="xhs-knowledge-toolbar"><span>业务资料</span><button class="xhs-btn xhs-btn-secondary" id="xhsBtnRefreshKnowledge">刷新</button></div>
          <div class="xhs-knowledge-list" id="xhsDocumentList">点击“刷新”读取业务资料</div>
          <div class="xhs-knowledge-toolbar"><span id="xhsKnowledgeCount">人工优秀案例</span></div>
          <div class="xhs-knowledge-list" id="xhsKnowledgeList">点击“刷新”读取人工案例</div>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('#xhsPillTrigger').addEventListener('click', () => root.querySelector('#xhsExpandedPanel').classList.toggle('active'));
    root.querySelector('#xhsClosePanelBtn').addEventListener('click', () => root.querySelector('#xhsExpandedPanel').classList.remove('active'));
    root.querySelectorAll('.xhs-dock-tab').forEach(tab => tab.addEventListener('click', () => {
      root.querySelectorAll('.xhs-dock-tab').forEach(item => item.classList.toggle('active', item === tab));
      root.querySelector('#xhsTabQuick').style.display = tab.dataset.tab === 'quick' ? '' : 'none';
      root.querySelector('#xhsTabSettings').style.display = tab.dataset.tab === 'settings' ? '' : 'none';
      root.querySelector('#xhsTabKnowledge').style.display = tab.dataset.tab === 'knowledge' ? '' : 'none';
      if (tab.dataset.tab === 'knowledge') loadKnowledge();
    }));
    root.querySelector('#xhsDockMasterToggle').addEventListener('change', e => saveConfig({ enabled: e.target.checked }));
    root.querySelector('#xhsDockRunMode').addEventListener('change', e => {
      saveConfig({ runMode: e.target.value });
      addLog('info', `模式已切换为：${e.target.value === 'full_auto' ? '全自动秒回' : '半自动副驾'}`);
    });
    root.querySelector('#xhsDockTimeScope').addEventListener('change', e => saveConfig({ timeScope: e.target.value }));
    root.querySelector('#xhsBeginAwayMode').addEventListener('click', () => {
      const ending = isFullAutoArmed();
      saveConfig({}, { arm: !ending });
      addLog('info', ending ? '已结束无人值守，恢复人工占用' : '已开始无人值守；任何人工操作都会立即退出');
    });
    root.querySelector('#xhsBtnRefreshKnowledge').addEventListener('click', loadKnowledge);
    root.querySelector('#xhsKnowledgeFiles').addEventListener('change', e => uploadKnowledgeFiles(e.target.files));
    root.querySelector('#xhsBtnImportFeishu').addEventListener('click', importFeishuKnowledge);
    const drop = root.querySelector('#xhsKnowledgeDrop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragging'); uploadKnowledgeFiles(e.dataTransfer.files); });
    root.querySelector('#xhsBtnGenNow').addEventListener('click', () => state.runMode === 'full_auto' ? runFullAutoCycle() : handleCopilotSession(true));
    root.querySelector('#xhsBtnSaveFeedback').addEventListener('click', saveHumanFeedback);
  }

  function scheduleSense(delay = 120) {
    clearTimeout(senseDebounce);
    senseDebounce = setTimeout(() => handleCopilotSession(false), delay);
  }

  function onDocumentClick(event) {
    if (!event.isTrusted) return;
    lastUserActivityAt = Date.now();
    const clickedButton = event.target.closest?.('button');
    if (clickedButton && cleanText(clickedButton.innerText) === '发送') captureFeedbackCandidate();
    const card = event.target.closest?.('.sx-contact-item');
    if (!card) return;
    const nextId = card.getAttribute('data-key') || `name:${cleanText(card.querySelector('.nick-name')?.innerText)}`;
    if (feedbackCandidate && feedbackCandidate.session.id !== nextId && !feedbackCandidate.sent) {
      feedbackCandidates.delete(feedbackCandidate.session.id);
    }
    feedbackCandidate = feedbackCandidates.get(nextId) || null;
    if (feedbackCandidate) showFeedbackCard(feedbackCandidate, Boolean(feedbackCandidate.sent));
    else hideFeedbackCard();
    releasePreviousPluginDraft(nextId);
    abortPendingRequest('user_switched_session');
    currentSessionId = nextId;
    updateSessionLabel({ name: cleanText(card.querySelector('.nick-name')?.innerText) || '识别中' });
    [90, 260, 620, 1100].forEach(delay => setTimeout(() => scheduleSense(0), delay));
  }

  function onUserActivity(event) {
    if (!event.isTrusted) return;
    lastUserActivityAt = Date.now();
    if (state.operatorAway) {
      state.operatorAway = false;
      state.fullAutoArmedAt = 0;
      storageSet({ operatorAway: false, fullAutoArmedAt: 0 });
      syncDockFromState();
      addLog('info', '检测到人工操作，已退出无人值守');
    }
    if (event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && event.target === getReplyTextarea()) {
      captureFeedbackCandidate();
    }
  }

  async function initialize() {
    const saved = await storageGet(Object.keys(DEFAULTS));
    state = { ...state, ...Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== undefined)) };
    if (!state.onboardingComplete) {
      state.enabled = false;
      state.runMode = 'copilot';
      state.fullAutoArmedAt = 0;
      state.operatorAway = false;
      await storageSet({ enabled: false, runMode: 'copilot', fullAutoArmedAt: 0, operatorAway: false });
    }
    state.processedMap ||= {};
    state.hourlySendTimestamps ||= [];
    state.uncertainSendMap ||= {};
    state.monitor = { ...DEFAULTS.monitor, ...(state.monitor || {}) };
    await ensureDailyStats();
    pruneProcessedMap();
    renderFloatingDock();
    syncDockFromState();
    updateSessionLabel(getActiveSession());
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('pointerdown', onUserActivity, true);
    document.addEventListener('wheel', onUserActivity, true);
    document.addEventListener('keydown', onUserActivity, true);
    observer = new MutationObserver(mutations => {
      if (mutations.some(m => !m.target.closest?.('#xhs-reply-dock-root'))) scheduleSense(160);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-key'] });
    senseTimer = setInterval(() => scheduleSense(0), 1100);
    autoTimer = setInterval(runFullAutoCycle, 900);
    scheduleSense(250);
    addLog('success', `V${VERSION} 已加载：会话隔离、双模式调度与人工反馈学习已启用`);
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'CONFIG_UPDATED') return;
    state = { ...state, ...(message.config || {}) };
    if (message.config?.workspaceToken) globalCircuitUntil = 0;
    if (!state.enabled || state.runMode !== 'full_auto') { state.fullAutoArmedAt = 0; state.operatorAway = false; }
    syncDockFromState();
    abortPendingRequest('popup_config_changed');
    if (state.enabled && state.runMode === 'copilot') scheduleSense(80);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    ['enabled', 'onboardingComplete', 'runMode', 'timeScope', 'fullAutoArmedAt', 'operatorAway', 'repliedCount', 'leadsCount', 'statsDate', 'bridgeUrl', 'workspaceToken', 'accountId', 'knowledgeScope', 'modelBaseUrl', 'modelName', 'modelApiKey', 'embeddingBaseUrl', 'embeddingModel', 'embeddingApiKey', 'feishuAppId', 'feishuAppSecret', 'monitor', 'uncertainSendMap', 'autoReplyMaxAgeMinutes', 'contactBlacklist'].forEach(key => {
      if (changes[key]) state[key] = changes[key].newValue;
    });
    if (changes.workspaceToken?.newValue) globalCircuitUntil = 0;
    syncDockFromState();
  });

  const publicApi = {
    version: VERSION,
    inspect() {
      const session = getActiveSession();
      return { state: { ...state, logs: undefined }, session: session ? { id: session.id, uid: session.uid, name: session.name, stable: session.stable } : null, history: session ? parseConversationHistory(session) : null };
    },
    destroy() {
      destroyed = true;
      clearInterval(senseTimer); clearInterval(autoTimer); clearTimeout(senseDebounce); observer?.disconnect();
      abortPendingRequest('destroyed');
      document.removeEventListener('click', onDocumentClick, true);
      document.removeEventListener('pointerdown', onUserActivity, true);
      document.removeEventListener('wheel', onUserActivity, true);
      document.removeEventListener('keydown', onUserActivity, true);
      document.getElementById('xhs-reply-dock-root')?.remove();
    }
  };
  window.__XHS_REPLY_V11__ = publicApi;
  // 保留旧调试入口，避免已有 QA 脚本因升级失效。
  window.__XHS_REPLY_V10__ = publicApi;

  initialize().catch(error => console.error('[XHS Reply] initialization failed', error));
})();
