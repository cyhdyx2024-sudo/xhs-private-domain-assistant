import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const safety = require('./safety.js');

assert.equal(safety.retryDelayMs(401), Infinity);
assert.equal(safety.retryDelayMs(500, 1), 60_000);
assert.equal(safety.retryDelayMs(500, 2), 120_000);

const now = Date.parse('2026-08-29T12:00:00+08:00');
assert.equal(safety.messageAgeDecision(now - 30 * 60_000, now).action, 'auto');
assert.equal(safety.messageAgeDecision(now - 3 * 60 * 60_000, now).action, 'manual');
assert.equal(safety.messageAgeDecision(now - 25 * 60 * 60_000, now).action, 'skip');
assert.equal(safety.messageAgeDecision(0, now).action, 'manual');
assert.equal(safety.parseMessageTimestamp('2026-08-29 10:30:00', new Date(now)), Date.parse('2026-08-29T10:30:00+08:00'));
assert.equal(safety.parseMessageTimestamp('昨天 10:30', new Date(now)), Date.parse('2026-08-28T10:30:00+08:00'));
assert.equal(safety.parseMessageTimestamp('08-29 10:30', new Date(now)), Date.parse('2026-08-29T10:30:00+08:00'));

assert.equal(safety.isExcludedContact('用户已注销', '[超时未回复]'), true);
assert.equal(safety.isExcludedContact('平台系统通知', ''), true);
assert.equal(safety.isExcludedContact('正常客户', '', ['正常客户']), true);
assert.equal(safety.isExcludedContact('正常客户', '想了解产品'), false);

assert.deepEqual(
  safety.normalizeDailyStats({ statsDate: '2026-08-28', repliedCount: 9, leadsCount: 3 }, new Date('2026-08-29T08:00:00+08:00')),
  { statsDate: '2026-08-29', repliedCount: 0, leadsCount: 0 }
);

console.log('extension safety: ok');
