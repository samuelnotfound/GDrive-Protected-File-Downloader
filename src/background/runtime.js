const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const sendTab = async (tabId, message) => {
    if (!Number.isInteger(tabId)) return;
    try {
        await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {}
};

const sendOffscreen = message => {
    try {
        const promise = chrome.runtime.sendMessage({ target: 'video-offscreen', ...message });
        return promise?.catch ? promise.catch(() => {}) : Promise.resolve();
    } catch (_) {
        return Promise.resolve();
    }
};

const setBadge = text => {
    try {
        chrome.action.setBadgeText({ text });
        if (text) chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    } catch (_) {}
};
