const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const WORKER_READY_TOKEN = '__PEARDROP_WORKER_RPC_READY__'
let bootstrapTransferWorker = null

try {
  // In local development, prefer the in-repo core so desktop and native-shared stay aligned.
  ;({ bootstrapTransferWorker } = require('../../native-shared/src/index.js'))
} catch {
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
