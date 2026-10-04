// ============================================================================
// FILE: src/background.js
// PURPOSE: Root entry point for the Chrome Extension Manifest V3 Service Worker.
//          It loads all background modules into a shared global scope via importScripts.
// ============================================================================

/**
 * importScripts:
 * The standard Web Worker API used in Manifest V3 service workers to import
 * scripts sequentially into the worker's execution context.
 *
 * EXECUTION ORDER MATTERS:
 * 1. config.js: Sets shared storage keys, in-memory Maps, and timeout presets.
 * 2. runtime.js: Utility helpers (sleep, sendTab, sendOffscreen, setBadge).
 * 3. network-capture.js: webRequest listeners intercepting audio/video stream segments.
 * 4. quality-dom.js: Chrome scripting bridge executing DOM quality triggers in tab frames.
 * 5. format-catalog.js: Data structures, itag definitions, sorting, and deduplication logic.
 * 6. video-state.js: Session state management and concurrency-safe storage queues.
 * 7. video-jobs.js: Video download queue, chunk staging, offscreen remux coordination.
 * 8. quality-state.js: Video quality probe tokens and candidate filtering.
 * 9. quality-automation.js: High-level UI automation (clicking Settings -> Quality menu items).
 * 10. quality-scan.js: Polling and stream waiting routines during quality changes.
 * 11. message-router.js: chrome.runtime.onMessage listener routing requests from content/UI scripts.
 * 12. lifecycle.js: Tab navigation, reload detection, and memory/job cleanup handlers.
 *
 * ARCHITECTURAL NOTE / CAN BE WRITTEN IN A BETTER WAY:
 * - Globals vs ES Modules: `importScripts` places all top-level functions and variables
 *   into a shared global scope (`self`), making variable collisions possible and dependencies implicit.
 * - Better way: Migrate to native ES modules by setting `"type": "module"` in manifest.json's
 *   `background` configuration:
 *     "background": {
 *       "service_worker": "src/background.js",
 *       "type": "module"
 *     }
 *   This allows using standard `import { ... } from './background/config.js'` with tree-shaking,
 *   explicit dependencies, and modular encapsulation.
 */
importScripts(
    'background/config.js',
    'background/runtime.js',
    'background/network-capture.js',
    'background/quality-dom.js',
    'background/format-catalog.js',
    'background/video-state.js',
    'background/video-jobs.js',
    'background/quality-state.js',
    'background/quality-automation.js',
    'background/quality-scan.js',
    'background/message-router.js',
    'background/lifecycle.js'
);
