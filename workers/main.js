const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const { arch, platform } = require('which-runtime')
const WORKER_READY_TOKEN = '__PEARDROP_WORKER_RPC_READY__'
let bootstrapTransferWorker = null

try {
  // In local development, prefer the in-repo core so desktop and native-shared stay aligned.
  ;({ bootstrapTransferWorker } = require('../../native-shared/src/index.js'))
} catch {
  applyPackagedUpdaterPatch()
  ;({ bootstrapTransferWorker } = require('pear-drop-core'))
}

async function run() {
  const parentPidAtStart = Number(process.ppid || 0)
  const parentWatchdog = startParentWatchdog(parentPidAtStart)
  const storage = Bare.argv[2]
  const updaterConfig = JSON.parse(Bare.argv[3] || '{}')
  const baseRoot = updaterConfig.dev ? os.tmpdir() : storage
  const launchSuffix = String(updaterConfig.launchId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  const baseName = updaterConfig.dev
    ? `pear-drops-desktop-dev-${launchSuffix || 'default'}`
    : 'peardrops'

  const metadataRoot = updaterConfig.dev ? os.tmpdir() : storage || baseRoot
  const metadataName = updaterConfig.dev
    ? `pear-drops-desktop-history-dev-${launchSuffix || 'default'}`
    : 'pear-drops-desktop-history'

  await bootstrapTransferWorker({
    ipc: Bare.IPC,
    baseDir: path.join(baseRoot, baseName),
    metadataDir: path.join(metadataRoot, metadataName),
    updaterConfig,
    relayUrl: updaterConfig.relayUrl || ''
  })

  // Explicit startup handshake for the renderer: RPC server is now bound and ready.
  console.log(WORKER_READY_TOKEN)

  if (typeof Bare?.on === 'function') {
    Bare.on('exit', () => {
      if (parentWatchdog) clearInterval(parentWatchdog)
    })
  }
}

run().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  Bare.IPC.write(Buffer.from(JSON.stringify({ type: 'fatal', message })))
  throw error
})

function startParentWatchdog(parentPidAtStart) {
  if (!Number.isFinite(parentPidAtStart) || parentPidAtStart <= 0) return null
  const timer = setInterval(() => {
    const currentParentPid = Number(process.ppid || 0)
    if (currentParentPid === parentPidAtStart) return
    try {
      Bare.exit(0)
    } catch {
      process.exit(0)
    }
  }, 1500)
  if (typeof timer?.unref === 'function') timer.unref()
  return timer
}

function applyPackagedUpdaterPatch() {
  try {
    const updaterModule = require('pear-drop-core/src/runtime/updater-worker.js')
    const runtimeCompat = require('pear-drop-core/src/utils/runtime-compat.js')
    const UpdaterWorker = updaterModule?.UpdaterWorker
    if (!UpdaterWorker || UpdaterWorker.__pearDropDesktopPatched) return

    const fs = runtimeCompat?.fs
    const pathCompat = runtimeCompat?.path || path
    if (!fs?.promises || !pathCompat?.join) return

    const originalReady = UpdaterWorker.prototype.ready
    UpdaterWorker.prototype.ready = async function (...args) {
      const result = await originalReady.apply(this, args)
      await primeMacHelpersPath(this.updater, fs, pathCompat)

      if (this.updater && this._onError && typeof this.updater.on === 'function') {
        if (typeof this.updater.off === 'function') {
          try {
            this.updater.off('error', this._onError)
          } catch {}
        }

        const originalOnError = this._onError
        this._onError = async (error) => {
          const recovered = await maybeRecoverMissingMacHelpersPath(
            this.updater,
            error,
            fs,
            pathCompat
          )
          if (recovered) {
            console.warn('[peardrops:updater] recovered missing macOS framework Helpers path')
            return
          }
          return originalOnError(error)
        }
        this.updater.on('error', this._onError)
      }

      return result
    }

    UpdaterWorker.__pearDropDesktopPatched = true
  } catch {}
}

function getMacHelpersPath(updater, pathCompat) {
  if (platform !== 'darwin') return ''
  const nextRoot = String(updater?.next || '').trim()
  const appName = String(updater?.name || 'PearDrop.app').trim()
  if (!nextRoot || !appName) return ''
  const host = `${platform}-${arch}`
  return pathCompat.join(
    nextRoot,
    'by-arch',
    host,
    'app',
    appName,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Helpers'
  )
}

async function primeMacHelpersPath(updater, fsCompat, pathCompat) {
  const helpersPath = getMacHelpersPath(updater, pathCompat)
  if (!helpersPath) return false
  try {
    await fsCompat.promises.mkdir(helpersPath, { recursive: true })
    return true
  } catch {
    return false
  }
}

function isMissingMacHelpersPathError(error) {
  const message = String(error?.message || '')
  const filePath = String(error?.path || '')
  if (!(error?.code === 'ENOENT' || message.includes('ENOENT'))) return false
  const details = `${filePath}\n${message}`
  return details.includes('Electron Framework.framework/Helpers')
}

async function maybeRecoverMissingMacHelpersPath(updater, error, fsCompat, pathCompat) {
  if (platform !== 'darwin') return false
  if (!isMissingMacHelpersPathError(error)) return false
  return primeMacHelpersPath(updater, fsCompat, pathCompat)
}
