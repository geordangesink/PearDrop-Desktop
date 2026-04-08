const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const { command, flag } = require('paparam')
const { isMac, isLinux, isWindows } = require('which-runtime')
const pkg = require('../package.json')
const { normalizeBuffer } = require('./lib/buffer')
const { isDeepLink, findDeepLink } = require('./lib/deep-link')

const appName = pkg.productName || pkg.name
const protocol = 'peardrops'
const DEFAULT_DEV_RELAY = 'ws://localhost:49443'
const DEFAULT_PROD_RELAY = 'wss://pear-drops.up.railway.app'
const workers = new Map()
const exitedWorkers = new WeakSet()
const pendingDeepLinks = []
let isQuitting = false
let workersShuttingDown = null
let themeMode = 'system'

const cmd = command(
  appName,
  flag('--storage', 'custom app data path'),
  flag('--relay', 'browser relay websocket endpoint')
)

cmd.parse(sanitizeCliArgs(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2)))

function sanitizeCliArgs(argv) {
  const input = Array.isArray(argv) ? argv : []
  const output = []
  for (let i = 0; i < input.length; i++) {
    const value = String(input[i] || '')

    if (value === '--updates' || value === '--no-updates' || value.startsWith('--updates=')) {
      if (value === '--updates' && i + 1 < input.length && !String(input[i + 1]).startsWith('-')) {
        i++
      }
      continue
    }

    if ((value === '--relay' || value === '--storage') && i + 1 < input.length) {
      const next = String(input[i + 1] || '')
      if (next && !next.startsWith('-')) {
        output.push(`${value}=${next}`)
        i++
        continue
      }
    }

    output.push(input[i])
  }
  return output
}

function resolveBaseDir() {
  if (cmd.flags.storage) return cmd.flags.storage
  if (!app.isPackaged) return app.getPath('userData')

  return isMac
    ? path.join(os.homedir(), 'Library', 'Application Support', appName)
    : isLinux
      ? path.join(os.homedir(), '.config', appName)
      : path.join(os.homedir(), 'AppData', 'Local', appName)
}

async function shutdownWorkers() {
  if (workersShuttingDown) return workersShuttingDown

  workersShuttingDown = (async () => {
    const pending = []
    for (const [specifier, worker] of workers) {
      pending.push(
        new Promise((resolve) => {
          let settled = false
          const done = () => {
            if (settled) return
            settled = true
            resolve()
          }
          worker.once('exit', done)
          setTimeout(done, 5000)
          try {
            worker.destroy()
          } catch {
            done()
          }
        })
      )
    }

    await Promise.all(pending)
    workers.clear()
  })()

  await workersShuttingDown
  workersShuttingDown = null
}

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function runtimeName() {
  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'
  return `${appName}${extension}`
}

function sendToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function applyThemeMode(mode) {
  const next = mode === 'dark' || mode === 'light' ? mode : 'system'
  themeMode = next
  sendToAll('app:theme-mode', { mode: next })
}

function createAppMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            role: 'appMenu'
          }
        ]
      : []),
    {
      role: 'fileMenu'
    },
    {
      role: 'editMenu'
    },
    {
      label: 'Options',
      submenu: [
        {
          label: 'Theme',
          submenu: [
            {
              label: 'System',
              type: 'radio',
              checked: themeMode === 'system',
              click: () => applyThemeMode('system')
            },
            {
              label: 'Dark',
              type: 'radio',
              checked: themeMode === 'dark',
              click: () => applyThemeMode('dark')
            },
            {
              label: 'Light',
              type: 'radio',
              checked: themeMode === 'light',
              click: () => applyThemeMode('light')
            }
          ]
        }
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)

  const appDir = resolveBaseDir()
  const workerPath = path.resolve(__dirname, '..' + specifier)
  const relayUrl = resolveRelayUrl()
  const updaterConfig = {
    dir: appDir,
    app: getAppPath(),
    name: runtimeName(),
    dev: !app.isPackaged,
    updates: false,
    version: pkg.version,
    upgrade: pkg.upgrade,
    relayUrl,
    storage: path.join(appDir, 'app-storage'),
    launchId: `${Date.now()}-${process.pid}`
  }

  const worker = PearRuntime.run(workerPath, [updaterConfig.storage, JSON.stringify(updaterConfig)])

  const onStdout = (data) => sendToAll(`pear:worker:stdout:${specifier}`, data)
  const onStderr = (data) => sendToAll(`pear:worker:stderr:${specifier}`, data)
  const onIPC = (data) => sendToAll(`pear:worker:ipc:${specifier}`, data)

  worker.on('data', onIPC)
  worker.stdout.on('data', onStdout)
  worker.stderr.on('data', onStderr)

  worker.once('exit', (code) => {
    exitedWorkers.add(worker)
    worker.removeListener('data', onIPC)
    worker.stdout.removeListener('data', onStdout)
    worker.stderr.removeListener('data', onStderr)
    sendToAll(`pear:worker:exit:${specifier}`, code)
    workers.delete(specifier)
  })

  workers.set(specifier, worker)
  return worker
}

function resolveRelayUrl() {
  const cliRelay = String(cmd.flags.relay || '').trim()
  if (cliRelay) return cliRelay

  const envRelay = String(process.env.PEARDROPS_RELAY_URL || '').trim()
  if (envRelay) return envRelay

  return app.isPackaged ? DEFAULT_PROD_RELAY : DEFAULT_DEV_RELAY
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true
    }
  })

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL
  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
  } else {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  }

  while (pendingDeepLinks.length > 0) {
    sendToAll('app:deep-link', pendingDeepLinks.shift())
  }
  sendToAll('app:theme-mode', { mode: themeMode })
}

function onDeepLink(url) {
  if (!isDeepLink(url, protocol)) return
  pendingDeepLinks.push(url)
  sendToAll('app:deep-link', url)
}

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

ipcMain.handle('pear:startWorker', async (evt, filename) => {
  const specifier = filename.startsWith('/') ? filename : `/${filename}`
  getWorker(specifier)
  return true
})

ipcMain.handle('pear:worker:writeIPC', async (evt, filename, data) => {
  const specifier = String(filename || '')
  const worker = workers.get(specifier)
  if (!worker || exitedWorkers.has(worker)) return false
  try {
    return worker.write(normalizeBuffer(data))
  } catch {
    return false
  }
})

ipcMain.handle('app:pickDirectory', async () => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return ''
  }
  return String(result.filePaths[0] || '')
})

ipcMain.handle('app:pickFiles', async () => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections']
  })
  if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return []
  }
  return result.filePaths.map((value) => String(value || '')).filter(Boolean)
})

ipcMain.handle('app:getDownloadsPath', async () => {
  return app.getPath('downloads')
})

ipcMain.handle('app:getThemeMode', async () => {
  return themeMode
})

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  onDeepLink(url)
})

const lock = app.requestSingleInstanceLock()
if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (evt, args) => {
    const link = findDeepLink(args, protocol)
    if (link) onDeepLink(link)
  })

  app.whenReady().then(() => {
    createAppMenu()
    createWindow().catch((error) => {
      console.error('Failed creating window', error)
      app.quit()
    })
  })

  app.on('before-quit', (evt) => {
    if (isQuitting) return
    evt.preventDefault()
    isQuitting = true
    sendToAll('app:quitting', { message: 'Shutting down Pear Drops...' })
    shutdownWorkers()
      .catch((error) => {
        console.error('Failed while shutting down workers', error)
      })
      .finally(() => {
        app.exit(0)
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
