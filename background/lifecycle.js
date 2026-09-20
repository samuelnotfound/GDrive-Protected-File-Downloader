// Background lifecycle and runtime event wiring.

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo?.status !== 'loading') return;
    clearStoredSession(tabId).catch(() => {});
    setBadge('');
});

chrome.tabs.onRemoved.addListener(tabId => {
    clearStoredSession(tabId).catch(() => {});
});

