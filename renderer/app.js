/* global window, document, navigator, TextDecoder, FileReader, Buffer, localStorage */

const RPC = require('bare-rpc')
const { createWebRtcHost } = require('./lib/webrtc-host')

const RpcCommand = {
  INIT: 0,
  LIST_TRANSFERS: 1,
  CREATE_UPLOAD: 2,
  GET_MANIFEST: 3,
  DOWNLOAD: 4,
  SHUTDOWN: 5,
  READ_ENTRY: 6
}

const workerSpecifier = '/workers/main.js'
const bridge = window.bridge
const decoder = new TextDecoder('utf8')

const statusEl = document.getElementById('status')
const sectionTitleEl = document.getElementById('section-title')
const sectionSubtitleEl = document.getElementById('section-subtitle')
const transferCountEl = document.getElementById('transfer-count')
const rowsEl = document.getElementById('file-rows')
const homeViewEl = document.getElementById('home-view')
const listViewEl = document.getElementById('list-view')

const inviteOutputEl = document.getElementById('invite-output')
const inviteInputEl = document.getElementById('invite-input')
const filePicker = document.getElementById('file-picker')
const newUploadBtn = document.getElementById('new-upload')
const downloadBtn = document.getElementById('download-action')
const copyInviteBtn = document.getElementById('copy-invite')
const openWebBtn = document.getElementById('open-web')
const clearDeletedBtn = document.getElementById('clear-deleted')
const searchInput = document.getElementById('search')

const navItems = Array.from(document.querySelectorAll('.sidebar .nav-item'))
const sidebarEl = document.querySelector('.sidebar')

const PREF_KEY = 'peardrops.desktop.files.v1'

const state = {
  rpc: null,
  view: 'all-files',
  search: '',
  latestInvite: '',
  latestWebLink: '',
  webRtcHost: null,
  transfers: [],
  files: loadFilesFromPrefs(),
  starred: new Set(loadSet('peardrops.desktop.starred')),
  deleted: new Set(loadSet('peardrops.desktop.deleted'))
}

if (!bridge || typeof bridge.startWorker !== 'function') {
  statusEl.textContent = 'Desktop bridge failed to load. Check preload configuration.'
  throw new Error('window.bridge is unavailable')
}

void startDesktop()

bridge.onWorkerStderr(workerSpecifier, (data) => {
  statusEl.textContent = `Worker error: ${decoder.decode(data)}`
})

bridge.onDeepLink((url) => {
  if (!url.startsWith('peardrops://')) return
  inviteInputEl.value = url
  statusEl.textContent = 'Invite link received via deep link.'
})

if (sidebarEl) {
  sidebarEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const item = target.closest('.nav-item')
    if (!(item instanceof HTMLElement)) return
    const view = item.dataset.view || 'all-files'
    setView(view)
  })
}

searchInput.addEventListener('input', () => {
  state.search = searchInput.value.trim().toLowerCase()
  render()
})

newUploadBtn.addEventListener('click', () => filePicker.click())

filePicker.addEventListener('change', async () => {
  if (!state.rpc) {
    statusEl.textContent = 'Worker is still starting. Please try again in a moment.'
    filePicker.value = ''
    return
  }

  const files = Array.from(filePicker.files || [])
  if (files.length === 0) return

  statusEl.textContent = 'Preparing upload...'
  const payload = {
    files: await Promise.all(files.map(readFileAsPayload))
  }

  try {
    const response = await state.rpc.request(RpcCommand.CREATE_UPLOAD, payload)
    state.latestInvite = response.nativeInvite || response.invite
    state.latestWebLink = response.webSwarmLink || ''
    inviteOutputEl.value = state.latestInvite
    await ensureWebRtcHost(state.latestInvite)

    const now = Date.now()
    for (const entry of response.manifest || []) {
      upsertFile({
        id: `upload:${response.transfer?.id || now}:${entry.drivePath}`,
        name: entry.name,
        byteLength: Number(entry.byteLength || 0),
        updatedAt: now,
        access: 'Only you',
        source: 'upload',
        invite: state.latestInvite
      })
    }

    statusEl.textContent = `Hosting ${response.manifest.length} file(s).`
    await refreshTransfers()
    render()
  } catch (error) {
    statusEl.textContent = `Upload failed: ${error.message}`
  } finally {
    filePicker.value = ''
  }
})

