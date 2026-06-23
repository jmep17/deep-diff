/**
 * Server-log capture for the sidecar and visual-diff dev servers.
 *
 * A `LogSink` owns one run's log file plus an in-memory (capped) entry buffer,
 * and re-emits every captured line on `logBus` so the main process can stream it
 * to the renderer's log drawer. The file on disk is the durable "entirety"; the
 * in-memory buffer is a bounded snapshot used for the report payload and the UI.
 *
 * This module is deliberately Electron-free so the integration scripts can drive
 * the core modules (sidecar.ts / visualDiff.ts) directly from `dist-electron/`
 * without an Electron app. The renderer-facing fan-out (logBus -> webContents.send)
 * lives in main.ts, the only place that touches Electron windows.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LogSource = 'diff' | 'sidecar';
export type LogServer = 'base' | 'target' | 'sidecar';
export type LogStream = 'stdout' | 'stderr' | 'console' | 'install' | 'system' | 'network';

export interface ServerLogEntry {
  /** Per-run id (Date.now() string) — groups lines from one launch / diff run. */
  runId: string;
  source: LogSource;
  /** Which dev server the line came from. 'base'/'target' for a diff; 'sidecar' otherwise. */
  server: LogServer;
  stream: LogStream;
  /** Console level ('log' | 'info' | 'warning' | 'error') for `stream: 'console'`. */
  level?: string;
  ts: number;
  text: string;
}

/**
 * Emits `'entry'` (a `ServerLogEntry`) for every captured line. `main.ts`
 * subscribes once and forwards to the renderer; integration scripts can ignore it.
 */
export const logBus = new EventEmitter();
// main subscribes once, but tests/harnesses may add their own listeners across
// reloads — disable the 10-listener warning rather than leak a false positive.
logBus.setMaxListeners(0);

const MAX_ENTRIES = 2000; // in-memory snapshot cap (the file on disk stays unbounded)
const MAX_LOG_FILES = 25; // retention: keep only the most recent N run logs on disk

/**
 * Directory the run logs are written to. Resolves from `DEEP_DIFF_LOG_DIR` (set
 * by main.ts to the app's userData/logs) with an `os.tmpdir()` fallback so
 * direct-call scripts work without an Electron app.
 */
export function getLogDir(): string {
  return process.env.DEEP_DIFF_LOG_DIR || path.join(os.tmpdir(), 'deep-diff-logs');
}

/** Map an Electron console-message level (number or string) to a stable name. */
export function levelName(level: number | string | undefined): string | undefined {
  if (typeof level === 'string') return level || undefined;
  switch (level) {
    case 0:
      return 'log';
    case 1:
      return 'info';
    case 2:
      return 'warning';
    case 3:
      return 'error';
    default:
      return undefined;
  }
}

/** Delete the oldest deep-diff run logs, keeping the most recent N. Best-effort. */
function pruneOldLogs(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^(diff|sidecar)-\d+\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(MAX_LOG_FILES)) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    // Ignore retention failures — they must never break a run.
  }
}

/** A minimal structural type for the bit of Electron's WebContents we use. */
interface ConsoleEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'console-message', listener: (...args: any[]) => void): void;
}

/**
 * Forward a page's browser-console messages into `sink`, tagged with the server
 * `getServer()` resolves to at the moment the message fires (so a single capture
 * window shared across base/target attributes each message correctly).
 *
 * Electron's `console-message` arg shape changed across versions — handle both
 * the legacy `(event, level, message, line, sourceId)` tuple and the newer
 * single-details-object form.
 */
export function attachConsoleCapture(
  webContents: ConsoleEmitter,
  getServer: () => LogServer,
  sink: LogSink,
): void {
  webContents.on('console-message', (...args: unknown[]) => {
    let level: number | string | undefined;
    let message: string;
    const first = args[0];
    if (first && typeof first === 'object' && 'message' in first) {
      const details = first as { level?: number | string; message?: unknown };
      level = details.level;
      message = String(details.message ?? '');
    } else {
      level = args[1] as number | string | undefined;
      message = String(args[2] ?? '');
    }
    sink.append(getServer(), 'console', message, levelName(level));
  });
}

export class LogSink {
  readonly file: string;
  readonly entries: ServerLogEntry[] = [];
  private stream: fs.WriteStream;
  /** Partial trailing line per `server|stream`, joined with the next chunk. */
  private carry = new Map<string, string>();

  constructor(
    readonly runId: string,
    readonly source: LogSource,
    fileName: string,
  ) {
    const dir = getLogDir();
    fs.mkdirSync(dir, { recursive: true });
    pruneOldLogs(dir);
    this.file = path.join(dir, fileName);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
  }

  /**
   * Append output for a server. `text` may be a multi-line stdout/stderr chunk
   * or a single console/system message. stdout/stderr chunks keep a per-stream
   * carry buffer so a token split across two chunks isn't broken mid-line;
   * console/system messages flush in full.
   */
  append(server: LogServer, stream: LogStream, text: string, level?: string): void {
    const streaming = stream === 'stdout' || stream === 'stderr';
    const key = `${server}|${stream}`;
    const buffered = (this.carry.get(key) ?? '') + text.replace(/\r/g, '');
    const parts = buffered.split('\n');
    // For streaming output the final segment has no trailing newline yet — hold
    // it back as carry. For one-shot messages flush everything.
    this.carry.set(key, streaming ? (parts.pop() ?? '') : '');
    for (const line of parts) {
      if (line.trim()) this.record(server, stream, line, level);
    }
  }

  /** Record a single, already-split line. */
  private record(server: LogServer, stream: LogStream, line: string, level?: string): void {
    const entry: ServerLogEntry = {
      runId: this.runId,
      source: this.source,
      server,
      stream,
      level,
      ts: Date.now(),
      text: line,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    const tag = level ? `${stream}:${level}` : stream;
    try {
      this.stream.write(`${new Date(entry.ts).toISOString()} [${server}] [${tag}] ${line}\n`);
    } catch {
      // Never break a run because a log write failed.
    }
    logBus.emit('entry', entry);
  }

  /** A Deep Diff annotation (spawn command, "server ready", exit code, …). */
  system(server: LogServer, text: string): void {
    this.record(server, 'system', text);
  }

  /** A bounded snapshot of the captured entries, for the report payload. */
  snapshot(): ServerLogEntry[] {
    return [...this.entries];
  }

  close(): void {
    // Flush any partial lines still held in the carry buffers.
    for (const [key, partial] of this.carry) {
      if (partial.trim()) {
        const [server, stream] = key.split('|') as [LogServer, LogStream];
        this.record(server, stream, partial);
      }
    }
    this.carry.clear();
    try {
      this.stream.end();
    } catch {
      // Ignore.
    }
  }
}
