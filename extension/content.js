/**
 * 小红书专业号私信智能顾问 V1.1
 * 会话以 data-key（UID）隔离；副驾只预填；全自动发送前会再次核验会话与消息签名。
 */
(function () {
  'use strict';
  if (window.top !== window) return;

  const VERSION = '1.1.0';
  const Safety = globalThis.XhsSafety;
  const DEFAULTS = {
    enabled: true, onboardingComplete: true, runMode: 'copilot', timeScope: 'all_day', fullAutoArmedAt: 0, operatorAway: false,
    cooldownMinutes: 30, maxRepliesPerHour: 12, autoReplyMaxAgeMinutes: 120,
    repliedCount: 0, leadsCount: 0, statsDate: '', contactBlacklist: [],
    processedMap: {}, hourlySendTimestamps: [], uncertainSendMap: {}, followupStateMap: {},
    bridgeUrl: 'http://127.0.0.1:18195', workspaceToken: '', accountId: '', operatorNickname: '',
    knowledgeScope: 'default',
    dailyTokenBudget: 200_000,
    dailyCallBudget: 300,
    todayTokens: 0,
    todayCalls: 0,
    tokenDate: '',
    circuitTripped: false,
    modelBaseUrl: 'http://127.0.0.1:10100/v1/chat/completions',
    modelName: 'google-antigravity/gemini-3.7-flash',
    configVersion: 0,
    modelApiKey: '', embeddingBaseUrl: '', embeddingModel: '', embeddingApiKey: '',
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
  let lastComplianceFlags = [];
  let lastSendCardDirective = null;
  let leadSyncRunning = false;

  const draftCache = new Map();
  const manualDraftCache = new Map();
  const userClearedSignatures = new Map();
  const copilotAttemptedSignatures = new Set();
  const inFlightSignatures = new Set();
  const messageRetryUntil = new Map();
  const contactRetryUntil = new Map();
  const leadRetryUntil = new Map();
  const signatureFailureCounts = new Map();
  const capturedLeadKeys = new Set();
  const sessionLastFetchTime = new Map();
  const SESSION_FETCH_COOLDOWN_MS = 45_000;
  const scanSeenIds = new Set();
  let globalCircuitUntil = 0;
  let scanPassStartedAt = Date.now();
  const PERSISTENT_DRAFT_KEY = 'persistentDraftCache';
  const PERSISTENT_DRAFT_MAX = 100;
  const PERSISTENT_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
  let persistentDraftStore = {};
  const visitedHistorySamples = new Map();
  const HISTORY_SAMPLES_MAX_SESSIONS = 12;
  const HISTORY_SAMPLES_MAX_TURNS = 30;
  const HISTORY_SAMPLES_MAX_CHARS = 30000;
  const storageGet = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
  const storageSet = values => new Promise(resolve => chrome.storage.local.set(values, resolve));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();

  async function bridgeFetch(url, options = {}) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (directErr) {
      // 当从 HTTPS 页面直接 fetch HTTP 127.0.0.1 触发混合内容拦截时，无缝通过 background service worker 转发
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'BRIDGE_FETCH',
          url,
          options: {
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body || undefined
          }
        }, res => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message || directErr.message));
          }
          if (!res) return reject(directErr);
          const pseudoResponse = {
            ok: Boolean(res.ok),
            status: Number(res.status || 0),
            statusText: String(res.statusText || ''),
            json: async () => (res.data !== null ? res.data : JSON.parse(res.text || '{}')),
            text: async () => String(res.text || '')
          };
          resolve(pseudoResponse);
        });
      });
    }
  }

  function stableScopeHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getTenantCacheScope() {
    const workspaceIdentity = state.workspaceToken || `${state.accountId}:${state.knowledgeScope}`;
    return `${getKnowledgeScope()}:tenant:${stableScopeHash(workspaceIdentity)}`;
  }

  function makePersistentDraftKey(tenantScope, sessionId, signature, action, configVersion) {
    return [tenantScope, sessionId, signature, action, String(configVersion || 0)].join('||');
  }

  async function loadPersistentDraftCache() {
    const saved = await storageGet([PERSISTENT_DRAFT_KEY]);
    persistentDraftStore = saved[PERSISTENT_DRAFT_KEY] || {};
    const now = Date.now();
    const valid = Object.entries(persistentDraftStore)
      .filter(([, entry]) => entry && now - Number(entry.updatedAt || 0) <= PERSISTENT_DRAFT_TTL)
      .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))
      .slice(0, PERSISTENT_DRAFT_MAX);
    const next = Object.fromEntries(valid);
    if (Object.keys(next).length !== Object.keys(persistentDraftStore).length) {
      persistentDraftStore = next;
      await storageSet({ [PERSISTENT_DRAFT_KEY]: persistentDraftStore });
    }
  }

  async function savePersistentDraft(session, history, action, reply) {
    const tenantScope = getTenantCacheScope();
    const configVersion = state.configVersion || 0;
    const key = makePersistentDraftKey(tenantScope, session.id, history.signature, action, configVersion);
    persistentDraftStore[key] = {
      tenantScope, sessionId: session.id, signature: history.signature,
      action, configVersion, reply, updatedAt: Date.now()
    };
    persistentDraftStore = Object.fromEntries(
      Object.entries(persistentDraftStore)
        .sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0))
        .slice(0, PERSISTENT_DRAFT_MAX)
    );
    await storageSet({ [PERSISTENT_DRAFT_KEY]: persistentDraftStore });
  }

  function lookupPersistentDraft(session, history, action) {
    const tenantScope = getTenantCacheScope();
    const configVersion = state.configVersion || 0;
    const key = makePersistentDraftKey(tenantScope, session.id, history.signature, action, configVersion);
    const entry = persistentDraftStore[key];
    if (!entry || Date.now() - Number(entry.updatedAt || 0) > PERSISTENT_DRAFT_TTL) return null;
    return entry;
  }

  async function clearPersistentDraftsForSession(sessionId) {
    const tenantScope = getTenantCacheScope();
    const before = Object.keys(persistentDraftStore).length;
    persistentDraftStore = Object.fromEntries(Object.entries(persistentDraftStore).filter(([, entry]) => (
      entry?.tenantScope !== tenantScope || entry?.sessionId !== sessionId
    )));
    if (Object.keys(persistentDraftStore).length !== before) {
      await storageSet({ [PERSISTENT_DRAFT_KEY]: persistentDraftStore });
    }
  }

  function rememberHistorySample(session, history) {
    if (!session?.id || !history?.turns?.length) return;
    const turns = history.turns
      .filter(turn => turn.role === 'user' || turn.role === 'assistant')
      .slice(-HISTORY_SAMPLES_MAX_TURNS)
      .map(turn => ({
        role: turn.role,
        content: cleanText(turn.content).slice(0, 1200),
        type: turn.type === 'card' ? 'card' : 'text',
        timestamp: Number(turn.timestamp || 0)
      }));
    if (!turns.some(turn => turn.role === 'assistant')) return;
    visitedHistorySamples.delete(session.id);
    visitedHistorySamples.set(session.id, {
      session_id: session.id, user_name: session.name || '客户', turns, updatedAt: Date.now()
    });
    while (visitedHistorySamples.size > HISTORY_SAMPLES_MAX_SESSIONS) {
      visitedHistorySamples.delete(visitedHistorySamples.keys().next().value);
    }
  }

  function collectHistorySamples(maxSessions = 12, maxTurns = 30) {
    const active = getActiveSession();
    if (active?.id) {
      rememberHistorySample(active, parseConversationHistory(active));
    }
    const sessions = [];
    let totalChars = 0;
    const cappedSessions = Math.min(HISTORY_SAMPLES_MAX_SESSIONS, Math.max(1, Number(maxSessions) || 12));
    const cappedTurns = Math.min(HISTORY_SAMPLES_MAX_TURNS, Math.max(1, Number(maxTurns) || 30));
    for (const sample of Array.from(visitedHistorySamples.values()).reverse().slice(0, cappedSessions)) {
      const turns = [];
      for (const turn of sample.turns.slice(-cappedTurns)) {
        const remaining = HISTORY_SAMPLES_MAX_CHARS - totalChars;
        if (remaining <= 0) break;
        const content = cleanText(turn.content).slice(0, remaining);
        if (!content) continue;
        turns.push({ ...turn, content });
        totalChars += content.length;
      }
      if (turns.some(turn => turn.role === 'assistant')) {
        sessions.push({ session_id: sample.session_id, user_name: sample.user_name, turns });
      }
      if (totalChars >= HISTORY_SAMPLES_MAX_CHARS) break;
    }
    return sessions.length
      ? { ok: true, sessions, totalChars }
      : { ok: false, error: '当前会话未检测到客服回复记录。请在左侧点击一个已有往来消息的客户会话后重试' };
  }

  function classifyCustomerIntent(userName, turns, cardText = '') {
    const combined = (userName + ' ' + cardText + ' ' + (turns || []).map(t => t.content).join(' ')).toLowerCase();
    if (/注销|异常|限制登录|违规信息|长按消息可以举报/.test(combined)) {
      return { category: 'invalid', label: '🚫 账号异常', ignoreFollowup: true };
    }
    if (/营销顾问|生态营销|广告投放|聚光投放|官方顾问|合作想沟通|商务合作|推广合作/.test(combined)) {
      return { category: 'vendor', label: '📢 平台推销', ignoreFollowup: true };
    }
    if (/留客资/.test(combined) || (turns || []).some(t => /微信号?|vx|wx|手机号/i.test(t.content) && t.role === 'user')) {
      return { category: 'lead', label: '📋 已留客资', ignoreFollowup: false };
    }
    if ((turns || []).some(t => String(t.content).includes('对方已点击你的企业微信联系卡')) || cardText.includes('对方已点击你的企业微信联系卡')) {
      return { category: 'wecom', label: '📇 企微已点', ignoreFollowup: false };
    }
    if (/邀请码|内测|怎么用|怎么买|价格|多少钱|收费|排版|工具|试用|考证|家装|美业|教培|自媒体/.test(combined)) {
      return { category: 'prospect', label: '🎯 意向客户', ignoreFollowup: false };
    }
    return { category: 'general', label: '💬 咨询', ignoreFollowup: false };
  }

  function scanAndSyncContactList() {
    const cards = Array.from(document.querySelectorAll('.sx-contact-item')).filter(c => !isVirtualGhost(c));
    if (!cards.length) return;
    state.followupStateMap ||= {};
    let changed = false;
    for (const card of cards) {
      const name = cleanText(card.querySelector('.nick-name')?.innerText);
      const dataKey = card.getAttribute('data-key') || '';
      const id = dataKey || `name:${name}`;
      if (!name || !id) continue;
      const rawText = cleanText(card.innerText);
      const lines = rawText.split(/\s{2,}|\n/).map(l => cleanText(l)).filter(Boolean);
      const snippetLine = lines.filter(l => l !== name && !/^\d{1,2}:\d{2}/.test(l) && !/^\d{2}\/\d{2}/.test(l) && l !== '留客资' && l !== '[超时未回复]').at(-1) || '';
      const timeLine = lines.find(l => /^\d{1,2}:\d{2}/.test(l) || /^\d{2}\/\d{2}/.test(l)) || '';
      
      const previous = state.followupStateMap[id] || {};
      const intent = classifyCustomerIntent(name, [{ content: snippetLine, role: 'user' }], rawText);
      const snippet = snippetLine || previous.snippet || '暂无对话';
      const timeText = timeLine || previous.timeText || '最近';
      
      let stage = previous.stage || 'waiting_reply';
      let nextFollowupAt = Number(previous.nextFollowupAt || 0);
      let followupCount = Number(previous.followupCount || 0);

      if (intent.ignoreFollowup) {
        stage = intent.category;
        nextFollowupAt = 0;
      } else if (rawText.includes('[超时未回复]') || card.querySelector('.d-badge, .d-badge-floating, [class*="badge"]') || rawText.includes('[笔记]') || rawText.includes('[图片]')) {
        stage = 'needs_reply';
        nextFollowupAt = 0;
      } else if (intent.category === 'wecom') {
        stage = 'card_clicked_unconfirmed';
        nextFollowupAt ||= Date.now() + 24 * 60 * 60 * 1000;
      } else if (intent.category === 'lead') {
        stage = 'lead_captured';
        nextFollowupAt = 0;
      } else if (stage !== 'done') {
        if (!nextFollowupAt) {
          nextFollowupAt = Date.now() + 24 * 60 * 60 * 1000;
        }
      }

      const nextItem = {
        ...previous,
        sessionId: id,
        userName: name,
        category: intent.category,
        categoryLabel: intent.label,
        snippet,
        timeText,
        stage,
        nextFollowupAt,
        followupCount,
        updatedAt: Date.now()
      };

      if (followupStateChanged(previous, nextItem)) {
        state.followupStateMap[id] = nextItem;
        changed = true;
      }
    }
    if (changed) {
      storageSet({ followupStateMap: state.followupStateMap });
    }
  }

  function followupStateChanged(previous, next) {
    return ['userName', 'stage', 'category', 'snippet', 'lastCustomerAt', 'lastAssistantAt', 'nextFollowupAt', 'followupCount', 'cardClicked', 'leadCaptured']
      .some(key => previous?.[key] !== next?.[key]);
  }

  function updateCustomerStageUI(item) {
    const label = document.getElementById('xhsCustomerStage');
    if (!label || !item) return;
    const names = {
      needs_reply: '待回复', card_sent: '已发名片', card_clicked_unconfirmed: '名片已点击，添加未确认',
      lead_captured: '已留资', waiting_reply: '等待回复', followup_due: '到期跟进', done: '已停止跟进'
    };
    label.textContent = names[item.stage] || '待判断';
    label.dataset.stage = item.stage || '';
  }

  async function setFollowupState(session, patch) {
    if (!session?.id) return null;
    state.followupStateMap ||= {};
    const previous = state.followupStateMap[session.id] || {
      sessionId: session.id, userName: session.name, stage: 'waiting_reply',
      lastCustomerAt: 0, lastAssistantAt: 0, nextFollowupAt: 0, followupCount: 0
    };
    const next = {
      ...previous, ...patch, sessionId: session.id, userName: session.name || previous.userName,
      updatedAt: Date.now()
    };
    updateCustomerStageUI(next);
    if (!followupStateChanged(previous, next)) return previous;
    state.followupStateMap = { ...state.followupStateMap, [session.id]: next };
    await storageSet({ followupStateMap: state.followupStateMap });
    return next;
  }

  async function syncFollowupState(session, history) {
    const previous = state.followupStateMap?.[session.id] || {};
    const userTurns = history.turns.filter(turn => turn.role === 'user');
    const assistantTurns = history.turns.filter(turn => turn.role === 'assistant');
    const lastCustomerAt = Number(userTurns.at(-1)?.timestamp || previous.lastCustomerAt || 0);
    const lastAssistantAt = Number(assistantTurns.at(-1)?.timestamp || previous.lastAssistantAt || Date.now());
    const cardClicked = history.turns.some(turn => turn.role === 'system'
      && cleanText(turn.content).includes('对方已点击你的企业微信联系卡')) || Boolean(previous.cardClicked);
    const cardSent = history.turns.some(turn => turn.role === 'assistant' && turn.type === 'card');
    const leadCaptured = Boolean(extractLead(history, session)) || Boolean(previous.leadCaptured);
    const intent = classifyCustomerIntent(session.name, history.turns, session?.card?.innerText || '');

    const newestTurn = history.newestTurn || history.turns.at(-1);
    const snippet = newestTurn ? `${newestTurn.role === 'assistant' ? '客服' : '客户'}: ${cleanText(newestTurn.content).slice(0, 80)}` : (previous.snippet || '暂无对话');
    const timeText = newestTurn?.timeText || (newestTurn?.timestamp ? new Date(newestTurn.timestamp).toLocaleString('zh-CN', { hour12: false }) : '刚刚');

    let stage = previous.stage || 'waiting_reply';
    let nextFollowupAt = Number(previous.nextFollowupAt || 0);
    let followupCount = Number(previous.followupCount || 0);

    if (intent.ignoreFollowup) {
      stage = intent.category;
      nextFollowupAt = 0;
    } else if (history.needsReply) {
      stage = 'needs_reply';
      nextFollowupAt = 0;
      followupCount = 0;
    } else if (leadCaptured && !lastAssistantAt) {
      stage = 'lead_captured';
      nextFollowupAt = 0;
    } else if (lastAssistantAt) {
      if (!nextFollowupAt || (lastAssistantAt !== Number(previous.lastAssistantAt || 0) && previous.stage !== 'followup_due')) {
        nextFollowupAt = lastAssistantAt + 24 * 60 * 60 * 1000;
      }
      if (followupCount >= 2) {
        stage = 'done';
        nextFollowupAt = 0;
      } else if (nextFollowupAt && nextFollowupAt <= Date.now()) {
        stage = 'followup_due';
      } else if (cardClicked) {
        stage = 'card_clicked_unconfirmed';
      } else if (cardSent || previous.stage === 'card_sent') {
        stage = 'card_sent';
      } else {
        stage = 'waiting_reply';
      }
    } else if (cardClicked) {
      stage = 'card_clicked_unconfirmed';
      nextFollowupAt ||= Date.now() + 24 * 60 * 60 * 1000;
    }
    return setFollowupState(session, {
      stage, category: intent.category, categoryLabel: intent.label,
      snippet, timeText, lastCustomerAt, lastAssistantAt, nextFollowupAt,
      followupCount, cardClicked, leadCaptured
    });
  }

  async function recordOutboundFollowup(session, action = 'reply') {
    const previous = state.followupStateMap?.[session.id] || {};
    const isFollowup = action === 'manual_followup';
    const followupCount = isFollowup
      ? Math.min(2, Number(previous.followupCount || 0) + 1)
      : Number(previous.followupCount || 0);
    return setFollowupState(session, {
      stage: followupCount >= 2 ? 'done' : 'waiting_reply',
      lastAssistantAt: Date.now(),
      nextFollowupAt: followupCount >= 2
        ? 0
        : Date.now() + (isFollowup ? 72 : 24) * 60 * 60 * 1000,
      followupCount
    });
  }

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
      .filter(el => isVisible(el) && cleanText(el.innerText) && cleanText(el.innerText) !== state.operatorNickname)
      // 页面顶部账号栏也使用 .user-nickname；它代表店铺操作员，不是当前客户。
      // 只把正文右侧区域的昵称当成交叉校验信号。若该区域没有昵称，data-key 仍是会话真源。
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 80 && rect.left > window.innerWidth * 0.68;
      });
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
    const businessLine = state.knowledgeScope || 'default';
    return `xhs:${location.hostname}:${account || 'unconfigured'}:${businessLine}`;
  }

  function getBridgeUrl() {
    return 'http://127.0.0.1:18195';
  }

  function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (state.workspaceToken) headers.Authorization = "Bearer " + state.workspaceToken;
    let baseUrl = state.modelBaseUrl || 'http://127.0.0.1:10100/v1/chat/completions';
    let modelName = state.modelName || 'google-antigravity/gemini-3.7-flash';
    const isRemote = /^https?:\/\//i.test(baseUrl) && !/127\.0\.0\.1|localhost|::1/i.test(baseUrl);
    if (!state.modelApiKey && isRemote) {
      baseUrl = 'http://127.0.0.1:10100/v1/chat/completions';
      modelName = 'google-antigravity/gemini-3.7-flash';
    }
    headers['X-Model-Base-Url'] = baseUrl;
    headers['X-Model-Name'] = modelName;
    if (state.modelApiKey) headers['X-Model-Key'] = state.modelApiKey;
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
    updateTokenMeterUI();
  }

  function parseTimestamp(text) {
    return Safety.parseMessageTimestamp(text);
  }

  function extractMessageTimestamp(item, bubble) {
    // 只信专用时间节点，绝不能从消息正文中找“14:00”之类文本。
    const candidates = item.querySelectorAll('.time, .msg-time, .message-time, [class*="time"], [class*="date"]');
    for (const node of candidates) {
      if (bubble.contains(node) || node.children.length > 0) continue;
      const text = cleanText(node.innerText || node.textContent);
      if (!text || text.length > 32) continue;
      const timestamp = parseTimestamp(text);
      if (timestamp) return timestamp;
    }
    // 兜底：小红书消息气泡上方常有带日期的文本前缀，如 "2026-09-01 10:54:19 新作AI"
    const rawItemText = cleanText(item.innerText || '');
    const bubbleText = cleanText(bubble?.innerText || '');
    const prefix = rawItemText.replace(bubbleText, '').trim();
    if (prefix) {
      const match = prefix.match(/(20\d{2}[-/][01]?\d[-/][0-3]?\d\s+[0-2]?\d:[0-5]\d(?::[0-5]\d)?|(?:今天|昨天)?\s*[0-2]?\d:[0-5]\d)/);
      if (match) return parseTimestamp(match[0]);
    }
    return 0;
  }

  function emptyHistory(session) {
    return {
      sessionId: session?.id || '', contactName: session?.name || '', turns: [], userMessages: [],
      botMessages: [], sharedCards: [], latestUserMsg: '', latestUserTurn: null,
      latestAssistantTurn: null, newestTurn: null, needsReply: false,
      signature: `${session?.id || 'unknown'}::empty`
    };
  }

  function getMessageScroller() {
    return Array.from(document.querySelectorAll('.vue-recycle-scroller.recyScroll1'))
      .find(el => isVisible(el) && el.querySelector('.im-msg-item')) || null;
  }

  function isInvertedMessageScroller(scroller) {
    for (let node = scroller; node && node !== document.body; node = node.parentElement) {
      if (Safety.isHalfTurnTransform(getComputedStyle(node).transform)) return true;
    }
    return false;
  }

  function ensureMessageWindowAtBottom() {
    // 人工介入保护：如果用户在最近 10 秒内有滚动/鼠标/键盘操作，绝不强行篡改用户的滚动位置
    if (Date.now() - lastUserActivityAt < 10_000) return false;
    // 消息列表同样是虚拟列表。小红书当前用 180° 翻转实现倒序滚动，scrollTop=0 才是最新消息；
    // 普通列表则相反。运行时识别方向，避免把“滚到最新”误写成“滚到最旧”。
    const scroller = getMessageScroller();
    if (!scroller) return false;
    const position = Safety.messageBottomState({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      inverted: isInvertedMessageScroller(scroller)
    });
    if (position.atBottom) return false;
    scroller.scrollTop = position.targetScrollTop;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  }

  function parseConversationHistory(session) {
    let scroller = Array.from(document.querySelectorAll('.vue-recycle-scroller.recyScroll1, .vue-recycle-scroller'))
      .find(el => el.querySelector('.im-msg-item, [class*="msg-item"]'));
    if (!scroller) {
      scroller = document.querySelector('[class*="chat-content"], [class*="msg-list"], .im-chat-content, .chat-window, body');
    }
    if (!scroller) return emptyHistory(session);

    const records = Array.from(scroller.querySelectorAll('.im-msg-item, [class*="msg-item"], [class*="message-item"]'))
      .filter(item => !isVirtualGhost(item))
      .map((item, domIndex) => {
        const isSystemNotice = item.querySelector('[style*="align-items: center"], .system-message, .tip-message') ||
          cleanText(item.innerText).includes('对方已点击你的企业微信联系卡') ||
          cleanText(item.innerText).includes('对方提交了留资卡');
        const bubble = item.querySelector('.text-message, .card_container, .card-container, [class*="card"]');
        let content = cleanText(bubble?.innerText || bubble?.textContent);
        if (!content && isSystemNotice) {
          content = cleanText(item.innerText).replace(/20\d{2}[-/]\d+[-/]\d+\s+\d+:\d+(?::\d+)?/, '').trim();
        }
        if (!content) return null;

        const itemRect = item.getBoundingClientRect();
        const bubbleRect = bubble ? bubble.getBoundingClientRect() : itemRect;
        const hasRightDirection = Boolean(item.querySelector('.right, [class*="right"], [class*="mine"], [class*="self"]')) || item.classList.contains('right');
        const hasLeftDirection = Boolean(item.querySelector('.left, [class*="left"], [class*="other"]')) || item.classList.contains('left');

        let role = 'user';
        let type = 'text';
        if (isSystemNotice) {
          role = 'system';
          type = 'system_notice';
        } else if (hasRightDirection || (!hasLeftDirection && itemRect.width > 0 && bubbleRect.left >= itemRect.left + itemRect.width * 0.43)) {
          role = 'assistant';
          if (content.includes('企业微信') || content.includes('获客链接') || bubble?.classList.contains('card_container')) {
            type = 'card';
          }
        } else if (bubble?.classList.contains('card_container') || content.includes('分享卡片') || content.includes('[笔记]')) {
          type = 'card';
        }

        const timestamp = extractMessageTimestamp(item, bubble || item);
        return {
          role,
          content,
          type,
          timestamp,
          timeText: timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '',
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
    // 消息签名：优先时间戳，若无时间戳则采用消息总条数与最后发言内容，绝不使用容易在虚拟列表复用时漂移的 domIndex
    const lastTurnIdentity = latestUserTurn
      ? `${latestUserTurn.timestamp ? latestUserTurn.timestamp : ('t' + turns.length)}:${latestUserTurn.content}`
      : 'no-user';
    const sig = lastTurnIdentity;
    return {
      sessionId: session.id, contactName: session.name, turns, userMessages, botMessages, sharedCards,
      latestUserMsg: latestUserTurn?.content || '', latestUserTurn, latestAssistantTurn, newestTurn,
      needsReply: Boolean(latestUserTurn && newestTurn?.role === 'user'),
      signature: `${session.id}::${sig}`
    };
  }

  function extractLead(history, session) {
    const platformLeadHint = cleanText(session?.card?.innerText).includes('留客资');
    return Safety.extractContactLead(history?.turns || [], platformLeadHint);
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
      addLog('lead', `已识别${lead.type}并预填右侧客资：${lead.value}`);
    }
  }

  async function captureLead(session, history) {
    const lead = extractLead(history, session);
    if (!lead || !session?.id) return { found: false, created: false };
    const key = `${session.id}:${lead.type}:${lead.value}`;
    if (capturedLeadKeys.has(key)) return { found: true, created: false };
    if (Number(leadRetryUntil.get(key) || 0) > Date.now()) return { found: true, created: false };
    capturedLeadKeys.add(key);
    syncLeadToRightPanel(lead);
    void setFollowupState(session, { stage: 'lead_captured', leadCaptured: true, nextFollowupAt: 0 });
    try {
      const response = await bridgeFetch(`${getBridgeUrl()}/leads/capture`, {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({
          session_id: session.id, user_name: session.name,
          lead_type: lead.type, lead_value: lead.value,
          lead_timestamp: lead.timestamp || history.latestUserTurn?.timestamp || 0,
          context_summary: history.turns.slice(-6).map(turn => turn.content).join(' | ')
        })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      // 仅当客资真实发生时间为今天时，才计入插件今日统计；历史客资不计入今日新增
      if (data.created && Safety.isSameDay(lead.timestamp || history.latestUserTurn?.timestamp || Date.now())) {
        await ensureDailyStats();
        state.leadsCount += 1;
        await storageSet({ leadsCount: state.leadsCount, statsDate: state.statsDate });
      }
      addLog('lead', `客资已入库：${session.name} · ${lead.type}`);
      return { found: true, created: Boolean(data.created) };
    } catch (error) {
      capturedLeadKeys.delete(key);
      leadRetryUntil.set(key, Date.now() + 60_000);
      const msg = error.message && error.message.includes('Failed to fetch') ? 'Bridge 离线，客资暂存本地' : (error.message || 'Bridge 不可用');
      addLog('warn', `客资入库提示：${msg}`);
      return { found: true, created: false, error: msg };
    }
  }

  async function syncPlatformLeads() {
    if (leadSyncRunning) return { ok: false, error: '留资同步正在进行中' };
    leadSyncRunning = true;
    abortPendingRequest('lead_sync_started');
    const syncStartedAt = Date.now();
    let cancelled = false;
    const originalSessionId = getActiveSession()?.id || '';
    const scroller = getVisibleContactScroller();
    const originalScrollTop = Number(scroller?.scrollTop || 0);
    const visited = new Set();
    let tagged = 0;
    let captured = 0;
    updateRuntimeStatus('copilot', '正在同步平台留资');
    try {
      if (Safety.shouldAbortLeadSync(syncStartedAt, lastUserActivityAt)) {
        cancelled = true;
        return { ok: false, cancelled: true, error: '检测到人工操作，留资同步已取消' };
      }
      if (scroller) {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(180);
      }
      for (let page = 0; page < 80; page += 1) {
        if (Safety.shouldAbortLeadSync(syncStartedAt, lastUserActivityAt)) {
          cancelled = true;
          return { ok: false, cancelled: true, error: '检测到人工操作，留资同步已取消' };
        }
        const descriptors = Array.from(document.querySelectorAll('.sx-contact-item'))
          .filter(card => isVisible(card) && !isVirtualGhost(card) && cleanText(card.innerText).includes('留客资'))
          .map(card => ({
            id: card.getAttribute('data-key') || `name:${cleanText(card.querySelector('.nick-name')?.innerText)}`,
            name: cleanText(card.querySelector('.nick-name')?.innerText)
          }))
          .filter(item => item.id && !visited.has(item.id));
        for (const item of descriptors) {
          if (Safety.shouldAbortLeadSync(syncStartedAt, lastUserActivityAt)) {
            cancelled = true;
            return { ok: false, cancelled: true, error: '检测到人工操作，留资同步已取消' };
          }
          visited.add(item.id);
          tagged += 1;
          const card = Array.from(document.querySelectorAll('.sx-contact-item')).find(candidate => {
            const id = candidate.getAttribute('data-key') || `name:${cleanText(candidate.querySelector('.nick-name')?.innerText)}`;
            return id === item.id && isVisible(candidate) && !isVirtualGhost(candidate);
          });
          if (!card) continue;
          if (getActiveSession()?.id !== item.id) card.click();
          const session = await waitForSession(item.id, 2400);
          if (Safety.shouldAbortLeadSync(syncStartedAt, lastUserActivityAt)) {
            cancelled = true;
            return { ok: false, cancelled: true, error: '检测到人工操作，留资同步已取消' };
          }
          if (!session) continue;
          if (ensureMessageWindowAtBottom()) await sleep(260);
          else await sleep(120);
          const result = await captureLead(session, parseConversationHistory(session));
          if (result?.found) captured += 1;
        }
        if (!scroller) break;
        const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop >= maxScrollTop - 8) break;
        const next = Math.min(maxScrollTop, scroller.scrollTop + Math.max(220, Math.floor(scroller.clientHeight * 0.85)));
        if (next === scroller.scrollTop) break;
        scroller.scrollTop = next;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(180);
      }
      return { ok: true, tagged, captured };
    } finally {
      if (!cancelled && scroller) {
        scroller.scrollTop = originalScrollTop;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await sleep(180);
      }
      const originalCard = !cancelled && Array.from(document.querySelectorAll('.sx-contact-item')).find(card => {
        const id = card.getAttribute('data-key') || `name:${cleanText(card.querySelector('.nick-name')?.innerText)}`;
        return id === originalSessionId && isVisible(card) && !isVirtualGhost(card);
      });
      if (originalCard && getActiveSession()?.id !== originalSessionId) {
        originalCard.click();
        await waitForSession(originalSessionId, 1800);
      }
      leadSyncRunning = false;
      updateRuntimeStatus('copilot', cancelled ? '留资同步已由人工操作取消' : '等待客户新消息');
      scheduleSense(250);
    }
  }

  function abortPendingRequest(reason) {
    requestSerial += 1;
    requestController?.abort(reason || 'session_changed');
    requestController = null;
    inFlightSignatures.clear();
  }

  async function suspendForAuthFailure() {
    try {
      const response = await bridgeFetch(`${getBridgeUrl()}/tenant/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_name: state.workspaceName || '我的工作区' })
      });
      const data = await response.json();
      if (data.ok && data.access_token) {
        state.workspaceToken = data.access_token;
        state.enabled = true;
        await storageSet({ workspaceToken: data.access_token, enabled: true });
        globalCircuitUntil = 0;
        addLog('info', '已自动刷新并连接工作区凭据');
        return;
      }
    } catch (_) {}
    state.enabled = false;
    state.fullAutoArmedAt = 0;
    state.operatorAway = false;
    globalCircuitUntil = Infinity;
    // 保留失效令牌和原工作区身份，让设置页能明确报错并走恢复流程；
    // 清空令牌会让下次保存静默注册一个空工作区，造成旧数据“消失”。
    await storageSet({ enabled: false, fullAutoArmedAt: 0, operatorAway: false });
    syncDockFromState();
    addLog('error', '工作区凭据已失效，系统已停机并保留原工作区信息。请先恢复凭据，勿直接新建工作区');
  }

  function checkDailyTokenState() {
    const today = new Date().toLocaleDateString("zh-CN");
    if (state.tokenDate !== today) {
      state.tokenDate = today;
      state.todayTokens = 0;
      state.todayCalls = 0;
      state.circuitTripped = false;
      storageSet({ tokenDate: today, todayTokens: 0, todayCalls: 0, circuitTripped: false });
    }
    return Boolean(state.circuitTripped);
  }

  function recordTokenUsage(tokens) {
    checkDailyTokenState();
    const t = Math.max(1, Number(tokens) || 1);
    state.todayTokens = Number(state.todayTokens || 0) + t;
    state.todayCalls = Number(state.todayCalls || 0) + 1;
    const budget = Number(state.dailyTokenBudget || 200_000);
    const callLimit = Number(state.dailyCallBudget || 300);
    if (state.todayTokens >= budget || state.todayCalls >= callLimit) {
      state.circuitTripped = true;
      addLog("error", "🚨 【Token熔断】今日消耗已达硬上限（" + (state.todayTokens / 1000).toFixed(1) + "k / " + (budget / 1000).toFixed(0) + "k），已自动停止一切自动请求！防止额度滥用。");
      updateRuntimeStatus(state.runMode, "🚨 Token已熔断");
    }
    storageSet({
      todayTokens: state.todayTokens,
      todayCalls: state.todayCalls,
      tokenDate: state.tokenDate,
      circuitTripped: state.circuitTripped
    });
    updateTokenMeterUI();
  }

  function resetTokenCircuit() {
    state.todayTokens = 0;
    state.todayCalls = 0;
    state.circuitTripped = false;
    state.tokenDate = new Date().toLocaleDateString("zh-CN");
    storageSet({
      todayTokens: 0,
      todayCalls: 0,
      circuitTripped: false,
      tokenDate: state.tokenDate
    });
    updateTokenMeterUI();
    addLog("info", "已重置今日 Token 配额与熔断状态");
  }

  function updateTokenMeterUI() {
    window.XhsDock?.updateTokenMeter({
      used: state.todayTokens,
      budget: state.dailyTokenBudget,
      calls: state.todayCalls,
      tripped: state.circuitTripped
    });
  }

  async function fetchLLMReply(history, session, action) {
    if (!history.latestUserMsg && action !== 'manual_followup') return '';
    if (inFlightSignatures.has(history.signature)) return '';
    if (checkDailyTokenState()) {
      addLog('error', '🚨 已触发 Token 熔断保护（今日消耗已达上限），系统已停止调用。可在控制台点击“重置”恢复');
      return '';
    }
    sessionLastFetchTime.set(session.id, Date.now());
    const retryAt = Math.max(Number(messageRetryUntil.get(history.signature) || 0), Number(globalCircuitUntil || 0));
    if (retryAt > Date.now()) return '';
    const serial = ++requestSerial;
    requestController?.abort('superseded');
    const controller = new AbortController();
    requestController = controller;
    inFlightSignatures.add(history.signature);
    lastComplianceFlags = [];
    const requestStartedAt = Date.now();
    addLog('info', `分析 [${session.name}] 的 ${history.turns.length} 条会话记录…`);
    try {
      const response = await bridgeFetch(`${getBridgeUrl()}/reply`, {
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
      lastComplianceFlags = Array.isArray(data.compliance_flags) ? data.compliance_flags : [];
      lastSendCardDirective = data.send_card || null;
      const active = getActiveSession();
      const activeHistory = active ? parseConversationHistory(active) : null;
      // 会话有效性判断：只要当前活跃客户仍然是同一个（active.id === session.id），
      // 且客户没有发送新的消息（最新用户消息与发请求时完全一致），且请求未被人工切换打断（serial === requestSerial），
      // 即认定结果有效，严禁因虚拟列表重排等细微签名变化直接抛弃结果引发循环请求！
      const isSameSession = Boolean(active && active.id === session.id);
      const isLatestMsgUnchanged = activeHistory?.latestUserMsg === history.latestUserMsg;
      if (serial !== requestSerial || !isSameSession || !isLatestMsgUnchanged) {
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
          const retryResponse = await bridgeFetch(getBridgeUrl() + '/reply', {
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
        const usageTokens = Number(data.usage?.total_tokens || 0);
        recordTokenUsage(usageTokens > 0 ? usageTokens : (reply.length * 2 + (history.turns.length * 30)));
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
        let friendlyMsg = error.message || '请求失败';
        if (friendlyMsg === 'model_api_key_required') {
          friendlyMsg = '未配置大模型 API Key，请在设置后台填入';
        } else if (friendlyMsg.includes('Failed to fetch') || error?.name === 'TypeError' || status === 0) {
          friendlyMsg = '无法连接本地 Bridge 服务（127.0.0.1:18195）';
        }
        if (status !== 401 && status !== 403) {
          if (state.runMode === 'copilot') {
            copilotAttemptedSignatures.add(history.signature);
            addLog('error', `${friendlyMsg}（点击上方按钮可重新生成）`);
          } else {
            addLog('error', `${friendlyMsg}；同一消息将在 ${Math.ceil(delay / 1000)} 秒后重试`);
          }
        }
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
    const previousSessionId = currentDraftSessionId;
    const textarea = getReplyTextarea();
    const cached = draftCache.get(previousSessionId);
    const currentText = cleanText(textarea?.value);
    if (currentText) {
      manualDraftCache.set(previousSessionId, {
        text: textarea.value,
        signature: cached?.signature || ''
      });
      const candidate = feedbackCandidates.get(previousSessionId);
      if (candidate) candidate.humanReply = textarea.value;
    }
    // 点击切换发生在捕获阶段，此时输入框仍属于旧会话；必须无条件清空，避免旧草稿落到新客户。
    if (textarea && textarea.value) safeSetNativeValue(textarea, '');
    currentDraftSessionId = '';
  }

  function placeDraft(session, history, reply, action = (history.needsReply ? 'reply' : 'manual_followup'), persist = true) {
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
    draftCache.set(session.id, { signature: history.signature, reply, action, sendRecorded: false });
    if (persist) savePersistentDraft(session, history, action, reply).catch(() => {});
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
    if (state.runMode !== 'copilot' || !candidate) return;
    window.XhsDock?.showFeedbackCard(candidate, sent);
  }

  function hideFeedbackCard() {
    window.XhsDock?.hideFeedbackCard();
  }

  function captureFeedbackCandidate() {
    if (state.runMode !== 'copilot') return;
    const session = getActiveSession();
    const cached = session ? draftCache.get(session.id) : null;
    const humanReply = cleanText(getReplyTextarea()?.value);
    if (!session || !cached || !humanReply) return;
    manualDraftCache.delete(session.id);
    const history = parseConversationHistory(session);
    rememberHistorySample(session, history);
    feedbackCandidate = {
      session: { id: session.id, name: session.name },
      history: JSON.parse(JSON.stringify(history)), aiReply: cached.reply, humanReply,
      knowledgeScope: getKnowledgeScope(), sent: true
    };
    feedbackCandidates.set(session.id, feedbackCandidate);
    if (!cached.sendRecorded) {
      cached.sendRecorded = true;
      void recordOutboundFollowup(session, cached.action || 'reply');
    }
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
      const response = await bridgeFetch(`${getBridgeUrl()}/feedback`, {
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
    if (destroyed || leadSyncRunning || (!state.enabled && !force) || state.runMode !== 'copilot') return;
    if (force && !state.enabled) {
      state.enabled = true;
      await storageSet({ enabled: true });
      syncDockFromState();
    }
    const session = getActiveSession();
    if (!session || (!force && !session.stable)) return;
    const isSwitching = session.id !== currentSessionId;
    if (session.id !== currentSessionId) {
      releasePreviousPluginDraft(session.id);
      currentSessionId = session.id;
      updateSessionLabel(session);
    }
    // 只有在主动点击按钮(force)或者刚切换会话时才尝试归位，日常轮询不抢夺用户滚动条
    if ((force || isSwitching) && ensureMessageWindowAtBottom()) await sleep(260);
    const history = parseConversationHistory(session);
    rememberHistorySample(session, history);
    void captureLead(session, history);
    const followupState = await syncFollowupState(session, history);
    const followupDue = !history.needsReply && followupState?.stage === 'followup_due'
      && Number(followupState.followupCount || 0) < 2;
    const action = (!history.needsReply && (force || followupDue)) ? 'manual_followup' : 'reply';
    const effectiveHistory = followupDue
      ? { ...history, signature: `${history.signature}::followup:${Number(followupState.followupCount || 0) + 1}:${followupState.nextFollowupAt}` }
      : history;

    if (force) {
      userClearedSignatures.delete(session.id);
      copilotAttemptedSignatures.delete(effectiveHistory.signature);
      messageRetryUntil.delete(effectiveHistory.signature);
    }

    const savedManualDraft = manualDraftCache.get(session.id);
    if (savedManualDraft) {
      if (savedManualDraft.signature === history.signature && !cleanText(getReplyTextarea()?.value) && !userClearedSignatures.has(session.id)) {
        safeSetNativeValue(getReplyTextarea(), savedManualDraft.text);
        currentDraftSessionId = session.id;
        updateRuntimeStatus('copilot', '已恢复该客户未发送的人工草稿');
        return;
      }
      if (savedManualDraft.signature !== history.signature) manualDraftCache.delete(session.id);
    }
    const lastFetchAt = Number(sessionLastFetchTime.get(session.id) || 0);
    if (!force && Date.now() - lastFetchAt < SESSION_FETCH_COOLDOWN_MS) return;
    if (!force && Number(messageRetryUntil.get(effectiveHistory.signature) || 0) > Date.now()) return;

    // 用户已明确清空当前签名的草稿，日常后台轮询绝不再重复打扰或回填
    if (!force && userClearedSignatures.get(session.id) === effectiveHistory.signature) return;
    // 副驾模式下若已尝试过且失败，不再在后台自动循环重试报错，等待用户主动点击或新消息
    if (!force && copilotAttemptedSignatures.has(effectiveHistory.signature)) return;

    const cached = draftCache.get(session.id);
    if (!force && !history.needsReply && !followupDue) {
      updateRuntimeStatus('copilot', '等待客户新消息');
      return;
    }

    // 相同会话在非切换、非强制触发时，如果已经生成过当前签名的草稿，绝不重复回填输入框
    if (!force && cached?.signature === effectiveHistory.signature) {
      if (isSwitching && !cleanText(getReplyTextarea()?.value)) placeDraft(session, effectiveHistory, cached.reply, action);
      return;
    }

    // 如果当前输入框已有用户正在输入的内容（非 AI 草稿），不进行覆盖
    const currentInput = cleanText(getReplyTextarea()?.value);
    if (!force && currentInput && currentInput !== cleanText(cached?.reply)) return;

    if (!force) {
      const persistent = lookupPersistentDraft(session, effectiveHistory, action);
      if (persistent && placeDraft(session, effectiveHistory, persistent.reply, action, false)) {
        updateRuntimeStatus('copilot', '已恢复该客户上次草稿');
        return;
      }
    }
    const reply = await fetchLLMReply(effectiveHistory, session, action);
    if (placeDraft(session, effectiveHistory, reply, action)) {
      const cardHint = lastSendCardDirective === 'wecom' ? ' · 建议点击上方发送企微名片' : (lastSendCardDirective === 'lead' ? ' · 建议点击发送留资卡' : '');
      updateRuntimeStatus('copilot', `草稿已生成${cardHint}`);
    }
    if (reply && lastComplianceFlags.length) addLog('warn', '草稿含敏感表述（' + lastComplianceFlags.join('、') + '），发送前请留意');
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

  function acquireSendLease(signature) {
    return chrome.runtime.sendMessage({ type: 'ACQUIRE_SEND_LEASE', key: signature, ttlMs: 90_000 })
      .then(result => Boolean(result?.acquired))
      .catch(() => false);
  }

  function releaseSendLease(signature) {
    if (!signature) return Promise.resolve();
    return chrome.runtime.sendMessage({ type: 'RELEASE_SEND_LEASE', key: signature }).catch(() => {});
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
    ensureMessageWindowAtBottom();
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
      ensureMessageWindowAtBottom();
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
    if (destroyed || leadSyncRunning || autoProcessing || !isFullAutoArmed() || !isWithinTimeScope()) return;
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
    let sendLeaseKey = '';
    try {
      if (!targetId) return;
      if (getActiveSession()?.id !== targetId) pending.card.click();
      const session = await waitForSession(targetId);
      if (!session) {
        contactRetryUntil.set(targetId, Date.now() + 60_000);
        return;
      }
      if (ensureMessageWindowAtBottom()) await sleep(260);
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
      sendLeaseKey = history.signature;
      if (!await acquireSendLease(sendLeaseKey)) {
        messageRetryUntil.set(history.signature, Date.now() + 30_000);
        addLog('info', `[${session.name}] 正由另一个标签页处理，本页已跳过`);
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
      await captureLead(session, history);
      const reply = await fetchLLMReply(history, session, 'auto_reply');
      if (!reply) {
        if (!messageRetryUntil.has(history.signature)) messageRetryUntil.set(history.signature, Date.now() + 60_000);
        return;
      }
      if (lastComplianceFlags.length) {
        messageRetryUntil.set(history.signature, Date.now() + 24 * 60 * 60 * 1000);
        addLog('warn', '草稿命中合规敏感词（' + lastComplianceFlags.join('、') + '），已转人工处理');
        return;
      }
      const sendResult = await humanTypeAndSend(session, history, reply, operationStartedAt);
      if (!sendResult.confirmed) {
        if (sendResult.clicked) {
          state.uncertainSendMap[history.signature] = Date.now() + 24 * 60 * 60 * 1000;
          // 已点击发送但回读失败时，真实结果未知。安全上必须把它计入小时上限，
          // 否则连续回读故障会绕过限额并继续操作其他会话。
          state.hourlySendTimestamps.push(Date.now());
          await storageSet({
            uncertainSendMap: state.uncertainSendMap,
            hourlySendTimestamps: state.hourlySendTimestamps
          });
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

      // 全自动模式下：若模型给出推卡指令且近期未重复发送，自动触发推送官方名片/留资卡
      if (lastSendCardDirective && (lastSendCardDirective === 'wecom' || lastSendCardDirective === 'lead')) {
        const cardRecentlySent = history.turns.slice(-4).some(t => t.type === 'card' || (t.content || '').includes('企业微信') || (t.content || '').includes('名片'));
        if (!cardRecentlySent) {
          await sleep(1000);
          await sendOfficialCard(lastSendCardDirective);
        }
      }
    } finally {
      await releaseSendLease(sendLeaseKey);
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
        const response = await bridgeFetch(`${getBridgeUrl()}/knowledge/upload`, {
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
      const response = await bridgeFetch(`${getBridgeUrl()}/knowledge/feishu`, {
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
    const response = await bridgeFetch(`${getBridgeUrl()}/knowledge/status`, {
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
      const response = await bridgeFetch(`${getBridgeUrl()}/knowledge/documents`, { headers: apiHeaders() });
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
      const response = await bridgeFetch(`${getBridgeUrl()}/feedback/list?scope=${scope}&limit=30`, { headers: apiHeaders() });
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
      const response = await bridgeFetch(`${getBridgeUrl()}/feedback/status`, {
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
    window.XhsDock?.addLog(type, text);
  }

  function updateSessionLabel(session) {
    window.XhsDock?.updateSessionLabel(session);
  }

  function updateRuntimeStatus(mode, detail) {
    window.XhsDock?.updateRuntimeStatus(mode, detail);
  }

  function syncMonitorUI() {
    window.XhsDock?.syncMonitorUI(state.monitor);
  }

  function syncDockFromState() {
    window.XhsDock?.syncState(state);
    const armed = isFullAutoArmed();
    updateRuntimeStatus(state.runMode, state.runMode === 'full_auto' ? (armed ? '监听新进线中' : '等待武装') : '等待客户新消息');
    syncMonitorUI();
    updateTokenMeterUI();
  }

  function renderFloatingDock() {
    window.XhsDock?.init({
      onGenerate: () => (state.runMode === 'full_auto' ? runFullAutoCycle() : handleCopilotSession(true)),
      onSendCard: (type) => sendOfficialCard(type),
      onLearnHistory: () => learnCurrentHistory(),
      onSaveFeedback: () => saveHumanFeedback(),
      onResetTokens: () => resetTokenCircuit(),
      onSaveConfig: (patch, extra) => saveConfig(patch, extra),
      onToggleAway: () => {
        const ending = isFullAutoArmed();
        saveConfig({}, { arm: !ending });
        addLog('info', ending ? '已结束无人值守，恢复人工占用' : '已开始无人值守；任何人工操作都会立即退出');
      },
      onLoadKnowledge: () => loadKnowledge(),
      onUploadFiles: (files) => uploadKnowledgeFiles(files),
      onImportFeishu: () => importFeishuKnowledge()
    });
  }

  async function learnCurrentHistory() {
    const button = document.getElementById('xhsBtnLearnNow');
    if (button) button.disabled = true;
    addLog('info', '正在采样当前会话并提炼你的专属话术…');
    try {
      const sampleResult = collectHistorySamples(12, 30);
      if (!sampleResult.ok || !sampleResult.sessions.length) {
        throw new Error(sampleResult.error || '未提取到客服有效回复记录');
      }
      let token = state.workspaceToken;
      if (!token) {
        token = await registerWorkspace(state.workspaceName || '我的工作区');
        state.workspaceToken = token;
        await storageSet({ workspaceToken: token });
      }
      const response = await bridgeFetch(getBridgeUrl() + '/tenant/learn-history', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ sessions: sampleResult.sessions })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'HTTP ' + response.status);
      const patch = {
        businessProfile: data.config?.business_profile || state.businessProfile,
        replyPreferences: data.config?.reply_preferences || state.replyPreferences,
        historyLearnedAt: Date.now(),
        learnedSummary: data.summary || '已学习历史回复',
        configVersion: Date.now()
      };
      await storageSet(patch);
      state = Object.assign({}, state, patch);
      addLog('success', '话术学习成功！' + patch.learnedSummary);
      updateRuntimeStatus('copilot', '已加载专属话术画像');
    } catch (err) {
      addLog('error', '学习失败：' + err.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function sendOfficialCard(type = 'wecom') {
    const session = getActiveSession();
    if (!session?.id) {
      addLog('warn', '未选中客户，请先点击左侧客户会话');
      return { ok: false, error: 'no_session' };
    }
    const label = type === 'wecom' ? '企业微信名片' : '官方留资卡';
    try {
      // 1. 切换到右侧“获客工具” Tab
      const allHeaders = Array.from(document.querySelectorAll('.d-tabs-header, [class*="tab-header"], span, div'));
      const toolHeader = allHeaders.find(h => cleanText(h.innerText) === '获客工具' && h.children.length === 0);
      if (toolHeader) {
        toolHeader.click();
        await sleep(300);
      }
      // 2. 切换子 Tab：“名片” 或 “留资卡”
      const targetSubName = type === 'wecom' ? '名片' : '留资卡';
      const subSegments = Array.from(document.querySelectorAll('.d-segment-item, [class*="segment-item"], span, div'));
      const targetSegment = subSegments.find(s => cleanText(s.innerText) === targetSubName && s.children.length === 0);
      if (targetSegment) {
        targetSegment.click();
        await sleep(300);
      }
      // 3. 找到卡片容器及其发送按钮
      const cards = Array.from(document.querySelectorAll('.business-card .card, .card-box, .card, [class*="card"]'))
        .filter(c => c.offsetParent !== null && (type === 'wecom' ? c.innerText.includes('企微') || c.innerText.includes('名片') : c.innerText.includes('留资') || c.innerText.includes('表单') || c.querySelector('button')));
      const targetCard = cards[0] || document.querySelector('.business-card .card');
      const sendBtn = targetCard?.querySelector('button.btn, button') || Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && cleanText(b.innerText) === '发送');
      if (!sendBtn) {
        const detailTip = type === 'lead'
          ? '未在右侧找到可发送的官方留资卡。请确认已在小红书【专业号后台 -> 获客工具 -> 用户留资卡】中创建留资表单卡'
          : '未在右侧找到可发送的企业微信名片。请确认已在小红书【专业号后台 -> 获客工具 -> 名片】中配置企微名片';
        addLog('warn', detailTip);
        return { ok: false, error: 'card_not_found' };
      }
      sendBtn.click();
      await setFollowupState(session, type === 'wecom'
        ? { stage: 'card_sent', cardClicked: false, nextFollowupAt: Date.now() + 24 * 60 * 60 * 1000 }
        : { stage: 'waiting_reply', nextFollowupAt: Date.now() + 24 * 60 * 60 * 1000 });
      addLog('success', `已向 [${session.name}] 发送${label}`);
      return { ok: true };
    } catch (err) {
      addLog('error', `发送${label}失败：${err.message || '操作异常'}`);
      return { ok: false, error: err.message };
    }
  }

  function scheduleSense(delay = 120) {
    clearTimeout(senseDebounce);
    senseDebounce = setTimeout(() => handleCopilotSession(false), delay);
  }

  function onTextareaInput(event) {
    if (!event.isTrusted) return;
    lastUserActivityAt = Date.now();
    const textarea = event.target?.closest?.('textarea');
    if (!textarea || textarea !== getReplyTextarea()) return;
    const session = getActiveSession();
    if (!session?.id) return;
    const history = parseConversationHistory(session);
    const text = textarea.value;
    if (!cleanText(text)) {
      // 用户手动清空了输入框，记录当前签名已被用户主动清空，禁止轮询重复回填
      userClearedSignatures.set(session.id, history.signature);
      draftCache.delete(session.id);
      manualDraftCache.delete(session.id);
      clearPersistentDraftsForSession(session.id).catch(() => {});
      hideFeedbackCard();
    } else {
      userClearedSignatures.delete(session.id);
      manualDraftCache.set(session.id, {
        text: text,
        signature: history.signature
      });
      if (feedbackCandidate && feedbackCandidate.session.id === session.id) {
        feedbackCandidate.humanReply = text;
      }
    }
  }

  function onDocumentClick(event) {
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
    await loadPersistentDraftCache();
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
    document.addEventListener('input', onTextareaInput, true);
    window.addEventListener('XHS_TEST_GENERATE', () => handleCopilotSession(true));
    observer = new MutationObserver(mutations => {
      if (mutations.some(m => !m.target.closest?.('#xhs-reply-dock-root'))) scheduleSense(160);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-key'] });
    senseTimer = setInterval(() => scheduleSense(0), 1100);
    autoTimer = setInterval(runFullAutoCycle, 900);
    setInterval(scanAndSyncContactList, 3000);
    scheduleSense(250);
    scanAndSyncContactList();
    addLog('success', `V${VERSION} 已加载：会话隔离、双模式调度与人工反馈学习已启用`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'SYNC_PLATFORM_LEADS') {
      syncPlatformLeads().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || '同步失败' }));
      return true;
    }
    if (message?.type === 'COLLECT_HISTORY_SAMPLES') {
      sendResponse(collectHistorySamples(message.maxSessions, message.maxTurns));
      return false;
    }
    if (message?.type !== 'CONFIG_UPDATED') return false;
    state = { ...state, ...(message.config || {}) };
    if (message.config?.workspaceToken) globalCircuitUntil = 0;
    if (!state.enabled || state.runMode !== 'full_auto') { state.fullAutoArmedAt = 0; state.operatorAway = false; }
    syncDockFromState();
    abortPendingRequest('popup_config_changed');
    if (state.enabled && state.runMode === 'copilot') scheduleSense(80);
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    ['enabled', 'onboardingComplete', 'runMode', 'timeScope', 'fullAutoArmedAt', 'operatorAway', 'repliedCount', 'leadsCount', 'statsDate', 'bridgeUrl', 'workspaceToken', 'accountId', 'knowledgeScope', 'configVersion', 'modelBaseUrl', 'modelName', 'modelApiKey', 'embeddingBaseUrl', 'embeddingModel', 'embeddingApiKey', 'feishuAppId', 'feishuAppSecret', 'monitor', 'processedMap', 'hourlySendTimestamps', 'uncertainSendMap', 'autoReplyMaxAgeMinutes', 'contactBlacklist'].forEach(key => {
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
      document.removeEventListener('input', onTextareaInput, true);
      document.getElementById('xhs-reply-dock-root')?.remove();
    }
  };
  window.__XHS_REPLY_V11__ = publicApi;
  // 保留旧调试入口，避免已有 QA 脚本因升级失效。
  window.__XHS_REPLY_V10__ = publicApi;

  initialize().catch(error => console.error('[XHS Reply] initialization failed', error));
})();
