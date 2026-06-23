/**
 * Electron-side report sink for the network-capture interceptor.
 *
 * The injected interceptor (electron/inject/captureInterceptor.ts) POSTs each
 * observed JSON response to `dds-capture://capture/record`. A same-origin http
 * POST body can't be read on the host (`webRequest` exposes only a blobUUID), so
 * we use a privileged custom scheme handled via `protocol.handle`, which exposes
 * the request body via `request.text()`.
 *
 * `registerCaptureScheme()` must run before the app `ready` event (scheme
 * privileges are locked in at startup); `attachCaptureSink(session)` is attached
 * to each session that renders captured pages (the sidecar `<webview>` partition
 * and the visual-diff capture window).
 */
import { protocol, type Session } from 'electron';
import { recordCapture } from './mockCapture.js';

export const CAPTURE_SCHEME = 'dds-capture';

let schemeRegistered = false;

/** Register the privileged capture scheme. MUST be called before app `ready`. */
export function registerCaptureScheme(): void {
  if (schemeRegistered) return;
  schemeRegistered = true;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CAPTURE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
      },
    },
  ]);
}

interface CaptureReport {
  method?: string;
  pathname?: string;
  status?: number;
  contentType?: string;
  body?: string;
}

/** Attach the capture report handler to a session that renders captured pages. */
export function attachCaptureSink(session: Session): void {
  // Strip Content-Security-Policy on this session so the interceptor's main-world
  // <script> installs even on targets that forbid inline scripts (`script-src
  // 'self'`) — otherwise CSP blocks the injection and capture silently yields
  // nothing. Scoped to the dedicated, sandboxed, localhost-confined capture
  // sessions only (never the main app window); applied equally to base+target so
  // the visual diff stays deterministic. (Trade-off: a CSP-using target renders
  // here without CSP — visually neutral for the app's own resources.)
  try {
    session.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = details.responseHeaders ?? {};
      for (const name of Object.keys(responseHeaders)) {
        if (/^content-security-policy(-report-only)?$/i.test(name)) {
          delete responseHeaders[name];
        }
      }
      callback({ responseHeaders });
    });
  } catch {
    /* a session may already have an onHeadersReceived listener — best effort */
  }

  try {
    session.protocol.handle(CAPTURE_SCHEME, async (request) => {
      try {
        const report = JSON.parse(await request.text()) as CaptureReport;
        if (report && typeof report.body === 'string') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(report.body);
          } catch {
            parsed = undefined;
          }
          if (parsed !== undefined) {
            recordCapture(
              String(report.method ?? 'GET'),
              String(report.pathname ?? '/'),
              Number(report.status ?? 0),
              String(report.contentType ?? ''),
              parsed,
            );
          }
        }
      } catch {
        /* ignore malformed reports — capture is best-effort */
      }
      return new Response(null, { status: 204 });
    });
  } catch {
    // `protocol.handle` throws if the scheme is already handled on this session;
    // attaching is idempotent, so ignore.
  }
}
