// Shared utilities kept dependency-free so the extension can adopt them incrementally.
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const formatBytes = bytes => { const n = Number(bytes) || 0; if (n < 1024) return `${n} B`; const units = ['KB','MB','GB','TB']; let value=n, unit='B'; for (const next of units) { if (value < 1024) break; value /= 1024; unit=next; } const digits=value>=100?0:value>=10?1:2; return `${value.toFixed(digits)} ${unit}`; };
