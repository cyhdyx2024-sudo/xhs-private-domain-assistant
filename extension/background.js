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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    // Open full-page onboarding dashboard upon installation
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});
