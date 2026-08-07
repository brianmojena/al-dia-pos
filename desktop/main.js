const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { initLocalDb } = require('./src/db/localDb');
const { countPendingOutbox } = require('./src/db/queries');
const { routeRequest } = require('./src/router');
const { startSyncLoop } = require('./src/sync/syncWorker');

let mainWindow;
let stopSync;

function broadcastSyncStatus(extra = {}) {
  if (!mainWindow) return;
  mainWindow.webContents.send('sync-status', { pending: countPendingOutbox(), ...extra });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // client-dist es una copia local generada por `npm run build:client` (ver
  // package.json) — así el mismo path funciona en dev y una vez empaquetado,
  // sin depender de rutas ../ que electron-builder no resuelve fuera del
  // directorio del proyecto.
  const clientIndex = path.join(__dirname, 'client-dist', 'index.html');
  mainWindow.loadFile(clientIndex);

  mainWindow.webContents.on('did-finish-load', () => broadcastSyncStatus());
}

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'mitienda.db');
  initLocalDb(dbPath);
  console.log('Base local:', dbPath);

  ipcMain.handle('api-request', async (_event, { method, path: reqPath, body }) => {
    return routeRequest(method, reqPath, body);
  });

  createWindow();

  stopSync = startSyncLoop({
    intervalMs: 30000,
    onTick: (summary) => broadcastSyncStatus(summary),
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (stopSync) stopSync();
  if (process.platform !== 'darwin') app.quit();
});
