#!/usr/bin/env node
// Phase 1 detection test: asserts the broadened scanner detects outbound API calls
// (fetch/axios/generic client `.get()` on any receiver), normalizes template/query/
// external URLs, rejects non-HTTP `.get()` via the slash-gate + receiver denylist,
// skips test files, and lets a route definition beat a duplicate call site on dedup.
//
// Pure Node — requires `pnpm run build:electron` first (imports from dist-electron/).
import { scanEndpoints } from '../dist-electron/endpointScanner.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dds-scan-calls-'));

const files = {
  'client.ts': `
    import axios from 'axios';
    const api = makeClient();
    const httpClient = makeClient();
    export async function load(id) {
      await api.get('/api/users');
      await httpClient.post('/api/login');
      await axios.get('/api/products');
      await axios('/api/bare', { method: 'PUT' });
      await axios.get(\`/api/users/\${id}\`);
      await axios.get('https://api.stripe.com/v1/charges');
      await fetch('/api/cart', { method: 'POST' });
      await fetch('/api/feed');
      await fetch('/api/search?q=pizza#frag');
      // Non-HTTP receivers / args — must NOT be detected:
      map.get('/api/should-not-appear');
      cookies.get('session');
      localStorage.get('/nope');
    }
  `,
  // A real route definition for /api/health (Express, high confidence)...
  'server.ts': `
    import express from 'express';
    const app = express();
    app.get('/api/health', (req, res) => res.json({ ok: true }));
  `,
  // ...and a duplicate call site for it (medium) that must lose dedup.
  'health-client.ts': `
    import axios from 'axios';
    export const ping = () => axios.get('/api/health');
  `,
  // Calls in test files must be ignored.
  'feature.test.ts': `
    import axios from 'axios';
    it('loads', () => axios.get('/api/from-test'));
  `,
  // Modern call shapes the old regex scanner missed — only reachable via the AST pass
  // with intra-file const-folding.
  'modern-clients.ts': `
    import axios from 'axios';
    import useSWR from 'swr';
    const BASE = '/api/v2';
    export function ModernThing() {
      fetch(BASE + '/products');                 // const-folded concat
      axios({ url: '/api/cart', method: 'DELETE' }); // config-object axios
      $.ajax({ url: '/api/legacy' });            // jQuery-style config object
      useSWR('/api/profile', fetcher);           // URL-first data hook
      fetch(
        '/api/orders',
        {
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
      );                                         // method far from the open paren
      axios.get(\`\${BASE}/inventory\`);          // template + const base
    }
  `,
};

for (const [name, content] of Object.entries(files)) {
  await fs.writeFile(path.join(dir, name), content, 'utf8');
}

const endpoints = await scanEndpoints(dir);
const byKey = new Map(
  endpoints.map((endpoint) => [`${endpoint.method}:${endpoint.path}`, endpoint]),
);
const find = (method, routePath) => byKey.get(`${method}:${routePath}`);

// Generic client calls on arbitrary receivers.
assert(find('GET', '/api/users'), 'detects api.get(/api/users)');
assert(find('POST', '/api/login'), 'detects httpClient.post(/api/login)');
assert(find('GET', '/api/products'), 'detects axios.get(/api/products)');
assert(find('PUT', '/api/bare'), 'detects bare axios(/api/bare,{method:PUT})');

// fetch with and without an explicit method.
assert(find('POST', '/api/cart'), 'detects fetch(/api/cart,{method:POST})');
assert(find('GET', '/api/feed'), 'defaults fetch(/api/feed) to GET');

// Normalization.
assert(find('GET', '/api/users/:id'), 'template ${id} → :id segment');
assert(find('GET', '/api/search'), 'strips query/hash');

// External URL: pathname kept, low confidence, external framework label.
const stripe = find('GET', '/v1/charges');
assert(stripe, 'detects external axios.get(stripe)');
assert(
  stripe && stripe.confidence === 'low',
  'external call is low confidence',
  stripe?.confidence,
);
assert(
  stripe && /external/i.test(stripe.framework) && stripe.framework.includes('api.stripe.com'),
  'external call labels host',
  stripe?.framework,
);

// Denylist + slash-gate rejections.
assert(!find('GET', '/api/should-not-appear'), 'map.get(...) rejected by denylist');
assert(!byKey.has('GET:/nope'), 'localStorage.get(...) rejected by denylist');
assert(
  ![...byKey.keys()].some((key) => key.includes('session')),
  'cookies.get(non-slash) rejected by slash-gate',
);

// Test-file calls ignored.
assert(!find('GET', '/api/from-test'), 'calls in *.test.ts are skipped');

// Definition beats duplicate call site on dedup.
const health = find('GET', '/api/health');
assert(health, 'detects /api/health');
assert(
  health && health.confidence === 'high',
  '/api/health kept at high confidence',
  health?.confidence,
);
assert(
  health && health.framework === 'Express/Fastify',
  '/api/health keeps the route definition, not the call site',
  health?.framework,
);

// Modern call shapes (AST-only) — the regex scanner missed all of these.
assert(find('GET', '/api/v2/products'), 'const-folds fetch(BASE + "/products")');
assert(find('DELETE', '/api/cart'), 'config-object axios({url,method})');
assert(find('GET', '/api/legacy'), 'config-object $.ajax({url})');
assert(find('GET', '/api/profile'), 'URL-first hook useSWR(url)');
assert(find('POST', '/api/orders'), 'multi-line fetch reads method anywhere in options');
assert(find('GET', '/api/v2/inventory'), 'template `${BASE}/inventory` folds to real path');
assert(
  !byKey.has('GET:/:BASE/inventory'),
  'template+const does NOT leak a bogus /:BASE/inventory key',
);

// Every detected call-site endpoint still satisfies the inventory contract.
for (const endpoint of endpoints) {
  assert(endpoint.fields.length > 0, `${endpoint.method} ${endpoint.path} has fields`);
  assert(
    endpoint.mock[endpoint.fields[0].name] !== undefined,
    `${endpoint.method} ${endpoint.path} mock includes its fields`,
  );
}

await fs.rm(dir, { recursive: true, force: true });

console.log(`\nScanned ${endpoints.length} endpoints from temp sources.`);
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log('All endpoint call-site detection checks passed.');
