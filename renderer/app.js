/* global window, document, navigator, TextDecoder, FileReader, Buffer, localStorage, confirm */

const RPC = require('bare-rpc')

const RpcCommand = {
  INIT: 0,
  LIST_TRANSFERS: 1,
  CREATE_UPLOAD: 2,
  GET_MANIFEST: 3,
  DOWNLOAD: 4,
  SHUTDOWN: 5,
  READ_ENTRY: 6,
  LIST_ACTIVE_HOSTS: 7,
  STOP_HOST: 8,
  START_HOST_FROM_TRANSFER: 9
}

const workerSpecifier = '/workers/main.js'
const bridge = window.bridge
const decoder = new TextDecoder('utf8')
const TRASH_SVG =
  '<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M7 6l1 14h8l1-14"/><path d="M10 10v7"/><path d="M14 10v7"/></svg>'

const PREF_KEY = 'peardrops.desktop.files.v3'
const STARRED_KEY = 'peardrops.desktop.starred'
const DELETED_KEY = 'peardrops.desktop.deleted'
const DELETED_AT_KEY = 'peardrops.desktop.deletedAt'
const FOLDERS_KEY = 'peardrops.desktop.folders'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

const statusEl = document.getElementById('status')
const sectionTitleEl = document.getElementById('section-title')
const sectionSubtitleEl = document.getElementById('section-subtitle')
const sectionBackBtn = document.getElementById('section-back')
const transferCountEl = document.getElementById('transfer-count')
const rowsEl = document.getElementById('file-rows')
const homeViewEl = document.getElementById('home-view')
const listViewEl = document.getElementById('list-view')
const bulkBarEl = document.getElementById('bulk-bar')
const bulkNoteEl = document.getElementById('bulk-note')
const checkAllEl = document.getElementById('check-all')
const loadMoreBtn = document.getElementById('load-more')
const folderActionsEl = document.getElementById('folder-actions')
const removeFromFolderBtn = document.getElementById('remove-from-folder')
const deleteFolderBtn = document.getElementById('delete-folder')
const previewOverlayEl = document.getElementById('preview-overlay')
const previewBackdropEl = document.getElementById('preview-backdrop')
const previewCloseEl = document.getElementById('preview-close')
const previewTitleEl = document.getElementById('preview-title')
const previewFrameEl = document.getElementById('preview-frame')

const inviteOutputEl = document.getElementById('invite-output')
const inviteInputEl = document.getElementById('invite-input')
const folderFilterEl = document.getElementById('folder-filter')
const filePicker = document.getElementById('file-picker')
const newUploadBtn = document.getElementById('new-upload')
const hostSelectedBtn = document.getElementById('host-selected')
const downloadBtn = document.getElementById('download-action')
const copyInviteBtn = document.getElementById('copy-invite')
const clearDeletedBtn = document.getElementById('clear-deleted')
const searchInput = document.getElementById('search')
const bulkInviteBtn = document.getElementById('bulk-invite')
const bulkStarBtn = document.getElementById('bulk-star')
const bulkDeleteBtn = document.getElementById('bulk-delete')
const bulkFolderBtn = document.getElementById('bulk-folder')
const folderListEl = document.getElementById('folder-list')
const folderModalEl = document.getElementById('folder-modal')
const folderModalBackdropEl = document.getElementById('folder-modal-backdrop')
const folderOptionsEl = document.getElementById('folder-options')
const folderNewInputEl = document.getElementById('folder-new-input')
const folderCreateBtn = document.getElementById('folder-create-btn')
const folderCancelBtn = document.getElementById('folder-cancel-btn')
const hostModalEl = document.getElementById('host-modal')
const hostModalBackdropEl = document.getElementById('host-modal-backdrop')
const hostNameInputEl = document.getElementById('host-name-input')
const hostSubmitBtn = document.getElementById('host-submit-btn')
const hostCancelBtn = document.getElementById('host-cancel-btn')

const navItems = Array.from(document.querySelectorAll('.sidebar .nav-item'))
const sidebarEl = document.querySelector('.sidebar')

const state = {
  rpc: null,
  view: 'all-files',
  search: '',
  latestInvite: '',
  transfers: [],
  activeHosts: [],
  files: loadJson(PREF_KEY, []),
  starred: new Set(loadJson(STARRED_KEY, [])),
  deleted: new Set(loadJson(DELETED_KEY, [])),
  deletedAt: loadJson(DELETED_AT_KEY, {}),
  selected: new Set(),
  folders: loadJson(FOLDERS_KEY, []),
  folderFilter: '',
  openMenuId: '',
  hostDetailInvite: '',
  previewFileId: '',
  folderAssignIds: [],
  recentVisible: 10,
  deletedVisible: 10
}

