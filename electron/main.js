const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  Tray,
  nativeImage,
  powerSaveBlocker
} = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs')
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
const TRANSFER_WORKER_SPECIFIER = '/workers/main.js'
const DEFAULT_DEV_RELAY = 'wss://pear-drops.up.railway.app'
const DEFAULT_PROD_RELAY = 'wss://pear-drops.up.railway.app'
const workers = new Map()
const exitedWorkers = new WeakSet()
const pendingDeepLinks = []
let isQuitting = false
let forceQuit = false
let workersShuttingDown = null
let themeMode = 'system'
let tray = null
let sleepBlockerId = null
let quitPromptOpen = false

const cmd = command(
  appName,
  flag('--storage', 'custom app data path'),
  flag('--relay', 'browser relay websocket endpoint')
)

const launchArgs = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2)
if (handleSquirrelStartupEvent(launchArgs)) process.exit(0)
for (const link of findAppLaunchPayloads(launchArgs)) pendingDeepLinks.push(link)
cmd.parse(sanitizeCliArgs(launchArgs))

function handleSquirrelStartupEvent(argv) {
  if (!app.isPackaged || !isWindows) return false

  const command = (Array.isArray(argv) ? argv : []).find(isSquirrelArg)
  if (!command) return false
  const normalizedCommand = normalizeSquirrelArg(command)

  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe')
  const appExe = path.basename(process.execPath)

  try {
    if (normalizedCommand === 'install' || normalizedCommand === 'updated') {
      execFileSync(updateExe, ['--createShortcut', appExe], { stdio: 'ignore' })
      removeSquirrelPackageTemp(updateExe)
      return true
    }

    if (normalizedCommand === 'uninstall') {
      execFileSync(updateExe, ['--removeShortcut', appExe], { stdio: 'ignore' })
      return true
    }

    if (normalizedCommand === 'obsolete') return true
  } catch (error) {
    console.error('Failed handling Squirrel startup event', {
      command,
      message: error?.message
    })
    return true
  }

  return false
}

function removeSquirrelPackageTemp(updateExe) {
  try {
    fs.rmSync(path.join(path.dirname(updateExe), 'packages', 'SquirrelTemp'), {
      recursive: true,
      force: true
    })
  } catch {}
}

function isSquirrelArg(value) {
  return normalizeSquirrelArg(value).length > 0
}

function normalizeSquirrelArg(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  const match = raw.match(/^(?:--|\/)?squirrel[-_]?([a-z]+)/)
  return match ? match[1] : ''
}

function sanitizeCliArgs(argv) {
  const input = Array.isArray(argv) ? argv : []
  const output = []
  const squirrelFlags = new Set([
    '--squirrel-install',
    '--squirrel-updated',
    '--squirrel-uninstall',
    '--squirrel-obsolete',
    '--squirrel-firstrun'
  ])
  for (let i = 0; i < input.length; i++) {
    const value = String(input[i] || '')

    if (isAppLaunchPayload(value)) continue

    // Squirrel.Windows passes lifecycle flags when launching right after setup.
    // Ignore them so CLI parsing doesn't crash the app on first run.
    if (
      squirrelFlags.has(value) ||
      isSquirrelArg(value) ||
      value === '--processStart' ||
      value === '--process-start-args' ||
      value.startsWith('--processStart=') ||
      value.startsWith('--process-start-args=') ||
      value.startsWith('--squirrel-')
    ) {
      if (
        (squirrelFlags.has(value) ||
          isSquirrelArg(value) ||
          value === '--processStart' ||
          value === '--process-start-args') &&
        i + 1 < input.length &&
        !String(input[i + 1]).startsWith('-')
      ) {
        i++
      }
      continue
    }

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

    if (!app.isPackaged) output.push(input[i])
  }
  return output
}

function isAppLaunchPayload(value) {
  return Boolean(normalizeAppLaunchPayload(value))
}

