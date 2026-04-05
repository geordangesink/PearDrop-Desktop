const path = require('bare-path')
const os = require('bare-os')
const { bootstrapTransferWorker } = require('@peardrops/native-shared')

async function run() {
  const storage = Bare.argv[2]
  const updaterConfig = JSON.parse(Bare.argv[3] || '{}')
  const baseRoot = updaterConfig.dev ? os.tmpdir() : storage

  await bootstrapTransferWorker({
    ipc: Bare.IPC,
    baseDir: path.join(baseRoot, 'peardrops'),
    updaterConfig,
    relayUrl: updaterConfig.relayUrl || ''
  })
}

run().catch((error) => {
  const message = error && error.message ? error.message : String(error)
  Bare.IPC.write(Buffer.from(JSON.stringify({ type: 'fatal', message })))
  throw error
})