let pendingHostNameResolve = null

if (!bridge || typeof bridge.startWorker !== 'function') {
  statusEl.textContent = 'Desktop bridge failed to load. Check preload configuration.'
  throw new Error('window.bridge is unavailable')
}

void startDesktop()
setTimeout(() => cleanupExpiredDeleted(), 0)
updateFolderOptions()
renderSidebarFolders()
render()

bridge.onWorkerStderr(workerSpecifier, (data) => {
  const text = decoder.decode(data)
  if (text.includes('ECONNRESET') || text.includes('connection reset by peer')) return
  statusEl.textContent = `Worker error: ${text}`
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
    setView(item.dataset.view || 'all-files')
  })
}

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (
    !target.closest('[data-action="menu"]') &&
    !target.closest('.menu-panel') &&
    state.openMenuId
  ) {
    state.openMenuId = ''
    render()
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePreview()
})

previewBackdropEl?.addEventListener('click', () => closePreview())
previewCloseEl?.addEventListener('click', () => closePreview())
folderModalBackdropEl?.addEventListener('click', () => closeFolderModal())
folderCancelBtn?.addEventListener('click', () => closeFolderModal())
hostModalBackdropEl?.addEventListener('click', () => closeHostNameModal(null))
hostCancelBtn?.addEventListener('click', () => closeHostNameModal(null))
hostSubmitBtn?.addEventListener('click', () => {
  closeHostNameModal(String(hostNameInputEl?.value || ''))
})
hostNameInputEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    closeHostNameModal(String(hostNameInputEl?.value || ''))
  }
})
folderCreateBtn?.addEventListener('click', () => {
  const name = String(folderNewInputEl?.value || '').trim()
  if (!name) return
  const folder = ensureFolder(name)
  applyFolderToIds(folder.id, state.folderAssignIds)
  closeFolderModal()
  render()
})

searchInput.addEventListener('input', () => {
  state.search = searchInput.value.trim().toLowerCase()
  render()
})

folderFilterEl.addEventListener('change', () => {
  state.folderFilter = folderFilterEl.value
  if (!state.folderFilter && state.view === 'all-files') {
    state.hostDetailInvite = ''
  }
  render()
})

sectionBackBtn?.addEventListener('click', () => {
  state.hostDetailInvite = ''
  render()
})

newUploadBtn.addEventListener('click', () => filePicker.click())
filePicker.addEventListener('change', async () => {
  const files = Array.from(filePicker.files || [])
  if (files.length === 0) return

  const imported = await Promise.all(files.map(readFileAsPayload))
  const now = Date.now()
  for (let i = 0; i < imported.length; i++) {
    const entry = imported[i]
    upsertFile({
      id: `local:${now}:${i}:${entry.name}`,
      name: entry.name,
      byteLength: entry.byteLength,
      updatedAt: now,
      source: 'local',
      invite: '',
      mimeType: entry.mimeType,
      dataBase64: entry.dataBase64
    })
  }

  filePicker.value = ''
  statusEl.textContent = `Added ${imported.length} file(s). Select and click "Host Upload" to create invite.`
  render()
})

hostSelectedBtn.addEventListener('click', () => void hostSelectedFiles(Array.from(state.selected)))

downloadBtn.addEventListener('click', async () => {
  if (!state.rpc) return void (statusEl.textContent = 'Worker is still starting.')
  const invite = inviteInputEl.value.trim()
  if (!invite) return void (statusEl.textContent = 'Paste an invite URL first.')

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
        source: 'download',
        invite,
        path: entry.path || ''
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
  if (!invite) return void (statusEl.textContent = 'No invite available yet.')
  await copyToClipboard(invite)
  statusEl.textContent = 'Invite copied to clipboard.'
})

clearDeletedBtn.addEventListener('click', () => {
  if (state.deleted.size === 0) {
    return void (statusEl.textContent = 'Deleted files is already empty.')
  }
  if (!confirm('Permanently remove all deleted files from this local list?')) return
  wipeDeletedFiles(Array.from(state.deleted))
  statusEl.textContent = 'Deleted files cleared.'
  render()
})

checkAllEl.addEventListener('change', () => {
  const visible = selectVisibleFiles().map((file) => file.id)
  if (checkAllEl.checked) {
    for (const id of visible) state.selected.add(id)
  } else {
    for (const id of visible) state.selected.delete(id)
  }
  render()
})

