const path = require('bare-path')
const os = require('bare-os')
const { bootstrapTransferWorker } = require('@peardrops/native-shared')

async function run() {
  const storage = Bare.argv[2]
  const updaterConfig = JSON.parse(Bare.argv[3] || '{}')
  const baseRoot = updaterConfig.dev ? os.tmpdir() : storage
  const launchSuffix = String(updaterConfig.launchId || '').replace(/[^a-zA-Z0-9_-]/g, '')
  const baseName = updaterConfig.dev
    ? `pear-drops-desktop-dev-${launchSuffix || 'default'}`
    : 'peardrops'

  await bootstrapTransferWorker({
    ipc: Bare.IPC,
    baseDir: path.join(baseRoot, baseName),
    updaterConfig,
    relayUrl: updaterConfig.relayUrl || ''
  })
}

run().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  Bare.IPC.write(Buffer.from(JSON.stringify({ type: 'fatal', message })))
  throw error
})
