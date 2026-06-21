#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAuth0Config } from '../dist-electron/authConfigDetector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../mock-repositories/auth0-routes-fixture');

function pass(label, detail = '') {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, error) {
  console.error(`FAIL  ${label}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}

function assert(condition, label, detail) {
  if (condition) pass(label, detail);
  else fail(label, new Error(detail ?? 'Assertion failed'));
}

// Test 1: fixture with .env containing AUTH0_BASE_URL → detected
try {
  const detected = await detectAuth0Config(fixturePath);
  assert(detected === true, 'detectAuth0Config: fixture .env with AUTH0_BASE_URL → detected');
} catch (err) {
  fail('detectAuth0Config: fixture .env with AUTH0_BASE_URL → detected', err);
}

// Test 2: plain repo without Auth0 env keys → not detected
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth0-detector-test-'));
try {
  fs.writeFileSync(path.join(tmpDir, '.env'), 'PORT=3000\nNODE_ENV=development\n');
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'plain', scripts: { dev: 'node server.js' } }),
  );
  const detected = await detectAuth0Config(tmpDir);
  assert(detected === false, 'detectAuth0Config: plain repo with no Auth0 keys → not detected');
} catch (err) {
  fail('detectAuth0Config: plain repo with no Auth0 keys → not detected', err);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Test 3: package.json with @auth0/nextjs-auth0 dep → detected via package.json
const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'auth0-detector-pkg-test-'));
try {
  fs.writeFileSync(
    path.join(tmpDir2, 'package.json'),
    JSON.stringify({ name: 'auth-app', dependencies: { '@auth0/nextjs-auth0': '^4.0.0' } }),
  );
  const detected = await detectAuth0Config(tmpDir2);
  assert(detected === true, 'detectAuth0Config: package.json with @auth0/nextjs-auth0 → detected');
} catch (err) {
  fail('detectAuth0Config: package.json with @auth0/nextjs-auth0 → detected', err);
} finally {
  fs.rmSync(tmpDir2, { recursive: true, force: true });
}

// Test 4: .env.local with APP_BASE_URL → detected (dotenv load-order check)
const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'auth0-detector-envlocal-test-'));
try {
  fs.writeFileSync(path.join(tmpDir3, '.env.local'), 'APP_BASE_URL=http://localhost:3000\n');
  const detected = await detectAuth0Config(tmpDir3);
  assert(detected === true, 'detectAuth0Config: .env.local with APP_BASE_URL → detected');
} catch (err) {
  fail('detectAuth0Config: .env.local with APP_BASE_URL → detected', err);
} finally {
  fs.rmSync(tmpDir3, { recursive: true, force: true });
}

// Test 5: auth0.config.ts file present → detected
const tmpDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'auth0-detector-cfg-test-'));
try {
  fs.writeFileSync(path.join(tmpDir4, 'auth0.config.ts'), 'export default {};\n');
  const detected = await detectAuth0Config(tmpDir4);
  assert(detected === true, 'detectAuth0Config: auth0.config.ts present → detected');
} catch (err) {
  fail('detectAuth0Config: auth0.config.ts present → detected', err);
} finally {
  fs.rmSync(tmpDir4, { recursive: true, force: true });
}
