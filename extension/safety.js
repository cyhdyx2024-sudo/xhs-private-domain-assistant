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

  return {
    HOUR_MS, localDateKey, normalizeDailyStats, retryDelayMs, messageAgeDecision,
    parseMessageTimestamp, isExcludedContact, isHalfTurnTransform, messageBottomState
  };
});
