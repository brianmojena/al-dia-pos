const { contextBridge, ipcRenderer } = require('electron');

// Superficie mínima expuesta al renderer. Nada de Node directo del lado de
// la UI — todo pasa por ipcMain, que es el único que toca la base local.
contextBridge.exposeInMainWorld('electronAPI', {
  request: (method, path, body) => ipcRenderer.invoke('api-request', { method, path, body }),
  onSyncStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('sync-status', listener);
    return () => ipcRenderer.removeListener('sync-status', listener);
  },
});