window.addEventListener('beforeunload', () => {
  void closeWebRtcHost()
})

downloadBtn.addEventListener('click', async () => {
  if (!state.rpc) {
    statusEl.textContent = 'Worker is still starting. Please try again in a moment.'
    return
  }

  const invite = inviteInputEl.value.trim()
  if (!invite) {
    statusEl.textContent = 'Paste an invite URL first.'
    return
  }

  statusEl.textContent = 'Joining and downloading...'

  try {
    const response = await state.rpc.request(RpcCommand.DOWNLOAD, { invite })
    const now = Date.now()

    for (const entry of response.files || []) {
      upsertFile({
        id: `download:${response.transfer?.id || now}:${entry.path || entry.name}`,
        name: entry.name,
        byteLength: Number(entry.byteLength || 0),
        updatedAt: now,
        access: 'Only you',
        source: 'download',
        invite
      })
    }

    statusEl.textContent = `Downloaded ${response.files.length} file(s).`
    await refreshTransfers()
    render()
  } catch (error) {
    statusEl.textContent = `Download failed: ${error.message}`
  }
})

copyInviteBtn.addEventListener('click', async () => {
  const invite = inviteOutputEl.value.trim() || state.latestInvite
  if (!invite) {
    statusEl.textContent = 'No invite available yet.'
    return
  }

  try {
    await navigator.clipboard.writeText(invite)
    statusEl.textContent = 'Invite copied to clipboard.'
  } catch {
    inviteOutputEl.select()
    document.execCommand('copy')
    statusEl.textContent = 'Invite copied.'
  }
})

openWebBtn.addEventListener('click', () => {
  const invite = inviteOutputEl.value.trim() || state.latestInvite
  if (!invite) return
  const target =
    state.latestWebLink || `http://localhost:5173/?invite=${encodeURIComponent(invite)}`
  window.open(target, '_blank')
})

clearDeletedBtn.addEventListener('click', () => {
  if (state.deleted.size === 0) {
    statusEl.textContent = 'Deleted files is already empty.'
    return
  }

  state.files = state.files.filter((file) => !state.deleted.has(file.id))
  state.deleted.clear()
  persistSets()
  persistFiles()
  statusEl.textContent = 'Deleted files cleared.'
  render()
})

rowsEl.addEventListener('click', async (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const action = target.dataset.action
  const id = target.dataset.id
  if (!action || !id) return

  if (action === 'star') {
    if (state.starred.has(id)) state.starred.delete(id)
    else state.starred.add(id)
    persistSets()
    render()
    return
  }

  if (action === 'delete') {
    state.deleted.add(id)
    persistSets()
    render()
    return
  }

  if (action === 'restore') {
    state.deleted.delete(id)
    persistSets()
    render()
    return
  }

  if (action === 'copy') {
    const file = state.files.find((item) => item.id === id)
    const invite = file?.invite || state.latestInvite
    if (!invite) {
      statusEl.textContent = 'No invite available for this item.'
      return
    }
    inviteOutputEl.value = invite
    await navigator.clipboard.writeText(invite)
    statusEl.textContent = 'Invite copied to clipboard.'
  }
})

async function bootstrap() {
  try {
    const initial = await requestInitWithRetry(state.rpc, 4)
    state.transfers = initial.transfers || []
    transferCountEl.textContent = `${state.transfers.length} transfers indexed`
    statusEl.textContent = `Ready (${initial.version})`
    render()
  } catch (error) {
    statusEl.textContent = `Init failed: ${error.message}`
  }
}

async function startDesktop() {
  try {
    await withTimeout(
      Promise.resolve(bridge.startWorker(workerSpecifier)),
      15000,
      'Worker start request timed out'
    )

    state.rpc = createRpcClient()
    statusEl.textContent = 'Worker started. Initializing...'
    await bootstrap()
  } catch (error) {
    statusEl.textContent = `Worker start failed: ${error.message || String(error)}`
  }
}

