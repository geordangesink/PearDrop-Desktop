const express = require('express')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const app = express()
const port = Number(process.env.PORT || 3000)
const uploadToken = String(process.env.UPLOAD_TOKEN || '')
const configuredDownloadRoot = path.resolve(process.env.DOWNLOAD_ROOT || '/data/downloads')
let activeDownloadRoot = configuredDownloadRoot

function safeRelativePath(input) {
  const raw = decodeURIComponent(String(input || '')).replace(/^\/+/, '')
  if (!raw || raw.includes('..') || raw.includes('\\') || raw.startsWith('/')) return ''
  return raw
}

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true })
})

// Railway and other platforms may probe "/" by default.
app.get('/', (req, res) => {
  res.status(200).json({ ok: true })
})

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true })
})

app.put('/upload', async (req, res) => {
  try {
    if (!uploadToken || req.header('x-upload-token') !== uploadToken) {
      return res.status(401).send('unauthorized')
    }

    const relative = safeRelativePath(req.query.path)
    if (!relative) return res.status(400).send('invalid path')

    const absolute = path.join(activeDownloadRoot, relative)
    await fsp.mkdir(path.dirname(absolute), { recursive: true })

    const stream = fs.createWriteStream(absolute)
    req.pipe(stream)
    stream.on('finish', () => res.status(201).send('ok'))
    stream.on('error', (error) => {
      console.error('[upload] stream error', {
        code: error?.code,
        message: error?.message,
        absolute
      })
      res.status(500).send(error?.code || 'write error')
    })
  } catch {
    console.error('[upload] request error')
    res.status(500).send('error')
  }
})

app.post('/promote-latest', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    if (!uploadToken || req.header('x-upload-token') !== uploadToken) {
      return res.status(401).send('unauthorized')
    }

    const source = safeRelativePath(req.body?.source)
    const target = safeRelativePath(req.body?.target)
    if (!source || !target) return res.status(400).send('invalid path')

    const sourceAbs = path.join(activeDownloadRoot, source)
    const targetAbs = path.join(activeDownloadRoot, target)
    if (!sourceAbs.startsWith(activeDownloadRoot) || !targetAbs.startsWith(activeDownloadRoot)) {
      return res.status(400).send('invalid path')
    }

    await fsp.access(sourceAbs)
    await fsp.mkdir(path.dirname(targetAbs), { recursive: true })
    await fsp.rm(targetAbs, { force: true })

    try {
      // Prefer hard-linking to avoid duplicating large installer files on disk.
      await fsp.link(sourceAbs, targetAbs)
    } catch {
      // Fallback when linking is unavailable.
      await fsp.copyFile(sourceAbs, targetAbs)
    }

    return res.status(201).send('ok')
  } catch (error) {
    console.error('[promote-latest] error', {
      code: error?.code,
      message: error?.message
    })
    if (error && error.code === 'ENOENT') return res.status(404).send('source not found')
    return res.status(500).send(error?.code || 'error')
  }
})

app.get('/downloads/*', (req, res) => {
  const relative = safeRelativePath(req.path.replace(/^\/downloads\//, ''))
  if (!relative) return res.status(400).send('invalid path')

  const absolute = path.join(activeDownloadRoot, relative)
  if (!absolute.startsWith(activeDownloadRoot)) return res.status(400).send('invalid path')
  return res.sendFile(absolute)
})

app.listen(port, async () => {
  try {
    await fsp.mkdir(configuredDownloadRoot, { recursive: true })
    activeDownloadRoot = configuredDownloadRoot
  } catch {
    activeDownloadRoot = path.resolve(process.cwd(), 'downloads')
    await fsp.mkdir(activeDownloadRoot, { recursive: true })
  }

  console.log(`pear-drop downloads server listening on ${port}`)
  console.log(`serving ${activeDownloadRoot} at /downloads`)
})
