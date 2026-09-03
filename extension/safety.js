(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.XhsSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HOUR_MS = 60 * 60 * 1000;

  function localDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function normalizeDailyStats(values, now = new Date()) {
    const statsDate = localDateKey(now);
    if (values?.statsDate === statsDate) {
      return { statsDate, repliedCount: Number(values.repliedCount || 0), leadsCount: Number(values.leadsCount || 0) };
    }
    return { statsDate, repliedCount: 0, leadsCount: 0 };
  }

  function isSameDay(t1, t2 = Date.now()) {
    if (!t1) return false;
    const d1 = new Date(Number(t1));
    const d2 = new Date(Number(t2));
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  }

  function retryDelayMs(status, failureCount = 1) {
    if (status === 401 || status === 403) return Infinity;
    const count = Math.max(1, Number(failureCount || 1));
    if (status === 429 || status >= 500 || status === 0) {
      return Math.min(15 * 60 * 1000, 60 * 1000 * Math.pow(2, Math.min(count - 1, 4)));
    }
    return 60 * 1000;
  }

  function messageAgeDecision(timestamp, now = Date.now(), autoMaxAgeMs = 2 * HOUR_MS) {
    const value = Number(timestamp || 0);
    if (!value || value > now + 5 * 60 * 1000) return { action: 'manual', reason: '无法确认消息时间' };
    const ageMs = Math.max(0, now - value);
    if (ageMs <= autoMaxAgeMs) return { action: 'auto', ageMs };
    if (ageMs <= 24 * HOUR_MS) return { action: 'manual', ageMs, reason: '消息已超过自动回复时限' };
    return { action: 'skip', ageMs, reason: '消息已超过 24 小时' };
  }

  function parseMessageTimestamp(text, now = new Date()) {
    const value = String(text || '').replace(/\s+/g, ' ');
    let match = value.match(/(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\s+([0-2]?\d):([0-5]\d)(?::([0-5]\d))?/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0)).getTime();
    match = value.match(/(?:^|\s)([01]?\d)[-/]([0-3]?\d)\s+([0-2]?\d):([0-5]\d)/);
    if (match) return new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]), Number(match[3]), Number(match[4])).getTime();
    match = value.match(/(今天|昨天)?\s*([0-2]?\d):([0-5]\d)/);
    if (!match) return 0;
    const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[2]), Number(match[3]));
    if (match[1] === '昨天' || (!match[1] && result.getTime() > now.getTime() + 5 * 60 * 1000)) result.setDate(result.getDate() - 1);
    return result.getTime();
  }

  function isExcludedContact(name, cardText, blacklist = []) {
    const value = `${name || ''} ${cardText || ''}`.replace(/\s+/g, ' ').trim();
    if (/用户已注销|账号已注销|平台系统通知|系统通知|企业员工|官方客服/.test(value)) return true;
    return (blacklist || []).some(item => item && value.includes(String(item).trim()));
  }

  function extractContactLead(turns = [], platformLeadHint = false) {
    const items = Array.isArray(turns) ? turns : [];
    const directPattern = /(?:微信号?|vx|wx)[\s:：_\-]*([a-z][a-z0-9_-]{5,19}|1[3-9]\d{9})/i;
    const contactCue = /微信|手机号|手机号码|电话|联系方式|加你|加您|加我|添加|好友|备注小红书|留个.{0,4}(?:号|联系)/i;
    for (const turn of items) {
      if (turn?.role !== 'user') continue;
      const text = String(turn.content || '').replace(/\s+/g, ' ').trim();
      const phone = text.match(/(?:1[3-9]\d{9})/);
      if (phone) return { type: '手机号', value: phone[0], source: 'direct', timestamp: Number(turn.timestamp || 0) };
      const wechat = text.match(directPattern);
      if (wechat) return { type: '微信号', value: wechat[1] || wechat[0], source: 'direct', timestamp: Number(turn.timestamp || 0) };
    }
    for (let index = 0; index < items.length; index += 1) {
      const turn = items[index];
      if (turn?.role !== 'user') continue;
      const text = String(turn.content || '').trim();
      // 纯微信号只有在平台已标记留资，或相邻对话明确谈到加联系方式时才识别，避免把普通英文误当客资。
      if (!/^[a-z][a-z0-9_-]{5,19}$/i.test(text) || !/[0-9_-]/.test(text)) continue;
      const nearby = items.slice(Math.max(0, index - 2), index + 3)
        .filter((item, nearbyIndex) => item !== turn && (item?.role === 'assistant' || nearbyIndex >= 0))
        .map(item => String(item?.content || ''))
        .join(' ');
      if (platformLeadHint || contactCue.test(nearby)) return { type: '微信号', value: text, source: 'context', timestamp: Number(turn.timestamp || 0) };
    }
    return null;
  }

  function isHalfTurnTransform(transform) {
    const value = String(transform || '').trim();
    if (!value || value === 'none') return false;
    const matrix = value.match(/^matrix\(\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)/i);
    if (matrix) return Number(matrix[1]) < -0.9 && Number(matrix[4]) < -0.9;
    const matrix3d = value.match(/^matrix3d\(([^)]+)\)/i);
    if (!matrix3d) return false;
    const values = matrix3d[1].split(',').map(Number);
    return values.length === 16 && values[0] < -0.9 && values[5] < -0.9;
  }

  function messageBottomState({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, inverted = false } = {}) {
    // 小红书消息区目前通过父容器 rotate(180deg) 实现倒序列表：此时 0 才是最新消息。
    if (inverted) return { atBottom: Math.abs(Number(scrollTop || 0)) <= 8, targetScrollTop: 0 };
    const remaining = Number(scrollHeight || 0) - Number(scrollTop || 0) - Number(clientHeight || 0);
    return { atBottom: remaining <= 8, targetScrollTop: Number(scrollHeight || 0) };
  }

  function shouldAbortLeadSync(syncStartedAt = 0, lastUserActivityAt = 0) {
    return Number(lastUserActivityAt || 0) > Number(syncStartedAt || 0);
  }

  return {
    HOUR_MS, localDateKey, normalizeDailyStats, isSameDay, retryDelayMs, messageAgeDecision,
    parseMessageTimestamp, isExcludedContact, extractContactLead, isHalfTurnTransform, messageBottomState,
    shouldAbortLeadSync
  };
});
