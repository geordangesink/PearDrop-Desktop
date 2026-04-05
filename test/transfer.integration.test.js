const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const fs = require('fs/promises')
const path = require('path')
const b4a = require('b4a')
const createTestnet = require('hyperdht/testnet')
const { TransferBackend } = require('@peardrops/native-shared')

test('backend upload and download flow saves expected file bytes', async (t) => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peardrops-desktop-test-'))
  const backend = new TransferBackend({ baseDir })

  t.after(async () => {
    await backend.close()
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  await backend.ready()

  const payload = b4a.from('desktop transfer payload').toString('base64')
  const upload = await backend.createUpload({
    files: [
      {
        name: 'hello.txt',
        mimeType: 'text/plain',
        dataBase64: payload
      }
    ]
  })

  assert.ok(upload.invite.startsWith('peardrops://invite'))
  assert.ok(upload.invite.includes('room='))

  const manifest = await backend.getManifest({ invite: upload.invite })
  assert.equal(manifest.files.length, 1)
  assert.equal(manifest.files[0].name, 'hello.txt')

  const result = await backend.download({
    invite: upload.invite,
    targetDir: path.join(baseDir, 'out')
  })

  assert.equal(result.files.length, 1)
  const file = await fs.readFile(result.files[0].path, 'utf8')
  assert.equal(file, 'desktop transfer payload')

  const roomOnlyInviteUrl = new URL(upload.invite)
  roomOnlyInviteUrl.searchParams.delete('drive')
  const roomOnly = await backend.download({
    invite: roomOnlyInviteUrl.toString(),
    targetDir: path.join(baseDir, 'out-room-only')
  })
  assert.equal(roomOnly.files.length, 1)
  const roomOnlyFile = await fs.readFile(roomOnly.files[0].path, 'utf8')
  assert.equal(roomOnlyFile, 'desktop transfer payload')
})

test(
  'cross-backend room join/download works with flockmanager invite flow',
  { timeout: 60000 },
  async (t) => {
    const tn = await createTestnet(10)
    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peardrops-desktop-host-'))
    const clientDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peardrops-desktop-client-'))
    const host = new TransferBackend({
      baseDir: hostDir,
      swarmOptions: { bootstrap: tn.bootstrap }
    })
    const client = new TransferBackend({
      baseDir: clientDir,
      swarmOptions: { bootstrap: tn.bootstrap }
    })

    t.after(async () => {
      await client.close()
      await host.close()
      await tn.destroy()
      await fs.rm(hostDir, { recursive: true, force: true })
      await fs.rm(clientDir, { recursive: true, force: true })
    })

    await host.ready()
    await client.ready()

    const payload = b4a.from('cross backend desktop payload').toString('base64')
    const upload = await host.createUpload({
      files: [
        {
          name: 'cross.txt',
          mimeType: 'text/plain',
          dataBase64: payload
        }
      ]
    })

    const roomOnlyInviteUrl = new URL(upload.invite)
    roomOnlyInviteUrl.searchParams.delete('drive')

    const downloaded = await client.download({
      invite: roomOnlyInviteUrl.toString(),
      targetDir: path.join(clientDir, 'room-download')
    })

    assert.equal(downloaded.files.length, 1)
    const file = await fs.readFile(downloaded.files[0].path, 'utf8')
    assert.equal(file, 'cross backend desktop payload')
  }
)
