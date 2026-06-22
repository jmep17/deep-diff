// Seam proof for the repo-overlay auth bypass: does aliasing @auth0/auth0-react -> a
// local mock actually stop the client-side redirect and let a protected route render?
//
// No existing fixture exercises this (storefront-auth0 uses the SERVER-side
// @auth0/nextjs-auth0 and is a zero-dep server.mjs stub). So this scaffolds a throwaway
// Vite + React + @auth0/auth0-react app in a temp dir with a fake Auth0 domain and a
// route wrapped in withAuthenticationRequired, then loads it under a hidden BrowserWindow
// twice:
//   1. WITHOUT the alias  -> expect a redirect to the fake Auth0 domain (off-origin nav).
//   2. WITH the alias->mock -> expect NO off-origin nav and the protected content rendered.
//
// Run: electron scripts/test-auth-mock-seam.cjs
// Needs network (installs react/vite/@auth0/auth0-react into the temp dir).
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_DOMAIN = 'login.fake-deepdiff.test';

let failures = 0;
function assert(cond, label, detail = '') {
  if (cond) console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitReady(url) {
  return new Promise((res) => {
    const req = http.get(url, (r) => {
      r.resume();
      res(true);
    });
    req.on('error', () => res(false));
    req.setTimeout(400, () => {
      req.destroy();
      res(false);
    });
  });
}

function run(cmd, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: true });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed:\n${out}`)),
    );
  });
}

function scaffold(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '__mocks__', '@auth0'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'auth-seam-app',
        private: true,
        type: 'module',
        scripts: { dev: 'vite' },
        dependencies: {
          react: '18.3.1',
          'react-dom': '18.3.1',
          '@auth0/auth0-react': '2.2.4',
        },
        devDependencies: { vite: '5.4.10', '@vitejs/plugin-react': '4.3.3' },
      },
      null,
      2,
    ),
  );

  // The alias is applied only when DEEP_DIFF_AUTH_MOCK is set, so the same tree
  // exercises both the real (redirecting) and mocked (no-redirect) paths.
  fs.writeFileSync(
    path.join(dir, 'vite.config.js'),
    `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: process.env.DEEP_DIFF_AUTH_MOCK
      ? { '@auth0/auth0-react': resolve(import.meta.dirname, '__mocks__/@auth0/auth0-react.jsx') }
      : {},
  },
}));
`,
  );

  fs.writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>seam</title></head>
<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
  );

  fs.writeFileSync(
    path.join(dir, 'src', 'main.jsx'),
    `import React from 'react';
import { createRoot } from 'react-dom/client';
import { Auth0Provider, withAuthenticationRequired } from '@auth0/auth0-react';

const Secret = withAuthenticationRequired(() => <div id="protected">SECRET CONTENT</div>);

createRoot(document.getElementById('root')).render(
  <Auth0Provider
    domain="${FAKE_DOMAIN}"
    clientId="fakeClientId0000000000000000"
    authorizationParams={{ redirect_uri: window.location.origin }}
  >
    <Secret />
  </Auth0Provider>,
);
`,
  );

  fs.writeFileSync(
    path.join(dir, '__mocks__', '@auth0', 'auth0-react.jsx'),
    `import React from 'react';
export const Auth0Provider = ({ children }) => <>{children}</>;
export const useAuth0 = () => ({
  isAuthenticated: true,
  isLoading: false,
  getAccessTokenSilently: async () => 'Token',
  user: { name: 'Mock User', email: 'mock@local' },
  loginWithRedirect: async () => {},
  logout: async () => {},
});
export const withAuthenticationRequired = (Component) => Component;
`,
  );
}

// Start vite, load '/', record any off-origin navigation, return whether the
// protected content rendered and whether a redirect to the fake domain happened.
async function probe(dir, win, useMock) {
  const port = await getFreePort();
  const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: dir,
    env: { ...process.env, DEEP_DIFF_AUTH_MOCK: useMock ? '1' : '' },
    shell: true,
  });
  let viteLog = '';
  vite.stdout.on('data', (b) => (viteLog += b));
  vite.stderr.on('data', (b) => (viteLog += b));

  try {
    const url = `http://127.0.0.1:${port}/`;
    for (let i = 0; i < 80; i++) {
      if (await waitReady(url)) break;
      await delay(200);
    }

    let offOriginHost = '';
    const onNav = (_e, target) => {
      try {
        const host = new URL(target).host;
        if (!host.startsWith('127.0.0.1')) offOriginHost = host;
      } catch {
        /* ignore */
      }
    };
    win.webContents.on('will-navigate', onNav);
    win.webContents.on('will-redirect', onNav);

    await win.loadURL(url).catch(() => {});
    await delay(2500); // let auth0-react mount + (without mock) build the authorize URL & redirect

    let protectedText = '';
    try {
      protectedText = await win.webContents.executeJavaScript(
        "(document.getElementById('protected')||{}).innerText || ''",
      );
    } catch {
      /* page may have navigated away */
    }

    win.webContents.off('will-navigate', onNav);
    win.webContents.off('will-redirect', onNav);
    return { offOriginHost, protectedText };
  } finally {
    vite.kill('SIGTERM');
    await delay(300);
  }
}

app
  .whenReady()
  .then(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-seam-'));
    console.log(`scaffolding throwaway app in ${dir}`);
    scaffold(dir);
    console.log('installing deps (network)…');
    await run('pnpm', ['install'], dir, {});

    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    // 1. Real auth0-react: protected route must redirect off-origin, no content.
    const real = await probe(dir, win, false);
    assert(
      real.offOriginHost.includes(FAKE_DOMAIN),
      'without mock: redirects to the (fake) Auth0 domain',
      `nav=${real.offOriginHost || '(none)'} content=${JSON.stringify(real.protectedText)}`,
    );
    assert(!real.protectedText, 'without mock: protected content does NOT render');

    // 2. Aliased mock: no off-origin redirect, protected content renders.
    const mocked = await probe(dir, win, true);
    assert(
      !mocked.offOriginHost,
      'with mock: NO off-origin redirect',
      `nav=${mocked.offOriginHost || '(none)'}`,
    );
    assert(
      mocked.protectedText.includes('SECRET CONTENT'),
      'with mock: protected content renders',
      JSON.stringify(mocked.protectedText),
    );

    win.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failures === 0 ? '\nAuth-mock seam proven.' : `\n${failures} failed.`);
    // process.exit (not app.exit) to dodge an Electron GPU-teardown SIGSEGV that
    // otherwise clobbers the exit code after results are already printed.
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
  })
  .catch((e) => {
    console.error(e);
    setTimeout(() => process.exit(1), 100);
  });