bulkInviteBtn.addEventListener('click', () => void hostSelectedFiles(Array.from(state.selected)))
bulkStarBtn.addEventListener('click', () => {
  const ids = Array.from(state.selected)
  const unstar = ids.length > 0 && ids.every((id) => state.starred.has(id))
  for (const id of ids) {
    if (unstar) state.starred.delete(id)
    else state.starred.add(id)
  }
  persistAll()
  render()
})
bulkDeleteBtn.addEventListener('click', () => {
  const ids = Array.from(state.selected)
  if (!ids.length) return
  if (!confirm(`Delete ${ids.length} selected item(s)?`)) return
  for (const id of ids) {
    state.deleted.add(id)
    state.deletedAt[id] = Date.now()
  }
  persistAll()
  render()
})
bulkFolderBtn.addEventListener('click', () => assignFolderToSelection(Array.from(state.selected)))

loadMoreBtn?.addEventListener('click', () => {
  if (state.view === 'recent') state.recentVisible += 10
  if (state.view === 'deleted') state.deletedVisible += 10
  render()
})

removeFromFolderBtn?.addEventListener('click', () => {
  const ids = Array.from(state.selected)
  if (!ids.length) return
  for (const id of ids) {
    const file = state.files.find((f) => f.id === id)
    if (!file) continue
    upsertFile({ ...file, folderId: '' })
  }
  persistAll()
  render()
})

deleteFolderBtn?.addEventListener('click', () => {
  const folderId = state.folderFilter
  if (!folderId) return
  const folder = state.folders.find((f) => f.id === folderId)
  if (!folder) return
  if (!confirm(`Delete folder "${folder.name}"?`)) return

  const folderFileIds = state.files.filter((f) => f.folderId === folderId).map((f) => f.id)
  const moveToDeleted = confirm(
    'Also move all files in this folder to Deleted files? They can be restored from Deleted.'
  )
  if (
    moveToDeleted &&
    !confirm('Final confirmation: move these files to Deleted and remove this folder?')
  ) {
    return
  }

  if (moveToDeleted) {
    const now = Date.now()
    for (const id of folderFileIds) {
      state.deleted.add(id)
      state.deletedAt[id] = now
      const file = state.files.find((item) => item.id === id)
      if (file) file.folderId = ''
    }
  } else {
    for (const file of state.files) {
      if (file.folderId === folderId) file.folderId = ''
    }
  }

  state.folders = state.folders.filter((f) => f.id !== folderId)
  state.folderFilter = ''
  updateFolderOptions()
  renderSidebarFolders()
  persistAll()
  render()
})

rowsEl.addEventListener('click', async (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const actionNode = target.closest('[data-action]')
  if (!(actionNode instanceof HTMLElement)) return
  const action = actionNode.dataset.action
  const id = actionNode.dataset.id
  if (!action) return

  if (action === 'select' && id) return void toggleSelect(id)
  if (action === 'star' && id) {
    if (state.starred.has(id)) state.starred.delete(id)
    else state.starred.add(id)
    persistAll()
    return void render()
  }
  if (action === 'delete' && id) {
    if (!confirm('Move this item to deleted?')) return
    state.deleted.add(id)
    state.deletedAt[id] = Date.now()
    state.selected.delete(id)
    persistAll()
    return void render()
  }
  if (action === 'restore' && id) {
    state.deleted.delete(id)
    delete state.deletedAt[id]
    persistAll()
    return void render()
  }
  if (action === 'menu' && id) {
    state.openMenuId = state.openMenuId === id ? '' : id
    return void render()
  }
  if (action === 'preview' && id) return void openPreview(id)
  if (action === 'copy' && id) {
    const hostSummary = state.activeHosts.find((item) => `host:${item.invite}` === id)
    const file = state.files.find((item) => item.id === id)
    const invite = hostSummary?.invite || file?.invite || state.latestInvite
    if (!invite) return void (statusEl.textContent = 'No invite available for this item.')
    inviteOutputEl.value = invite
    await copyToClipboard(invite)
    return void (statusEl.textContent = 'Invite copied to clipboard.')
  }
  if (action === 'copy-history-invite' && id) {
    const transfer = state.transfers.find((item) => item.id === id)
    const invite = transfer?.invite || ''
    if (!invite) return void (statusEl.textContent = 'No invite in history for this transfer.')
    inviteOutputEl.value = invite
    await copyToClipboard(invite)
    return void (statusEl.textContent = 'History invite copied to clipboard.')
  }
  if (action === 'host' && id) return void hostSelectedFiles([id])
  if (action === 'folder' && id) return void assignFolderToSelection([id])
  if (action === 'unfolder' && id) {
    const file = state.files.find((f) => f.id === id)
    if (!file) return
    upsertFile({ ...file, folderId: '' })
    persistAll()
    return void render()
  }
  if (action === 'folder-invite' && id) {
    const file = state.files.find((item) => item.id === id)
    if (!file?.folderId) return void (statusEl.textContent = 'This file is not in a folder yet.')
    const ids = state.files.filter((item) => item.folderId === file.folderId).map((item) => item.id)
    return void hostSelectedFiles(ids)
  }
  if (action === 'open-host' && id) {
    state.hostDetailInvite = id
    return void render()
  }
  if (action === 'stop-host' && id) {
    if (!confirm('Stop this hosting session?')) return
    await state.rpc.request(RpcCommand.STOP_HOST, { invite: id })
    if (state.hostDetailInvite === id) state.hostDetailInvite = ''
    await refreshActiveHosts()
    render()
    return void (statusEl.textContent = 'Hosting stopped.')
  }
  if (action === 'restart-host' && id) {
    const base =
      state.transfers.find((item) => item.id === id)?.sessionName ||
      state.transfers.find((item) => item.id === id)?.sessionLabel ||
      'Host Session'
    const sessionNameInput = await requestHostSessionName(String(base))
    if (sessionNameInput === null) return
    const sessionName = String(sessionNameInput || '').trim() || 'Host Session'
    const response = await state.rpc.request(RpcCommand.START_HOST_FROM_TRANSFER, {
      transferId: id,
      sessionName
    })
    const invite = response.nativeInvite || response.invite || ''
    if (invite) {
      inviteOutputEl.value = invite
      state.latestInvite = invite
      statusEl.textContent = 'Hosting started from history.'
    }
    await Promise.all([refreshTransfers(), refreshActiveHosts()])
    render()
  }
})

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)
  render()
}

