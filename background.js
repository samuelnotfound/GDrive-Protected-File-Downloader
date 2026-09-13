chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    const url = new URL(tab.url || "");
    if (url.hostname !== "drive.google.com" || !/^\/file(?:\/|$)/.test(url.pathname)) return;
  } catch (_) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      files: ["content.js"]
    });
  } catch (_) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {type: "openOverlay"});
  } catch (_) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, {type: "openOverlay"}).catch(() => {});
    }, 150);
  }
});
