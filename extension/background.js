// Background Service Worker for XHS Auto-Reply Pro
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    // Open full-page onboarding dashboard upon installation
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});