async function hostSelectedFiles(ids) {
  if (!state.rpc) return void (statusEl.textContent = 'Worker is still starting.')
  const activeFiles = ids
    .map((id) => state.files.find((file) => file.id === id))
    .filter(Boolean)
    .filter((file) => !state.deleted.has(file.id))
  if (!activeFiles.length) {
    return void (statusEl.textContent = 'Select at least one active file first.')
  }

  const payloadFiles = []
  for (const file of activeFiles) {
    const payload = await toUploadPayload(file)
    if (payload) payloadFiles.push(payload)
  }
  if (!payloadFiles.length) {
    return void (statusEl.textContent = 'Selected files are not available locally for hosting.')
  }

  const sessionNameInput = await requestHostSessionName('Host Session')
  if (sessionNameInput === null) return
  const sessionName = String(sessionNameInput || '').trim() || 'Host Session'

  statusEl.textContent = `Hosting ${payloadFiles.length} selected file(s)...`
  try {
    const response = await state.rpc.request(RpcCommand.CREATE_UPLOAD, {
      files: payloadFiles,
      sessionName
    })
    const invite = response.nativeInvite || response.invite || ''
    state.latestInvite = invite
    inviteOutputEl.value = invite
    const now = Date.now()
    for (const file of activeFiles) {
      upsertFile({ ...file, invite, updatedAt: now, source: 'upload' })
    }
    statusEl.textContent = `Hosting ready for ${payloadFiles.length} file(s).`
    await Promise.all([refreshTransfers(), refreshActiveHosts()])
    render()
  } catch (error) {
    statusEl.textContent = `Host upload failed: ${error.message || String(error)}`
  }
}

async function toUploadPayload(file) {
  if (file.dataBase64) {
    return {
      name: file.name,
      mimeType: file.mimeType || guessMime(file.name),
      dataBase64: file.dataBase64
    }
  }
  if (file.path) {
    return { name: file.name, mimeType: file.mimeType || guessMime(file.name), path: file.path }
  }
  return null
}

function assignFolderToSelection(ids) {
  const uniqueIds = Array.from(new Set(ids))
  if (!uniqueIds.length) return void (statusEl.textContent = 'Select at least one file first.')
  openFolderModal(uniqueIds)
}