function findAppLaunchPayloads(argv) {
  const links = []
  for (const value of Array.isArray(argv) ? argv : []) {
    const link = normalizeAppLaunchPayload(value)
    if (link) links.push(link)
  }
  return links
}

function normalizeAppLaunchPayload(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (isDeepLink(raw, protocol)) return raw
  if (raw.startsWith(`${protocol}:/`)) {
    return `${protocol}://${raw.slice(`${protocol}:/`.length).replace(/^\/+/, '')}`
  }
  if (/^\/?invite\/?\?/i.test(raw)) return `${protocol}://${raw.replace(/^\/+/, '')}`
  if (/^[?&](drive|room|topic|relay|web)=/i.test(raw)) return `${protocol}://invite${raw}`
  return ''
}

function resolveBaseDir() {
  if (cmd.flags.storage) return cmd.flags.storage
  if (!app.isPackaged) return app.getPath('userData')

  return isMac
    ? path.join(os.homedir(), 'Library', 'Application Support', appName)
    : isLinux
      ? path.join(os.homedir(), '.config', appName)
      : app.getPath('userData')
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
      role: 'viewMenu'
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

async function revealMainWindow() {
  const existing = BrowserWindow.getAllWindows()[0]
  if (!existing || existing.isDestroyed()) {
    await createWindow()
    return
  }
  focusMainWindow(existing)
}

function focusMainWindow(existingWindow = null) {
  const existing =
    existingWindow && !existingWindow.isDestroyed()
      ? existingWindow
      : BrowserWindow.getAllWindows()[0]
  if (!existing || existing.isDestroyed()) return
  if (!existing.isVisible()) existing.show()
  if (existing.isMinimized()) existing.restore()
  existing.focus()
}

function resolveTrayIconPath() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'tray.png'),
    path.join(__dirname, '..', 'build', 'installer-drive.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.ico')
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {}
  }
  return ''
}

function invertImageForLinux(image) {
  if (!image || image.isEmpty()) return image
  const size = image.getSize()
  const width = Number(size?.width || 0)
  const height = Number(size?.height || 0)
  if (!width || !height) return image

  const src = image.toBitmap()
  const out = Buffer.from(src)
  for (let i = 0; i < out.length; i += 4) {
    const alpha = out[i + 3]
    if (!alpha) continue
    // Native bitmap is BGRA.
    out[i] = 255 - out[i]
    out[i + 1] = 255 - out[i + 1]
    out[i + 2] = 255 - out[i + 2]
  }
  return nativeImage.createFromBitmap(out, { width, height })
}

function buildTrayImage(iconPath) {
  let image = nativeImage.createFromPath(iconPath)
  if (!image || image.isEmpty()) return image
  const targetSize = isMac ? 18 : 22
  image = image.resize({ width: targetSize, height: targetSize, quality: 'best' })
  if (isLinux) image = invertImageForLinux(image)
  return image
}

function createTray() {
  if (!isMac && !isLinux) return
  if (tray) return
  const iconPath = resolveTrayIconPath()
  if (!iconPath) return
  const icon = buildTrayImage(iconPath)
  if (!icon || icon.isEmpty()) return
  tray = new Tray(icon)
  tray.setToolTip(appName)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show PearDrop',
        click: () => {
          void revealMainWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit PearDrop',
        click: () => {
          forceQuit = true
          app.quit()
        }
      }
    ])
  )
  // Keep tray icon clicks inert; actions are explicit via context menu items.
  tray.on('click', () => {})
}

function hideAllWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.hide()
  }
}

function setHostingActive(shouldPreventSleep) {
  const active = Boolean(shouldPreventSleep)
  if (active) {
    if (sleepBlockerId && powerSaveBlocker.isStarted(sleepBlockerId)) return
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    return
  }
  if (sleepBlockerId && powerSaveBlocker.isStarted(sleepBlockerId)) {
    powerSaveBlocker.stop(sleepBlockerId)
  }
  sleepBlockerId = null
}

function presentQuitPrompt() {
  quitPromptOpen = true
  sendToAll('app:quit-prompt', {
    open: true,
    detail:
      'Quitting PearDrop stops all active hosts. Choose "Close Window" to keep hosting sessions open in the background.'
  })
}