async function refreshTransfers() {
  if (!state.rpc) return
  const response = await state.rpc.request(RpcCommand.LIST_TRANSFERS, {})
  state.transfers = response.transfers || []
  transferCountEl.textContent = `${state.transfers.length} transfers indexed`
}

function render() {
  for (const item of navItems) {
    item.classList.toggle('active', item.dataset.view === state.view)
  }

  const files = selectVisibleFiles()

  if (state.view === 'home') {
    renderHome(files)
    return
  }

  homeViewEl.classList.add('hidden')
  listViewEl.classList.remove('hidden')

  const sectionTitles = {
    'all-files': ['All files', 'Everything you uploaded or downloaded.'],
    recent: ['Recent', 'Latest file activity from this device.'],
    starred: ['Starred', 'Important files you marked for quick access.'],
    shared: ['Shared', 'Uploads with invite links you can share.'],
    offline: ['Offline', 'Files downloaded and available locally.'],
    deleted: ['Deleted files', 'Removed files can be restored until emptied.']
  }

  const [title, sub] = sectionTitles[state.view] || sectionTitles['all-files']
  sectionTitleEl.textContent = title
  sectionSubtitleEl.textContent = sub

  renderRows(files)
}

function setView(view) {
  state.view = view
  render()
}

function renderHome(files) {
  sectionTitleEl.textContent = 'Home'
  sectionSubtitleEl.textContent = 'Quick access to what matters most.'

  homeViewEl.classList.remove('hidden')
  listViewEl.classList.add('hidden')

  const cards = [
    {
      title: 'Recent',
      body: `${selectByView('recent').length} recent file(s)`,
      view: 'recent'
    },
    {
      title: 'Starred',
      body: `${selectByView('starred').length} starred file(s)`,
      view: 'starred'
    },
    {
      title: 'Shared',
      body: `${selectByView('shared').length} upload file(s)`,
      view: 'shared'
    },
    {
      title: 'Offline',
      body: `${selectByView('offline').length} downloaded file(s)`,
      view: 'offline'
    },
    {
      title: 'All files',
      body: `${selectByView('all-files').length} total file(s)`,
      view: 'all-files'
    },
    {
      title: 'Deleted',
      body: `${selectByView('deleted').length} file(s) in bin`,
      view: 'deleted'
    }
  ]

  homeViewEl.textContent = ''
  for (const card of cards) {
    const el = document.createElement('button')
    el.className = 'home-card nav-item'
    el.dataset.view = card.view
    el.innerHTML = `<h3>${card.title}</h3><p>${card.body}</p>`
    el.addEventListener('click', () => {
      state.view = card.view
      render()
    })
    homeViewEl.appendChild(el)
  }

  const recent = files.slice(0, 4)
  if (recent.length) {
    const list = document.createElement('div')
    list.className = 'home-card'
    const names = recent.map((item) => item.name).join(', ')
    list.innerHTML = `<h3>Quick access</h3><p>${names}</p>`
    homeViewEl.appendChild(list)
  }
}

function renderRows(files) {
  rowsEl.textContent = ''

  if (!files.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td colspan="5" class="row-muted">No files in this section.</td>'
    rowsEl.appendChild(tr)
    return
  }

  for (const file of files) {
    const tr = document.createElement('tr')
    const deleted = state.deleted.has(file.id)
    const starred = state.starred.has(file.id)

    tr.innerHTML = `
      <td>${escapeHtml(file.name)}</td>
      <td class="row-muted">${formatDate(file.updatedAt)}</td>
      <td class="row-muted">${formatBytes(file.byteLength)}</td>
      <td><span class="badge">${file.access || 'Only you'}</span></td>
      <td>
        <button class="mini-btn" data-action="star" data-id="${file.id}">${starred ? 'Unstar' : 'Star'}</button>
        <button class="mini-btn" data-action="copy" data-id="${file.id}">Copy invite</button>
        ${
          deleted
            ? `<button class="mini-btn" data-action="restore" data-id="${file.id}">Restore</button>`
            : `<button class="mini-btn" data-action="delete" data-id="${file.id}">Delete</button>`
        }
      </td>
    `

    rowsEl.appendChild(tr)
  }
}