async function bootstrap() {
  try {
    const initial = await requestInitWithRetry(state.rpc, 4)
    state.transfers = initial.transfers || []
    await refreshActiveHosts()
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

async function refreshActiveHosts() {
  if (!state.rpc) return
  const response = await state.rpc.request(RpcCommand.LIST_ACTIVE_HOSTS, {})
  state.activeHosts = response.hosts || []
}

function render() {
  for (const item of navItems) item.classList.toggle('active', item.dataset.view === state.view)
  folderFilterEl.classList.toggle('active-filter', Boolean(state.folderFilter))
  const files = selectVisibleFiles()

  if (state.view === 'home') {
    sectionTitleEl.textContent = 'Home'
    sectionSubtitleEl.textContent = 'Quick access to what matters most.'
    clearDeletedBtn?.classList.add('hidden')
    homeViewEl.classList.remove('hidden')
    listViewEl.classList.add('hidden')
    homeViewEl.textContent = ''
    return
  }

  const titles = {
    'all-files': ['All files', 'Everything available in the app.'],
    recent: ['Recent', 'Last 10 files added locally (upload or download).'],
    starred: ['Starred', 'Starred files and folder-contained files.'],
    host: ['Host', 'Active host sessions and upload history.'],
    deleted: ['Deleted files', 'Auto-cleaned after 30 days.']
  }
  const [title, sub] = titles[state.view] || titles['all-files']
  sectionTitleEl.textContent =
    state.view === 'host' && state.hostDetailInvite ? 'Host details' : title
  sectionSubtitleEl.textContent = sub
  sectionBackBtn?.classList.toggle('hidden', !(state.view === 'host' && state.hostDetailInvite))
  clearDeletedBtn?.classList.toggle('hidden', state.view !== 'deleted')
  homeViewEl.classList.add('hidden')
  listViewEl.classList.remove('hidden')
  folderActionsEl.classList.toggle('hidden', !state.folderFilter)
  if (state.view === 'host') {
    renderBulkBar([])
    renderHostRows()
  } else {
    renderBulkBar(files)
    renderRows(files)
  }
  renderLoadMore(files)
}

function renderBulkBar(files) {
  const selectedVisible = files.filter((item) => state.selected.has(item.id)).length
  if (!selectedVisible) {
    bulkBarEl.classList.add('hidden')
    bulkNoteEl.textContent = '0 selected'
  } else {
    bulkBarEl.classList.remove('hidden')
    bulkNoteEl.textContent = `${selectedVisible} selected`
  }
  const ids = Array.from(state.selected)
  const shouldUnstar = ids.length > 0 && ids.every((id) => state.starred.has(id))
  bulkStarBtn.textContent = shouldUnstar ? '★' : '☆'
}

function setView(view) {
  if (state.view === 'host' && view !== 'host') state.hostDetailInvite = ''
  state.view = view
  state.selected.clear()
  state.openMenuId = ''
  if (view === 'recent') state.recentVisible = 10
  if (view === 'deleted') state.deletedVisible = 10
  if (view === 'all-files') state.hostDetailInvite = ''
  if (view === 'host') {
    void refreshActiveHosts().then(() => render())
  }
  render()
}

function renderHostRows() {
  rowsEl.textContent = ''

  if (state.hostDetailInvite) {
    const host = state.activeHosts.find((item) => item.invite === state.hostDetailInvite)
    if (!host) {
      state.hostDetailInvite = ''
      return renderHostRows()
    }
    sectionSubtitleEl.textContent = `${host.sessionLabel || host.invite} · ${host.fileCount} file(s)`
    const files = (host.manifest || []).map((entry) => ({
      id: `${host.invite}:${entry.drivePath || entry.name}`,
      name: entry.name,
      byteLength: Number(entry.byteLength || 0),
      updatedAt: Number(host.createdAt || Date.now()),
      source: 'upload',
      invite: host.invite,
      mimeType: entry.mimeType || 'application/octet-stream'
    }))
    renderRows(files)
    return
  }

  const output = []
  for (const host of state.activeHosts) {
    output.push({
      id: `host:${host.invite}`,
      name: host.sessionLabel || host.invite,
      byteLength: Number(host.totalBytes || 0),
      updatedAt: Number(host.createdAt || Date.now()),
      source: 'host-session',
      invite: host.invite,
      hostSummary: true,
      sessionName: host.sessionName || 'Host Session',
      manifest: host.manifest || [],
      transferId: host.transferId
    })
  }

  const history = state.transfers
    .filter((item) => item.type === 'upload')
    .slice(0, 15)
    .map((transfer) => ({
      id: `history:${transfer.id}`,
      name: transfer.sessionLabel || transfer.sessionName || transfer.invite || 'Upload history',
      byteLength: Number(transfer.totalBytes || 0),
      updatedAt: Number(transfer.createdAt || Date.now()),
      source: 'history',
      invite: transfer.invite || '',
      transferId: transfer.id,
      manifest: transfer.manifest || [],
      historySummary: true
    }))

  if (history.length) {
    output.push({ separator: true, label: 'History' }, ...history)
  }

  renderRows(output)
}

function renderRows(files) {
  rowsEl.textContent = ''
  const rows = Array.isArray(files) ? files : []
  const dataRows = rows.filter((row) => !row.separator && !row.hostSummary && !row.historySummary)
  const selectedVisible = dataRows.filter((file) => state.selected.has(file.id)).length
  checkAllEl.checked = dataRows.length > 0 && selectedVisible === dataRows.length

  if (!rows.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td colspan="6" class="row-muted">No files in this section.</td>'
    rowsEl.appendChild(tr)
    return
  }

  for (const file of rows) {
    if (file.separator) {
      const sep = document.createElement('tr')
      sep.innerHTML = `<td colspan="6" class="row-muted"><strong>${escapeHtml(file.label || 'Recent')}</strong></td>`
      rowsEl.appendChild(sep)
      continue
    }
    const starred = state.starred.has(file.id)
    const deleted = state.deleted.has(file.id)
    const folderName = folderNameById(file.folderId)
    const checked = state.selected.has(file.id) ? 'checked' : ''
    const isHostSummary = Boolean(file.hostSummary)
    const isHistorySummary = Boolean(file.historySummary)
    const historyPreview = isHistorySummary
      ? (file.manifest || [])
          .slice(0, 2)
          .map((entry) => entry.name)
          .join(', ')
      : ''
    const nameHtml = isHostSummary
      ? `<button class="menu-item" data-action="open-host" data-id="${file.invite}">${escapeHtml(file.name)}</button>`
      : isHistorySummary
        ? `<div>${escapeHtml(file.name)}</div><div class="row-muted">${escapeHtml(historyPreview || 'No manifest preview')}</div>`
        : `<div>${escapeHtml(file.name)}</div>${folderName ? `<div class="row-muted">Folder: ${escapeHtml(folderName)}</div>` : ''}`
    const actionsHtml = isHostSummary
      ? `<div class="actions-wrap"><button class="mini-btn" data-action="open-host" data-id="${file.invite}">Open</button><button class="mini-btn danger-btn" data-action="stop-host" data-id="${file.invite}">Stop hosting</button><button class="mini-btn" data-action="copy" data-id="${file.id}">Copy invite</button></div>`
      : isHistorySummary
        ? `<div class="actions-wrap"><button class="mini-btn" data-action="restart-host" data-id="${file.transferId}">Start hosting</button>${file.invite ? `<button class="mini-btn" data-action="copy-history-invite" data-id="${file.transferId}">Copy invite</button>` : ''}</div>`
        : `<div class="actions-wrap">
          <button class="icon-btn ${starred ? 'starred' : ''}" data-action="star" data-id="${file.id}">${starred ? '★' : '☆'}</button>
          ${deleted ? `<button class="icon-btn" data-action="restore" data-id="${file.id}">↺</button>` : `<button class="icon-btn delete" data-action="delete" data-id="${file.id}">${TRASH_SVG}</button>`}
          <span class="menu">
            <button class="icon-btn" data-action="menu" data-id="${file.id}">⋯</button>
            ${state.openMenuId === file.id ? `<div class="menu-panel"><button class="menu-item" data-action="host" data-id="${file.id}">Host Upload</button><button class="menu-item" data-action="copy" data-id="${file.id}">Copy Invite</button><button class="menu-item" data-action="folder" data-id="${file.id}">Put In Folder</button>${file.folderId ? `<button class="menu-item" data-action="unfolder" data-id="${file.id}">Remove From Folder</button>` : ''}<button class="menu-item" data-action="folder-invite" data-id="${file.id}">Invite Folder</button></div>` : ''}
          </span>
        </div>`
    const checkHtml =
      isHostSummary || isHistorySummary
        ? ''
        : `<input type="checkbox" data-action="select" data-id="${file.id}" ${checked} />`
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${checkHtml}</td>
      <td>${previewHtml(file)}</td>
      <td>${nameHtml}</td>
      <td class="row-muted">${formatDate(file.updatedAt)}</td>
      <td class="row-muted">${formatBytes(file.byteLength)}</td>
      <td>${actionsHtml}</td>
    `
    rowsEl.appendChild(tr)
  }
}

function previewHtml(file) {
  if (file.hostSummary) {
    return '<div class="preview">HOST</div>'
  }
  if (file.historySummary) {
    return '<div class="preview">HIST</div>'
  }
  const type = classifyFile(file)
  const start = `<button class="preview-btn" data-action="preview" data-id="${file.id}" title="Open preview">`
  const end = '</button>'
  if (type === 'image' && file.dataBase64) {
    const mime = file.mimeType || guessMime(file.name) || 'image/png'
    return `${start}<div class="preview"><img alt="preview" src="data:${mime};base64,${file.dataBase64}" /></div>${end}`
  }
  if (type === 'video') return `${start}<div class="preview preview-video">▶</div>${end}`
  if (type === 'audio') return `${start}<div class="preview">AUDIO</div>${end}`
  return `${start}<div class="preview">${escapeHtml(fileExt(file.name).toUpperCase() || 'FILE')}</div>${end}`
}

function classifyFile(file) {
  const mime = String(file.mimeType || '').toLowerCase()
  const ext = fileExt(file.name)
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
    return 'image'
  }
  if (mime.startsWith('video/') || ['mp4', 'mov', 'mkv', 'webm'].includes(ext)) return 'video'
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'aac'].includes(ext)) return 'audio'
  return 'other'
}

function fileExt(name) {
  const text = String(name || '')
  const idx = text.lastIndexOf('.')
  return idx < 0 ? '' : text.slice(idx + 1).toLowerCase()
}

function folderNameById(id) {
  if (!id) return ''
  return state.folders.find((folder) => folder.id === id)?.name || ''
}

function selectVisibleFiles() {
  return selectByView(state.view).filter((file) => {
    if (file.separator) return true
    if (state.folderFilter && file.folderId !== state.folderFilter) return false
    if (!state.search) return true
    return file.name.toLowerCase().includes(state.search)
  })
}

function selectByView(view) {
  const all = state.files
  if (view === 'deleted') {
    const items = all
      .filter((file) => state.deleted.has(file.id))
      .sort(
        (a, b) => (state.deletedAt[b.id] || b.updatedAt) - (state.deletedAt[a.id] || a.updatedAt)
      )
    return items.slice(0, state.deletedVisible)
  }

  const active = all.filter((file) => !state.deleted.has(file.id))
  if (view === 'recent') {
    return active
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, state.recentVisible)
  }
  if (view === 'starred') {
    return active
      .filter((file) => state.starred.has(file.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
  if (view === 'host') {
    return active.filter((file) => Boolean(file.invite)).sort((a, b) => b.updatedAt - a.updatedAt)
  }
  return active.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

function renderLoadMore(files) {
  if (!loadMoreBtn) return
  let show = false
  if (state.view === 'recent') {
    const total = state.files.filter((f) => !state.deleted.has(f.id)).length
    show = files.filter((f) => !f.separator).length < total
  }
  if (state.view === 'deleted') {
    const total = state.files.filter((f) => state.deleted.has(f.id)).length
    show = files.filter((f) => !f.separator).length < total
  }
  loadMoreBtn.classList.toggle('hidden', !show)
}

function upsertFile(file) {
  const existingIndex = state.files.findIndex((item) => item.id === file.id)
  if (existingIndex >= 0) state.files[existingIndex] = { ...state.files[existingIndex], ...file }
  else state.files.push(file)
  persistAll()
}

function wipeDeletedFiles(ids, permanent = true) {
  const removeIds = new Set(ids)
  if (permanent) {
    state.files = state.files.filter((f) => !removeIds.has(f.id))
  }
  for (const id of ids) {
    state.deleted.delete(id)
    state.starred.delete(id)
    state.selected.delete(id)
    delete state.deletedAt[id]
  }
  persistAll()
}

function persistAll() {
  localStorage.setItem(PREF_KEY, JSON.stringify(state.files.slice(-600)))
  localStorage.setItem(STARRED_KEY, JSON.stringify(Array.from(state.starred)))
  localStorage.setItem(DELETED_KEY, JSON.stringify(Array.from(state.deleted)))
  localStorage.setItem(DELETED_AT_KEY, JSON.stringify(state.deletedAt))
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(state.folders))
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : fallback
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function updateFolderOptions() {
  const current = state.folderFilter
  folderFilterEl.textContent = ''
  const all = document.createElement('option')
  all.value = ''
  all.textContent = 'All folders'
  folderFilterEl.appendChild(all)
  for (const folder of state.folders) {
    const opt = document.createElement('option')
    opt.value = folder.id
    opt.textContent = folder.name
    folderFilterEl.appendChild(opt)
  }
  folderFilterEl.value = current
}

function renderSidebarFolders() {
  if (!folderListEl) return
  folderListEl.textContent = ''
  if (!state.folders.length) {
    const empty = document.createElement('div')
    empty.className = 'row-muted'
    empty.style.padding = '0 12px'
    empty.textContent = 'No folders yet'
    folderListEl.appendChild(empty)
    return
  }
  for (const folder of state.folders) {
    const btn = document.createElement('button')
    btn.className = 'folder-item'
    btn.textContent = `📁 ${folder.name}`
    btn.addEventListener('click', () => {
      state.view = 'all-files'
      state.folderFilter = folder.id
      folderFilterEl.value = folder.id
      state.selected.clear()
      render()
    })
    folderListEl.appendChild(btn)
  }
}

function ensureFolder(folderName) {
  let folder = state.folders.find((item) => item.name.toLowerCase() === folderName.toLowerCase())
  if (!folder) {
    folder = {
      id: `folder:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      name: folderName
    }
    state.folders.push(folder)
    updateFolderOptions()
    renderSidebarFolders()
    persistAll()
  }
  return folder
}

function applyFolderToIds(folderId, ids) {
  for (const id of ids) {
    const file = state.files.find((item) => item.id === id)
    if (!file) continue
    upsertFile({ ...file, folderId })
  }
  persistAll()
  statusEl.textContent = `Moved ${ids.length} file(s) into folder.`
}

function openFolderModal(ids) {
  state.folderAssignIds = ids.slice()
  folderOptionsEl.textContent = ''
  folderNewInputEl.value = ''
  if (!state.folders.length) {
    const note = document.createElement('div')
    note.className = 'row-muted'
    note.textContent = 'No folders yet. Create one below.'
    folderOptionsEl.appendChild(note)
  } else {
    for (const folder of state.folders) {
      const button = document.createElement('button')
      button.className = 'folder-pill'
      button.textContent = folder.name
      button.addEventListener('click', () => {
        applyFolderToIds(folder.id, state.folderAssignIds)
        closeFolderModal()
        render()
      })
      folderOptionsEl.appendChild(button)
    }
  }
  folderModalEl.classList.remove('hidden')
}

function closeFolderModal() {
  folderModalEl.classList.add('hidden')
  state.folderAssignIds = []
}

function requestHostSessionName(defaultValue = 'Host Session') {
  return new Promise((resolve) => {
    pendingHostNameResolve = resolve
    if (hostNameInputEl) hostNameInputEl.value = defaultValue
    hostModalEl?.classList.remove('hidden')
    hostNameInputEl?.focus()
    hostNameInputEl?.select()
  })
}

function closeHostNameModal(value) {
  hostModalEl?.classList.add('hidden')
  if (!pendingHostNameResolve) return
  const resolve = pendingHostNameResolve
  pendingHostNameResolve = null
  if (value === null) resolve(null)
  else resolve(String(value || '').trim())
}

function cleanupExpiredDeleted() {
  const now = Date.now()
  let changed = false
  for (const id of Array.from(state.deleted)) {
    const ts = Number(state.deletedAt[id] || 0)
    if (!ts) continue
    if (now - ts >= THIRTY_DAYS_MS) {
      state.deleted.delete(id)
      delete state.deletedAt[id]
      state.files = state.files.filter((f) => f.id !== id)
      changed = true
    }
  }
  if (changed) {
    persistAll()
    render()
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function formatDate(value) {
  return new Date(Number(value || Date.now())).toLocaleString()
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function guessMime(name) {
  const ext = fileExt(name)
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  return 'application/octet-stream'
}

function openPreview(fileId) {
  const file = state.files.find((item) => item.id === fileId)
  if (!file) return
  state.previewFileId = fileId
  previewTitleEl.textContent = file.name
  renderPreviewContent(file)
  previewOverlayEl.classList.remove('hidden')
}

function closePreview() {
  if (!state.previewFileId) return
  state.previewFileId = ''
  previewOverlayEl.classList.add('hidden')
  previewFrameEl.textContent = ''
}

function renderPreviewContent(file) {
  previewFrameEl.textContent = ''
  const type = classifyFile(file)
  if (type === 'image' && file.dataBase64) {
    const img = document.createElement('img')
    img.src = `data:${file.mimeType || guessMime(file.name)};base64,${file.dataBase64}`
    img.alt = file.name
    previewFrameEl.appendChild(img)
    return
  }
  if (type === 'video' && file.dataBase64) {
    const video = document.createElement('video')
    video.controls = true
    video.autoplay = true
    video.src = `data:${file.mimeType || guessMime(file.name)};base64,${file.dataBase64}`
    previewFrameEl.appendChild(video)
    return
  }
  const fallback = document.createElement('div')
  fallback.className = 'preview-frame-fallback'
  fallback.innerHTML = `<h3>${escapeHtml(file.name)}</h3><p>No inline preview available for this file type.</p>`
  previewFrameEl.appendChild(fallback)
}

function readFileAsPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const dataBase64 = result.includes(',') ? result.split(',')[1] : result
      resolve({
        name: file.name,
        byteLength: Number(file.size || 0),
        mimeType: file.type || guessMime(file.name),
        dataBase64
      })
    }
    reader.onerror = () => reject(reader.error || new Error('File read failed'))
    reader.readAsDataURL(file)
  })
}

async function copyToClipboard(value) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    inviteOutputEl.select()
    document.execCommand('copy')
  }
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
      bridge.onWorkerIPC(workerSpecifier, (chunk) => listener(chunk))
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
      if (parsed && parsed.ok === false) throw new Error(parsed.error || 'RPC request failed')
      return parsed && parsed.ok === true ? parsed.result : parsed
    }
  }
}
