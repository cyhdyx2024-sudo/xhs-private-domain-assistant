import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const safety = require('./safety.js');

assert.equal(safety.retryDelayMs(401), Infinity);
assert.equal(safety.retryDelayMs(500, 1), 60_000);
assert.equal(safety.retryDelayMs(500, 2), 120_000);

// 用运行环境本地时区构造期望值，避免 CI（UTC）与开发机（Asia/Shanghai）产生假失败。
const nowDate = new Date(2026, 7, 29, 12, 0, 0);
const now = nowDate.getTime();
assert.equal(safety.messageAgeDecision(now - 30 * 60_000, now).action, 'auto');
assert.equal(safety.messageAgeDecision(now - 3 * 60 * 60_000, now).action, 'manual');
assert.equal(safety.messageAgeDecision(now - 25 * 60 * 60_000, now).action, 'skip');
assert.equal(safety.messageAgeDecision(0, now).action, 'manual');
assert.equal(safety.parseMessageTimestamp('2026-08-29 10:30:00', nowDate), new Date(2026, 7, 29, 10, 30, 0).getTime());
assert.equal(safety.parseMessageTimestamp('昨天 10:30', nowDate), new Date(2026, 7, 28, 10, 30, 0).getTime());
assert.equal(safety.parseMessageTimestamp('08-29 10:30', nowDate), new Date(2026, 7, 29, 10, 30, 0).getTime());

assert.equal(safety.isExcludedContact('用户已注销', '[超时未回复]'), true);
assert.equal(safety.isExcludedContact('平台系统通知', ''), true);
assert.equal(safety.isExcludedContact('正常客户', '', ['正常客户']), true);
assert.equal(safety.isExcludedContact('正常客户', '想了解产品'), false);

assert.deepEqual(
  safety.extractContactLead([
    { role: 'assistant', content: '方便留个微信吗' },
    { role: 'user', content: 'demo_user_01', timestamp: 1788100000000 },
    { role: 'assistant', content: '收到 马上加你 备注小红书了' }
  ]),
  { type: '微信号', value: 'demo_user_01', source: 'context', timestamp: 1788100000000 }
);
assert.equal(safety.extractContactLead([{ role: 'user', content: 'product' }]), null);
assert.deepEqual(
  safety.extractContactLead([{ role: 'user', content: '手机号 13800138000', timestamp: 1788100000000 }]),
  { type: '手机号', value: '13800138000', source: 'direct', timestamp: 1788100000000 }
);

assert.equal(safety.isSameDay(now, now), true);
assert.equal(safety.isSameDay(now - 25 * 60 * 60_000, now), false);

assert.equal(safety.isHalfTurnTransform('matrix(-1, 0, 0, -1, 0, 0)'), true);
assert.equal(safety.isHalfTurnTransform('matrix(1, 0, 0, 1, 0, 0)'), false);
assert.deepEqual(
  safety.messageBottomState({ scrollTop: 0, scrollHeight: 1317, clientHeight: 296, inverted: true }),
  { atBottom: true, targetScrollTop: 0 }
);
assert.deepEqual(
  safety.messageBottomState({ scrollTop: 240, scrollHeight: 1317, clientHeight: 296, inverted: true }),
  { atBottom: false, targetScrollTop: 0 }
);
assert.deepEqual(
  safety.messageBottomState({ scrollTop: 240, scrollHeight: 1317, clientHeight: 296, inverted: false }),
  { atBottom: false, targetScrollTop: 1317 }
);

assert.deepEqual(
  safety.normalizeDailyStats({ statsDate: '2026-08-28', repliedCount: 9, leadsCount: 3 }, new Date('2026-08-29T08:00:00+08:00')),
  { statsDate: '2026-08-29', repliedCount: 0, leadsCount: 0 }
);

assert.equal(safety.shouldAbortLeadSync(1000, 1005), true);
assert.equal(safety.shouldAbortLeadSync(1000, 1000), false);
assert.equal(safety.shouldAbortLeadSync(1000, 995), false);

console.log('extension safety: ok');
