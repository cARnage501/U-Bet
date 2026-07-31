// Runs in the page's MAIN world (declared via manifest "world": "MAIN").
// Read-only network observer: wraps fetch/XHR/WebSocket to time and log
// traffic, then hands raw frames to content.js via a CustomEvent. It never
// rewrites a request, a response, or a header — every original call return
// value is passed through untouched.
(() => {
  const EVENT_NAME = 'ubet:network';
  const MAX_BODY_CHARS = 20000;

  // Only bother capturing calls that look like they could carry bet data.
  // Static assets and analytics beacons are filtered out; anything left
  // over that isn't recognized by the adapter ends up in the "raw" store
  // for manual inspection instead of being silently dropped.
  const SKIP_EXTENSIONS = /\.(js|css|png|jpg|jpeg|svg|gif|webp|woff2?|ttf|ico|map)(\?|$)/i;

  function looksInteresting(url, method) {
    if (SKIP_EXTENSIONS.test(url)) return false;
    if (method === 'GET') {
      return /graphql|api|bet|wager|round|game/i.test(url);
    }
    return true;
  }

  function truncate(text) {
    if (typeof text !== 'string') return text;
    return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}...[truncated]` : text;
  }

  function emit(detail) {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  }

  // --- fetch ---
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = (init?.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
      const submittedAt = Date.now();

      let requestBody = null;
      try {
        requestBody = init?.body && typeof init.body === 'string' ? init.body : null;
      } catch {
        requestBody = null;
      }

      const interesting = looksInteresting(url, method);
      const response = await originalFetch.call(this, input, init);

      if (interesting) {
        const clone = response.clone();
        clone
          .text()
          .then((responseBody) => {
            emit({
              channel: 'fetch',
              url,
              method,
              status: response.status,
              ok: response.ok,
              submittedAt,
              respondedAt: Date.now(),
              requestBody: truncate(requestBody),
              responseBody: truncate(responseBody),
            });
          })
          .catch(() => {});
      }

      return response;
    };
  }

  // --- XMLHttpRequest ---
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const origOpen = OriginalXHR.prototype.open;
    const origSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__ubet = { method: (method || 'GET').toUpperCase(), url };
      return origOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function patchedSend(body) {
      const meta = this.__ubet;
      if (meta) {
        meta.submittedAt = Date.now();
        meta.requestBody = typeof body === 'string' ? body : null;

        if (looksInteresting(meta.url, meta.method)) {
          this.addEventListener('loadend', () => {
            let responseBody = null;
            try {
              responseBody = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
            } catch {
              responseBody = null;
            }
            emit({
              channel: 'xhr',
              url: meta.url,
              method: meta.method,
              status: this.status,
              ok: this.status >= 200 && this.status < 300,
              submittedAt: meta.submittedAt,
              respondedAt: Date.now(),
              requestBody: truncate(meta.requestBody),
              responseBody: truncate(responseBody),
            });
          });
        }
      }
      return origSend.call(this, body);
    };
  }

  // --- WebSocket ---
  const OriginalWebSocket = window.WebSocket;
  if (OriginalWebSocket) {
    function PatchedWebSocket(url, protocols) {
      const ws = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        emit({
          channel: 'ws',
          url: String(url),
          direction: 'in',
          submittedAt: null,
          respondedAt: Date.now(),
          requestBody: null,
          responseBody: truncate(event.data),
        });
      });

      const origSend = ws.send.bind(ws);
      ws.send = (data) => {
        if (typeof data === 'string') {
          emit({
            channel: 'ws',
            url: String(url),
            direction: 'out',
            submittedAt: Date.now(),
            respondedAt: null,
            requestBody: truncate(data),
            responseBody: null,
          });
        }
        return origSend(data);
      };

      return ws;
    }
    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    window.WebSocket = PatchedWebSocket;
  }
})();
