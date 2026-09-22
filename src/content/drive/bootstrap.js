(() => {
    if (!window.__PSD || window.__PSD_BOOTSTRAPPED) return;
    window.__PSD_BOOTSTRAPPED = true;
    window.__PSD.init?.();
})();
