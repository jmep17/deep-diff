#!/usr/bin/env node
import { scanEndpoints } from '../dist-electron/endpointScanner.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'mock-repositories', 'auth0-routes-fixture');

function pass(label, detail = '') {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, detail) {
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  process.exitCode = 1;
}

function assert(condition, label, detail) {
  if (condition) pass(label, detail);
  else fail(label, detail);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const endpoints = await scanEndpoints(fixturePath);

assert(endpoints.length >= 8, 'discovered endpoints', `${endpoints.length} endpoints`);

for (const endpoint of endpoints) {
  assert(Boolean(endpoint.id), `${endpoint.method} ${endpoint.path} has id`);
  assert(endpoint.path.startsWith('/'), `${endpoint.method} ${endpoint.path} path is absolute`);
  assert(
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method),
    `${endpoint.path} has HTTP method`,
  );
  assert(isPlainObject(endpoint.mock), `${endpoint.method} ${endpoint.path} mock is an object`);
  assert(endpoint.fields.length > 0, `${endpoint.method} ${endpoint.path} has inferred fields`);

  for (const field of endpoint.fields) {
    assert(
      typeof field.name === 'string' && field.name.length > 0,
      `${endpoint.path} field has name`,
      field.name,
    );
    assert(
      endpoint.mock[field.name] !== undefined,
      `${endpoint.path} mock includes field`,
      field.name,
    );
  }

  if (endpoint.method === 'POST') {
    assert(endpoint.status === 201, `${endpoint.path} POST status is 201`, String(endpoint.status));
  } else {
    assert(endpoint.status === 200, `${endpoint.path} status is 200`, String(endpoint.status));
  }
}

const requiredPaths = ['/api/public/status', '/api/products', '/api/orders', '/api/auth/:auth0'];

for (const requiredPath of requiredPaths) {
  assert(
    endpoints.some(
      (endpoint) =>
        endpoint.path === requiredPath ||
        endpoint.path.includes(requiredPath.replace(':auth0', '')),
    ),
    `includes route like ${requiredPath}`,
  );
}

const statusEndpoint = endpoints.find((endpoint) => endpoint.path === '/api/public/status');
if (statusEndpoint) {
  assert(statusEndpoint.mock.status !== undefined, '/api/public/status mock has status');
}

console.log(`\nValidated ${endpoints.length} endpoint mocks.`);
