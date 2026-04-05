const { app, BrowserWindow, ipcMain } = require('electron')
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
const workers = new Map()
const pendingDeepLinks = []
let isQuitting = false
let workersShuttingDown = null

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
      ipcMain.removeHandler(`pear:worker:writeIPC:${specifier}`)
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

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)

  const appDir = resolveBaseDir()
  const workerPath = path.resolve(__dirname, '..' + specifier)
  const updaterConfig = {
    dir: appDir,
    app: getAppPath(),
    name: runtimeName(),
    dev: !app.isPackaged,
    updates: false,
    version: pkg.version,
    upgrade: pkg.upgrade,
    relayUrl: cmd.flags.relay || 'ws://localhost:49443',
    storage: path.join(appDir, 'app-storage'),
    launchId: `${Date.now()}-${process.pid}`
  }

  const worker = PearRuntime.run(workerPath, [updaterConfig.storage, JSON.stringify(updaterConfig)])

  const onStdout = (data) => sendToAll(`pear:worker:stdout:${specifier}`, data)
  const onStderr = (data) => sendToAll(`pear:worker:stderr:${specifier}`, data)
  const onIPC = (data) => sendToAll(`pear:worker:ipc:${specifier}`, data)

  ipcMain.handle(`pear:worker:writeIPC:${specifier}`, (evt, data) => {
    return worker.write(normalizeBuffer(data))
  })

  worker.on('data', onIPC)
  worker.stdout.on('data', onStdout)
  worker.stderr.on('data', onStderr)

  worker.once('exit', (code) => {
    ipcMain.removeHandler(`pear:worker:writeIPC:${specifier}`)
    worker.removeListener('data', onIPC)
    worker.stdout.removeListener('data', onStdout)
    worker.stderr.removeListener('data', onStderr)
    sendToAll(`pear:worker:exit:${specifier}`, code)
    workers.delete(specifier)
  })

  workers.set(specifier, worker)
  return worker
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 980,
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
    createWindow().catch((error) => {
      console.error('Failed creating window', error)
      app.quit()
    })
  })

  app.on('before-quit', (evt) => {
    if (isQuitting) return
    evt.preventDefault()
    isQuitting = true
    shutdownWorkers()
      .catch((error) => {
        console.error('Failed while shutting down workers', error)
      })
      .finally(() => {
        app.quit()
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