function hideQuitPrompt() {
  if (!quitPromptOpen) return
  quitPromptOpen = false
  sendToAll('app:quit-prompt', { open: false })
}

function beginGracefulQuit() {
  if (isQuitting) return
  isQuitting = true
  hideQuitPrompt()
  sendToAll('app:quitting', { message: 'Shutting down PearDrop...' })
  shutdownWorkers()
    .catch((error) => {
      console.error('Failed while shutting down workers', error)
    })
    .finally(() => {
      setHostingActive(false)
      app.exit(0)
    })
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

  if (app.isPackaged) {
    killStaleWorkers(updaterConfig.storage)
  }

  const runtimeStorage = path.join(appDir, 'runtime-storage')
  const worker = PearRuntime.run(
    workerPath,
    [updaterConfig.storage, JSON.stringify(updaterConfig)],
    {
      storage: runtimeStorage
    }
  )

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

function killStaleWorkers(storagePath) {
  if (!isMac && !isLinux) return
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' })
    const lines = String(output || '').split('\n')
    for (const line of lines) {
      const value = String(line || '').trim()
      if (!value) continue

      const splitIndex = value.indexOf(' ')
      if (splitIndex === -1) continue

      const pid = Number.parseInt(value.slice(0, splitIndex), 10)
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue

      const args = value.slice(splitIndex + 1)
      if (!args.includes('bare-sidecar')) continue
      if (!args.includes('workers/main.js') && !args.includes('workers\\main.js')) continue
      if (storagePath && !args.includes(storagePath)) continue

      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  } catch {}
}

function resolveRelayUrl() {
  const cliRelay = String(cmd.flags.relay || '').trim()
  if (cliRelay) return cliRelay

  const envRelay = String(process.env.PEARDROPS_RELAY_URL || '').trim()
  if (envRelay) return envRelay

  return app.isPackaged ? DEFAULT_PROD_RELAY : DEFAULT_DEV_RELAY
}

async function createWindow() {
  // Start the transfer worker before renderer boot so cold startup can initialize in parallel.
  try {
    getWorker(TRANSFER_WORKER_SPECIFIER)
  } catch (error) {
    console.error('Failed prewarming transfer worker', error)
  }

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

  win.on('close', (event) => {
    if (isQuitting || forceQuit) return
    event.preventDefault()
    win.hide()
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
  return win
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
  const alreadyRunning = workers.has(specifier)
  const worker = getWorker(specifier)
  return {
    ok: true,
    specifier,
    alreadyRunning,
    pid: Number(worker?.pid || 0)
  }
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

ipcMain.handle('app:setHostingActive', async (evt, active) => {
  setHostingActive(Boolean(active))
  return true
})

ipcMain.handle('app:quitPromptAction', async (evt, actionRaw) => {
  const action = String(actionRaw || '').trim().toLowerCase()
  if (action === 'close-window') {
    hideQuitPrompt()
    hideAllWindows()
    return true
  }
  if (action === 'cancel') {
    hideQuitPrompt()
    return true
  }
  if (action === 'quit') {
    beginGracefulQuit()
    return true
  }
  return false
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
    createTray()
    createWindow().catch((error) => {
      console.error('Failed creating window', error)
      app.quit()
    })
  })

  app.on('activate', () => {
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
    if (!windows.length) {
      createWindow().catch((error) => {
        console.error('Failed creating window on activate', error)
      })
      return
    }
    void revealMainWindow()
  })

  app.on('before-quit', (evt) => {
    evt.preventDefault()
    if (isQuitting) return
    if (forceQuit || quitPromptOpen) {
      beginGracefulQuit()
      return
    }
    const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
    if (!windows.length) {
      beginGracefulQuit()
      return
    }
    presentQuitPrompt()
  })

  app.on('window-all-closed', () => {
    // Keep app alive in tray/background when all windows are hidden.
  })
}
