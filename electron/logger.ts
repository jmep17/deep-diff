/**
 * Minimal timestamped logger for the Electron main process.
 * Logs scope + message/stack only — never logs full request objects
 * to avoid leaking sensitive values (tokens, commands).
 */

export function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[deep-diff] [${scope}] ERROR: ${message}`);
}

export function logInfo(scope: string, msg: string): void {
  console.warn(`[deep-diff] [${scope}] ${msg}`);
}
