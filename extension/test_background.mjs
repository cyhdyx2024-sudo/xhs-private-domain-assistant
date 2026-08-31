import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let onMessage = null;
const chrome = {
  runtime: {
    onMessage: { addListener(fn) { onMessage = fn; } },
    onInstalled: { addListener() {} },
    getURL(path) { return path; }
  },
  tabs: { create() {} }
};

vm.runInNewContext(fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8'), {
  chrome, Map, Date, Math, Number, String
});
assert.equal(typeof onMessage, 'function');

function send(message, tabId) {
  let result;
  onMessage(message, { tab: { id: tabId }, frameId: 0 }, response => { result = response; });
  return result;
}

assert.equal(send({ type: 'ACQUIRE_SEND_LEASE', key: 'session:a' }, 1).acquired, true);
assert.equal(send({ type: 'ACQUIRE_SEND_LEASE', key: 'session:a' }, 2).acquired, false);
assert.equal(send({ type: 'RELEASE_SEND_LEASE', key: 'session:a' }, 2).released, false);
assert.equal(send({ type: 'RELEASE_SEND_LEASE', key: 'session:a' }, 1).released, true);
assert.equal(send({ type: 'ACQUIRE_SEND_LEASE', key: 'session:a' }, 2).acquired, true);
assert.equal(send({ type: 'ACQUIRE_SEND_LEASE', key: '' }, 2).acquired, false);

console.log('background lease: ok');
