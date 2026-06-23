#!/usr/bin/env node
// Tests SERVER-OUTPUT capture for the sidecar and visual-diff dev servers.
//
// Covers (pure Node — no Electron):
//   1. LogSink: append writes prefixed lines to its file, entries[] is
//      structured, logBus emits, getLogDir() honors DEEP_DIFF_LOG_DIR, and
//      retention prunes the oldest run logs beyond the cap.
//   2. launchSidecar exposes status.logFile, and the file captures the dev
//      server's stdout tagged [sidecar] [stdout].
//
// The visual diff loads pages in an Electron BrowserWindow, so visualDiff.js
// imports `electron` and can't be imported in pure Node — its log file
// (base/target labeling) and the rendered-page browser console are both
// asserted under real Electron in scripts/test-server-console.cjs. The sidecar
// webview->logs:append path is covered by the app / manual agent-browser.
//
// Requires dist-electron/ built (pnpm run build:electron) + pnpm run setup:fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const repoPath = path.join(projectRoot, 'mock-workspace', 'storefront-auth0');

// Dedicated, readable log dir for this run (set before importing serverLogs so
// getLogDir() picks it up; the modules read it lazily at LogSink creation).
const logDir = path.join(os.tmpdir(), `deep-diff-logs-test-${Date.now()}`);
process.env.DEEP_DIFF_LOG_DIR = logDir;

const { LogSink, getLogDir, logBus } = await import('../dist-electron/serverLogs.js');
const { launchSidecar, stopSidecar, appendSidecarConsole } =
  await import('../dist-electron/sidecar.js');

let failures = 0;
const pass = (label, detail = '') => console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
};
const assert = (cond, label, detail) => (cond ? pass(label, detail) : fail(label, detail));

// LogSink writes through an async WriteStream, so the file may lag a sync read by
// a tick. Poll until it has content before asserting on it.
async function readFileEventually(file, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > 0) return text;
    } catch {
      // not flushed yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Log file never materialized: ${file}`);
}

async function waitForLogLine(file, re, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (re.test(fs.readFileSync(file, 'utf8'))) return true;
    } catch {
      // not flushed yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function waitForReady(url, probePath = '/api/health', timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(new URL(probePath, url));
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function cleanupLeaks() {
  // runVisualDiff cleans worktrees fire-and-forget; a short-lived runner must
  // prune leftovers itself (CLAUDE.md). The grandchild dev server is `node
  // server.mjs ...`, not the pnpm wrapper, so target it directly.
  try {
    execSync("pkill -f 'server.mjs --'", { stdio: 'ignore' });
  } catch {
    // none running
  }
  try {
    execSync(`git -C "${repoPath}" worktree prune`, { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

// ── 1. LogSink unit ─────────────────────────────────────────────────────────
async function testLogSinkUnit() {
  assert(getLogDir() === logDir, 'getLogDir() honors DEEP_DIFF_LOG_DIR', getLogDir());

  const emitted = [];
  const onEntry = (entry) => emitted.push(entry);
  logBus.on('entry', onEntry);

  const sink = new LogSink('unit1', 'diff', `diff-${Date.now()}.log`);
  sink.append('base', 'stdout', 'first line\nsecond line\n');
  sink.append('base', 'stdout', 'partial '); // held in carry until newline
  sink.append('base', 'stdout', 'completed\n');
  sink.system('target', 'server ready http://x');
  sink.close();
  logBus.off('entry', onEntry);

  assert(
    sink.entries.length === 4,
    'append splits chunks into structured line entries',
    `count=${sink.entries.length}`,
  );
  assert(
    sink.entries[0].server === 'base' && sink.entries[0].stream === 'stdout',
    'entry carries server + stream',
  );
  assert(
    sink.entries.some((e) => e.text === 'partial completed'),
    'carry buffer joins a line split across chunks',
  );
  assert(
    emitted.length === 4,
    'logBus emits one event per recorded line',
    `emitted=${emitted.length}`,
  );

  const fileText = await readFileEventually(sink.file);
  assert(/\[base\] \[stdout\] first line/.test(fileText), 'file line is prefixed [base] [stdout]');
  assert(
    /\[target\] \[system\] server ready/.test(fileText),
    'system annotations are written + tagged',
  );
}

// ── retention: oldest run logs pruned beyond the cap ─────────────────────────
function testRetention() {
  // Seed 30 stale run logs with increasing mtimes, then a new sink should prune
  // down so only the most recent remain (cap is 25 inside serverLogs.ts).
  const seeded = [];
  for (let i = 0; i < 30; i += 1) {
    const f = path.join(logDir, `diff-1000${String(i).padStart(2, '0')}.log`);
    fs.writeFileSync(f, 'x');
    const t = new Date(Date.now() - (30 - i) * 60_000); // older first
    fs.utimesSync(f, t, t);
    seeded.push(f);
  }
  const oldest = seeded[0];
  new LogSink('retention', 'sidecar', `sidecar-${Date.now()}.log`);
  const remaining = fs.readdirSync(logDir).filter((f) => /^(diff|sidecar)-\d+\.log$/.test(f));
  assert(
    remaining.length <= 26,
    'retention keeps logs at/under the cap (+ the new one)',
    `n=${remaining.length}`,
  );
  assert(!fs.existsSync(oldest), 'retention deletes the oldest run log');
}

// ── 2. sidecar: status.logFile captures server stdout ────────────────────────
async function testSidecarLogFile() {
  const sidecar = await launchSidecar({ repoPath, branch: 'main' });
  try {
    assert(Boolean(sidecar.logFile), 'launchSidecar returns status.logFile', sidecar.logFile);
    assert(sidecar.logFile && fs.existsSync(sidecar.logFile), 'sidecar log file exists on disk');
    await waitForReady(sidecar.url);
    await new Promise((r) => setTimeout(r, 400)); // let boot output flush
    const text = await readFileEventually(sidecar.logFile);
    assert(
      /\[sidecar\] \[system\] launching:/.test(text),
      'sidecar log records the launch command',
    );
    assert(/\[sidecar\] \[stdout\]/.test(text), "sidecar log captures the dev server's stdout");

    // Main-process half of the sidecar webview→`logs:append` console path: the
    // `logs:append` IPC handler calls appendSidecarConsole, which must land in the
    // running sidecar's log as a [sidecar] [console:<level>] line. (The webview DOM
    // event → bridge.appendLog hop is renderer-only; not reachable from Node here.)
    appendSidecarConsole('[dds-probe] from preview page', 'error');
    const sawConsole = await waitForLogLine(
      sidecar.logFile,
      /\[sidecar\] \[console:error\] \[dds-probe\] from preview page/,
    );
    assert(sawConsole, 'appendSidecarConsole writes a [sidecar] [console:error] line to the log');
  } finally {
    stopSidecar();
  }
}

async function main() {
  console.log('Deep Diff — server log capture test');
  console.log(`Log dir: ${logDir}`);
  try {
    await testLogSinkUnit();
    testRetention();
    await testSidecarLogFile();
  } finally {
    cleanupLeaks();
  }
  console.log(
    failures === 0 ? '\nALL SERVER LOG TESTS PASSED' : `\n${failures} ASSERTION(S) FAILED`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(
    'Unhandled error:',
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  cleanupLeaks();
  process.exitCode = 1;
});
