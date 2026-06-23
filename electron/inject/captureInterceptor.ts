/**
 * Injected into the MAIN world of every captured page (the sidecar <webview>
 * and the visual-diff capture BrowserWindow). Patches `fetch` + `XMLHttpRequest`
 * to OBSERVE every JSON response, then reports a compact record to the host over
 * a privileged custom scheme (`dds-capture://`) that the host handles via
 * `protocol.handle` (the only channel that reliably exposes the POST body —
 * `webRequest` surfaces fetch/XHR bodies only as an unreadable blobUUID).
 *
 * Observe-only: it never substitutes a response, so it cannot perturb what the
 * page receives — that keeps visual-diff determinism intact (serving mocks is
 * the proxy/protocol.handle's job, not ours).
 *
 * Hand-rolled rather than using @mswjs/interceptors: that library builds the
 * observed Response from `xhr.response`, so a `responseType:'json'` XHR (which is
 * axios's DEFAULT) yields a `"[object Object]"` body. We read the body per
 * `responseType` instead, which is the whole point — getting the real bytes.
 *
 * Browser-targeted (DOM globals); excluded from the Node tsconfig and bundled to
 * an IIFE by `scripts/build-capture-inject.mjs`, then embedded into the preload.
 */
declare global {
  interface Window {
    __ddsCaptureInstalled?: boolean;
  }
}

const CAPTURE_SCHEME = 'dds-capture:';
const CAPTURE_URL = 'dds-capture://capture/record';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const META = Symbol('ddsCapture');

type XhrMeta = { method: string; url: string };

function isJsonContentType(ct: string): boolean {
  return /\bjson\b/i.test(ct);
}

function shouldReport(
  status: number,
  contentType: string,
  bodyText: string | null,
): bodyText is string {
  return (
    status >= 200 &&
    status < 300 &&
    isJsonContentType(contentType) &&
    typeof bodyText === 'string' &&
    bodyText.length > 0 &&
    bodyText.length <= MAX_BODY_BYTES
  );
}

function install(): void {
  if (window.__ddsCaptureInstalled) return;
  window.__ddsCaptureInstalled = true;

  // Capture the pristine fetch before patching, and report through it, so our
  // own report POSTs are never re-observed.
  const origFetch: typeof fetch = window.fetch.bind(window);

  function report(
    method: string,
    url: string,
    status: number,
    contentType: string,
    bodyText: string,
  ): void {
    try {
      if (url.startsWith(CAPTURE_SCHEME)) return;
      void origFetch(CAPTURE_URL, {
        method: 'POST',
        mode: 'no-cors',
        cache: 'no-store',
        body: JSON.stringify({
          method,
          url,
          pathname: new URL(url, location.href).pathname,
          status,
          contentType,
          body: bodyText,
        }),
      }).catch(() => undefined);
    } catch {
      /* best effort — capture must never break the page */
    }
  }

  // ---- fetch --------------------------------------------------------------
  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const promise = origFetch(input as RequestInfo, init);
    try {
      let method = 'GET';
      let url = '';
      if (typeof input === 'string') url = input;
      else if (input instanceof URL) url = input.href;
      else if (input && typeof (input as Request).url === 'string') {
        url = (input as Request).url;
        method = (input as Request).method || method;
      }
      if (init && init.method) method = init.method;
      if (!url.startsWith(CAPTURE_SCHEME)) {
        void promise
          .then(async (response) => {
            try {
              const ct = response.headers.get('content-type') ?? '';
              if (response.status < 200 || response.status >= 300 || !isJsonContentType(ct)) return;
              const text = await response.clone().text();
              if (shouldReport(response.status, ct, text)) {
                report(
                  method.toUpperCase(),
                  new URL(url, location.href).href,
                  response.status,
                  ct,
                  text,
                );
              }
            } catch {
              /* ignore */
            }
          })
          .catch(() => undefined);
      }
    } catch {
      /* never let observation break the call */
    }
    return promise;
  };

  // ---- XMLHttpRequest -----------------------------------------------------
  const XHRProto = XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;

  function xhrBodyText(xhr: XMLHttpRequest): string | null {
    const rt = xhr.responseType;
    // Read per responseType: the spec forbids `responseText` unless the type is
    // "" or "text", and for "json" the raw bytes are gone, so re-serialize.
    if (rt === '' || rt === 'text') {
      return typeof xhr.responseText === 'string' ? xhr.responseText : null;
    }
    if (rt === 'json') {
      try {
        return JSON.stringify(xhr.response);
      } catch {
        return null;
      }
    }
    return null; // blob / arraybuffer / document — not captured
  }

  XHRProto.open = function open(this: XMLHttpRequest, method: string, url: string | URL) {
    try {
      (this as unknown as Record<symbol, XhrMeta>)[META] = {
        method: String(method || 'GET'),
        url: typeof url === 'string' ? url : url.href,
      };
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line prefer-rest-params
    return origOpen.apply(this, arguments as never);
  };

  XHRProto.send = function send(this: XMLHttpRequest) {
    try {
      const meta = (this as unknown as Record<symbol, XhrMeta>)[META];
      if (meta && !meta.url.startsWith(CAPTURE_SCHEME)) {
        this.addEventListener('loadend', () => {
          try {
            const ct = this.getResponseHeader('content-type') ?? '';
            if (this.status < 200 || this.status >= 300 || !isJsonContentType(ct)) return;
            const text = xhrBodyText(this);
            if (shouldReport(this.status, ct, text)) {
              report(
                meta.method.toUpperCase(),
                new URL(meta.url, location.href).href,
                this.status,
                ct,
                text,
              );
            }
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line prefer-rest-params
    return origSend.apply(this, arguments as never);
  };
}

install();

export {};
