const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron')
const net = require('net')
const path = require('path')
const updater = require('./lib/updater')

let updateInfo = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let win = null

  app.setAppUserModelId('com.omnilauncher.app')

  function findFreePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer()
      srv.unref()
      srv.on('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port
        srv.close(() => resolve(port))
      })
    })
  }

  function startServer(port) {
    process.env.PORT = String(port)
    require('./server.js')
  }

  async function createWindow(port) {
    win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 940,
      minHeight: 620,
      autoHideMenuBar: true,
      backgroundColor: '#0b0e14',
      title: 'OmniLauncher',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js')
      }
    })
    win.setMenuBarVisibility(false)
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 60; i++) {
      try {
        await win.loadURL(url)
        break
      } catch (e) {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    win.on('closed', () => {
      win = null
    })
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (u.startsWith('http') || u.startsWith('https')) shell.openExternal(u)
      return { action: 'deny' }
    })
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  function sendUpdate(data) {
    if (win) win.webContents.send('app-update', data)
  }

  function setupUpdater() {
    if (!app.isPackaged) return
    setTimeout(() => {
      updater
        .checkUpdate(sendUpdate)
        .then((info) => {
          updateInfo = info
        })
        .catch(() => {})
    }, 4000)
  }

  ipcMain.on('app-update-download', () => {
    if (!updateInfo || !app.isPackaged) return
    updater
      .downloadUpdate(updateInfo, sendUpdate)
      .then((dest) => {
        updateInfo._dest = dest
        sendUpdate({ status: 'downloaded', version: updateInfo.version })
      })
      .catch(() => {
        sendUpdate({ status: 'error' })
      })
  })

  ipcMain.on('app-update-install', () => {
    if (updateInfo && updateInfo._dest) updater.installUpdate(updateInfo._dest)
  })

  ipcMain.handle('pick-file', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Select a modpack file',
      properties: ['openFile'],
      filters: [{ name: 'Modpack', extensions: ['zip', 'mrpack'] }]
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  app.whenReady().then(async () => {
    const port = await findFreePort()
    startServer(port)
    await createWindow(port)
    setupUpdater()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    if (process.env.PORT) {
      const { spawn } = require('child_process')
      spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(New-Object Net.WebClient).UploadString('http://127.0.0.1:${process.env.PORT}/api/stop','')`
        ],
        { detached: true, stdio: 'ignore' }
      ).unref()
    }
  })
}
