const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('updater', {
  on: (cb) => ipcRenderer.on('app-update', (_e, data) => cb(data)),
  download: () => ipcRenderer.send('app-update-download'),
  install: () => ipcRenderer.send('app-update-install')
})
