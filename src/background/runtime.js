const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const sendTab = async (tabId, message) => {
    if (!Number.isInteger(tabId)) return;
    try {
        await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {}
};

const sendOffscreen = message => {
    try {
        chrome.runtime.sendMessage({ target: 'video-offscreen', ...message }).catch?.(() => {});
    } catch (_) {}
};

const setBadge = text => {
    try {
        chrome.action.setBadgeText({ text });
        if (text) chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    } catch (_) {}
};