function selectVisibleFiles() {
  return selectByView(state.view).filter((file) => {
    if (!state.search) return true
    return file.name.toLowerCase().includes(state.search)
  })
}

function selectByView(view) {
  const all = state.files

  if (view === 'deleted') {
    return all
      .filter((file) => state.deleted.has(file.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const active = all.filter((file) => !state.deleted.has(file.id))

  switch (view) {
    case 'recent':
      return active
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20)
    case 'starred':
      return active
        .filter((file) => state.starred.has(file.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    case 'shared':
      return active
        .filter((file) => file.source === 'upload')
        .sort((a, b) => b.updatedAt - a.updatedAt)
    case 'offline':
      return active
        .filter((file) => file.source === 'download')
        .sort((a, b) => b.updatedAt - a.updatedAt)
    case 'home':
    case 'all-files':
    default:
      return active.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

function upsertFile(file) {
  const existingIndex = state.files.findIndex((item) => item.id === file.id)
  if (existingIndex >= 0) {
    state.files[existingIndex] = { ...state.files[existingIndex], ...file }
  } else {
    state.files.push(file)
  }
  persistFiles()
}

function loadFilesFromPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistFiles() {
  localStorage.setItem(PREF_KEY, JSON.stringify(state.files.slice(-400)))
}

function loadSet(key) {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persistSets() {
  localStorage.setItem('peardrops.desktop.starred', JSON.stringify(Array.from(state.starred)))
  localStorage.setItem('peardrops.desktop.deleted', JSON.stringify(Array.from(state.deleted)))
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(value) {
  const date = new Date(Number(value || Date.now()))
  return date.toLocaleString()
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function readFileAsPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const dataBase64 = result.includes(',') ? result.split(',')[1] : result
      resolve({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64
      })
    }
    reader.onerror = () => reject(reader.error || new Error('File read failed'))
    reader.readAsDataURL(file)
  })
}

async function requestInitWithRetry(rpc, attempts) {
  let lastError = null
  for (let i = 1; i <= attempts; i++) {
    try {
      return await withTimeout(rpc.request(RpcCommand.INIT, {}), 20000, 'Worker init RPC timed out')
    } catch (error) {
      lastError = error
      if (i < attempts) await sleep(750)
    }
  }
  throw lastError || new Error('Worker init failed')
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createRpcClient() {
  const ipc = {
    on(event, listener) {
      if (event !== 'data') return ipc
      bridge.onWorkerIPC(workerSpecifier, (chunk) => {
        listener(chunk)
      })
      return ipc
    },
    write(data) {
      bridge.writeWorkerIPC(workerSpecifier, data)
      return true
    }
  }

  const client = new RPC(ipc, () => {})
  return {
    async request(command, payload = {}) {
      const req = client.request(command)
      req.send(Buffer.from(JSON.stringify(payload), 'utf8'))
      const reply = await req.reply()
      const parsed = JSON.parse(Buffer.from(reply).toString('utf8'))
      if (parsed && parsed.ok === false) {
        throw new Error(parsed.error || 'RPC request failed')
      }
      return parsed && parsed.ok === true ? parsed.result : parsed
    }
  }
}

async function ensureWebRtcHost(invite) {
  await closeWebRtcHost()

  try {
    state.webRtcHost = await createWebRtcHost({
      invite,
      rpc: state.rpc
    })
    state.latestWebLink = state.webRtcHost.webLink
  } catch (error) {
    state.latestWebLink = ''
    statusEl.textContent = `Web endpoint warning: ${error.message || String(error)}`
  }
}

async function closeWebRtcHost() {
  if (!state.webRtcHost) return
  const host = state.webRtcHost
  state.webRtcHost = null
  try {
    await host.close()
  } catch {}
}
