/**
 * Drive downloader background service worker entry point.
 *
 * Modules remain classic scripts so the existing global function contract is
 * preserved while responsibilities are separated by domain.
 */
importScripts(
    'background/config.js',
    'background/network-capture.js',
    'background/drive-automation.js',
    'background/format-catalog.js',
    'background/video-state.js',
    'background/video-jobs.js',
    'background/quality-state.js',
    'background/legacy-quality-detection.js',
    'background/quality-automation.js',
    'background/quality-scan.js',
    'background/message-router.js',
    'background/lifecycle.js'
);

console.log('[GDrive SW] Refactored background initialized.');
