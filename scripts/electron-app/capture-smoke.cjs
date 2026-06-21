const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const fixturePath = path.join(__dirname, '..', '..', 'mock-repositories', 'auth0-routes-fixture');

app.whenReady().then(async () => {
  try {
    const { launchSidecar, stopSidecar } = await import('../../dist-electron/sidecar.js');
    const sidecar = await launchSidecar({ repoPath: fixturePath, branch: 'main' });
    console.log('sidecar', sidecar.url);

    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });

    await window.loadURL(`${sidecar.url}/`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const image = await window.webContents.capturePage();
    console.log('capture size', image.getSize());
    window.destroy();
    stopSidecar();
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
