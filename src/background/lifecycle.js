
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo?.status !== 'loading') return;
    clearStoredSession(tabId).catch(() => {});
    clearStreamCaptureState(tabId);
    setBadge('');
});

chrome.tabs.onRemoved.addListener(tabId => {
    clearStoredSession(tabId).catch(() => {});
    clearStreamCaptureState(tabId);
});

