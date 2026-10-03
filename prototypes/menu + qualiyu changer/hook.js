// Runs in the page's own world (manifest: world MAIN, document_start) so it can wrap
// fetch/XHR before Drive's scripts do. Only the list of resolutions is exposed;
// the stream data itself stays private to this closure.
(() => {
  const LABEL = {
    18: 360, 22: 720, 37: 1080, 59: 480,
    133: 240, 134: 360, 135: 480, 136: 720, 137: 1080, 160: 144,
    242: 240, 243: 360, 244: 480, 247: 720, 248: 1080, 278: 144,
    264: 1440, 266: 2160, 271: 1440, 298: 720, 299: 1080, 313: 2160,
  };
  const PLAYBACK = /workspacevideo\S*\/media\/([\w-]+)\/playback/;
  const FILE_ID = /\/d\/([\w-]+)|[?&]id=([\w-]+)/;
  const playback = {};

  const parse = (text) => {
    try {
      return JSON.parse(text.replace(/^\)\]\}'/, '')); // Google's anti-XSSI prefix
    } catch {
      return null;
    }
  };

  const store = (id, json) => {
    if (!json?.mediaStreamingData) return;
    playback[id] = json;
    window.dispatchEvent(new Event('gdq:playback')); // menu.js refreshes its rows
  };

  window.__gdq = {
    labels() {
      const id = location.href.match(FILE_ID)?.slice(1).find(Boolean);
      const { adaptiveTranscodes = [], progressiveTranscodes = [] } =
        playback[id]?.mediaStreamingData?.formatStreamingData ?? {};
      const heights = new Set(
        [...adaptiveTranscodes, ...progressiveTranscodes]
          .filter((t) => t.transcodeMetadata?.height)
          .map((t) => LABEL[t.itag] || t.transcodeMetadata.height)
      );
      return [...heights].sort((a, b) => b - a);
    },
  };

  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await nativeFetch.apply(this, args);
    const id = res.url.match(PLAYBACK)?.[1];
    if (id) res.clone().text().then((text) => store(id, parse(text)), () => {});
    return res;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const id = String(url).match(PLAYBACK)?.[1];
    if (id) {
      this.addEventListener('load', () => {
        const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
        store(id, this.responseType === 'json' ? this.response : parse(text));
      });
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
})();
