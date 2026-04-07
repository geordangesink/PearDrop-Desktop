/* global window, document, navigator, TextDecoder, FileReader, Buffer, localStorage, confirm, Element */

const RPC = require('bare-rpc')
const fs = require('fs/promises')
const nodeFs = require('fs')
const nodePath = require('path')
const { pathToFileURL } = require('url')

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
  START_HOST_FROM_TRANSFER: 9,
  READ_ENTRY_CHUNK: 10
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
const HOST_HISTORY_KEY = 'peardrops.desktop.host-history'
const HOST_HISTORY_REMOVED_KEY = 'peardrops.desktop.host-history-removed'
const THEME_MODE_KEY = 'peardrops.desktop.theme-mode'
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

const inviteOutputTextEl = document.getElementById('invite-output-text')
const inviteRowEl = document.getElementById('invite-row')
const folderFilterEl = document.getElementById('folder-filter')
const filePicker = document.getElementById('file-picker')
const newUploadBtn = document.getElementById('new-upload')
const searchActionBtn = document.getElementById('search-action')
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
const inviteDownloadBarEl = document.getElementById('invite-download-bar')
const inviteDownloadNoteEl = document.getElementById('invite-download-note')
const hostHistoryBarEl = document.getElementById('host-history-bar')
const hostHistoryNoteEl = document.getElementById('host-history-note')
const hostHistoryStartBtn = document.getElementById('host-history-start')
const hostHistoryRemoveBtn = document.getElementById('host-history-remove')
const downloadSelectedDefaultBtn = document.getElementById('download-selected-default')
const downloadSelectedPearBtn = document.getElementById('download-selected-peardrops')
const downloadSelectedBothBtn = document.getElementById('download-selected-both')
const workerLogEl = document.getElementById('worker-log')
const workerActivityBarsEl = document.getElementById('worker-activity-bars')
const themeModeEl = document.getElementById('theme-mode')
const copyFeedbackEl = document.getElementById('copy-feedback')
const shutdownOverlayEl = document.getElementById('shutdown-overlay')
const shutdownMessageEl = document.getElementById('shutdown-message')

const navItems = Array.from(document.querySelectorAll('.sidebar .nav-item'))
const sidebarEl = document.querySelector('.sidebar')

const state = {
  rpc: null,
  view: 'all-files',
  search: '',
  searchResultsQuery: '',
  latestInvite: '',
  latestInviteManifest: [],
  transfers: [],
  activeHosts: [],
  files: loadJson(PREF_KEY, []),
  starred: new Set(loadJson(STARRED_KEY, [])),
  deleted: new Set(loadJson(DELETED_KEY, [])),
  deletedAt: loadJson(DELETED_AT_KEY, {}),
  selected: new Set(),
  folders: loadJson(FOLDERS_KEY, []),
  hostHistory: loadJson(HOST_HISTORY_KEY, []),
  hostHistoryRemoved: new Set(loadJson(HOST_HISTORY_REMOVED_KEY, [])),
  selectedHostHistory: new Set(),
  folderFilter: '',
  openMenuId: '',
  hostDetailInvite: '',
  previewFileId: '',
  folderAssignIds: [],
  inviteEntries: [],
  inviteSelected: new Set(),
  inviteSource: '',
  recentVisible: 10,
  deletedVisible: 10,
  hostingBusy: false,
  themeMode: readThemeMode(),
  copyFeedbackKey: ''
}

let pendingHostNameResolve = null
let copyFeedbackTimer = null
const workerActivityBars = new Map()

if (!bridge || typeof bridge.startWorker !== 'function') {
  statusEl.textContent = 'Desktop bridge failed to load. Check preload configuration.'
  throw new Error('window.bridge is unavailable')
}

void startDesktop()
setTimeout(() => cleanupExpiredDeleted(), 0)
applyThemeMode(state.themeMode)
if (themeModeEl) themeModeEl.value = state.themeMode
updateFolderOptions()
renderSidebarFolders()
render()

bridge.onWorkerStderr(workerSpecifier, (data) => {
  const text = decoder.decode(data)
  if (text.includes('ECONNRESET') || text.includes('connection reset by peer')) return
  setWorkerLogMessage(String(text).trim())
})

bridge.onDeepLink((url) => {
  if (!url.startsWith('peardrops://')) return
  searchInput.value = url
  statusEl.textContent = 'Invite link received via deep link.'
})
bridge.onAppQuitting?.((payload) => {
  const message = String(payload?.message || '').trim()
  if (shutdownMessageEl && message) shutdownMessageEl.textContent = message
  shutdownOverlayEl?.classList.remove('hidden')
})

if (sidebarEl) {
  sidebarEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const item = target.closest('.nav-item')
    if (!(item instanceof HTMLElement)) return
    const nextView = item.dataset.view || 'all-files'
    if (nextView === 'all-files') {
      state.folderFilter = ''
      folderFilterEl.value = ''
    }
    setView(nextView)
  })
}

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
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

searchActionBtn?.addEventListener('click', () => void onSearchAction())
themeModeEl?.addEventListener('change', () => {
  state.themeMode = String(themeModeEl.value || 'system')
  localStorage.setItem(THEME_MODE_KEY, state.themeMode)
  applyThemeMode(state.themeMode)
})
window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
  if (state.themeMode === 'system') applyThemeMode('system')
})

folderFilterEl.addEventListener('change', () => {
  state.folderFilter = folderFilterEl.value
  setView('all-files', { keepFolderFilter: true })
})

sectionBackBtn?.addEventListener('click', () => {
  state.hostDetailInvite = ''
  render()
})

newUploadBtn.addEventListener('click', async () => {
  const picked = normalizePathList(await bridge.pickFiles?.())
  if (picked.length) {
    await importPathsAsLocalFiles(picked)
    return
  }
  filePicker.click()
})
filePicker.addEventListener('change', async () => {
  const sourceFiles = Array.from(filePicker.files || [])
  if (sourceFiles.length === 0) return

  const fromInputPaths = sourceFiles.map((file) => String(file?.path || '')).filter(Boolean)
  if (fromInputPaths.length === sourceFiles.length) {
    await importPathsAsLocalFiles(fromInputPaths)
  } else {
    const now = Date.now()
    const fallback = sourceFiles.map((file, i) => ({
      id: `local:${now}:${i}:${file.name}`,
      name: String(file.name || `file-${i + 1}`),
      byteLength: Number(file.size || 0),
      updatedAt: now,
      source: 'local',
      invite: '',
      mimeType: file.type || guessMime(file.name),
      path: String(file?.path || '')
    }))
    state.files.push(...fallback)
    persistAll()
    statusEl.textContent =
      'Added files, but some are missing local paths. Re-add via native picker for reliable hosting.'
    render()
  }

  filePicker.value = ''
})

downloadBtn.addEventListener('click', async () => {
  await openInviteFilesFromSearch()
})

copyInviteBtn.addEventListener('click', async () => {
  const invite = state.latestInvite
  if (!invite) return void (statusEl.textContent = 'No invite available yet.')
  await copyToClipboard(invite)
  setCopyFeedback('invite-bar', 'Copied')
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
  if (state.view === 'invite-files') {
    state.inviteSelected.clear()
    if (checkAllEl.checked) {
      for (const entry of state.inviteEntries) {
        state.inviteSelected.add(String(entry.drivePath || entry.name))
      }
    }
    render()
    return
  }
  if (state.view === 'host' && !state.hostDetailInvite) {
    const rows = getHostHistoryRows()
    state.selectedHostHistory.clear()
    if (checkAllEl.checked) {
      for (const row of rows) state.selectedHostHistory.add(hostHistoryEntryKey(row))
    }
    render()
    return
  }

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
downloadSelectedDefaultBtn?.addEventListener('click', () => void downloadInviteSelected('download'))
downloadSelectedPearBtn?.addEventListener(
  'click',
  () => void downloadInviteSelected('add-selected')
)
downloadSelectedBothBtn?.addEventListener(
  'click',
  () => void downloadInviteSelected('add-drive-folder')
)
hostHistoryStartBtn?.addEventListener('click', () => void startSelectedHistoryHosts())
hostHistoryRemoveBtn?.addEventListener('click', () => {
  const keys = Array.from(state.selectedHostHistory)
  if (!keys.length) return
  if (!confirm(`Remove ${keys.length} selected host history item(s)?`)) return
  removeFromHistory(keys)
  statusEl.textContent = `Removed ${keys.length} history item(s).`
  render()
})

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
  if (!(target instanceof Element)) return
  const actionNode = target.closest('[data-action]')
  if (!(actionNode instanceof Element)) return
  const action = actionNode.dataset.action
  const id = actionNode.dataset.id
  const index = Number(actionNode.dataset.index || -1)
  if (!action) return

  if (action === 'invite-select') {
    const entry = state.inviteEntries[index]
    if (!entry) return
    const key = String(entry.drivePath || entry.name)
    if (state.inviteSelected.has(key)) state.inviteSelected.delete(key)
    else state.inviteSelected.add(key)
    render()
    return
  }

  if (action === 'invite-download-one') {
    const entry = state.inviteEntries[index]
    if (!entry) return
    state.inviteSelected = new Set([String(entry.drivePath || entry.name)])
    await downloadInviteSelected('download')
    return
  }

  if (action === 'history-select' && id) {
    if (state.selectedHostHistory.has(id)) state.selectedHostHistory.delete(id)
    else state.selectedHostHistory.add(id)
    render()
    return
  }

  if (action === 'select' && id) return void toggleSelect(id)
  if (action === 'star' && id) {
    if (state.starred.has(id)) state.starred.delete(id)
    else state.starred.add(id)
    persistAll()
    return void render()
  }
  if (action === 'delete' && id) {
    const alreadyDeleted = state.deleted.has(id)
    if (alreadyDeleted) {
      if (!confirm('Permanently remove this item from Deleted files?')) return
      wipeDeletedFiles([id], true)
      statusEl.textContent = 'Deleted item permanently removed.'
      return void render()
    }
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
    state.latestInvite = invite
    updateInviteOutput()
    await copyToClipboard(invite)
    setCopyFeedback(`host-copy:${id}`, 'Copied')
    return void (statusEl.textContent = 'Invite copied to clipboard.')
  }
  if (action === 'copy-history-invite' && id) {
    const transfer = state.transfers.find((item) => item.id === id)
    const invite = transfer?.invite || ''
    if (!invite) return void (statusEl.textContent = 'No invite in history for this transfer.')
    state.latestInvite = invite
    updateInviteOutput()
    await copyToClipboard(invite)
    setCopyFeedback(`history-copy:${id}`, 'Copied')
    return void (statusEl.textContent = 'History invite copied to clipboard.')
  }
  if (action === 'remove-history' && id) {
    if (!confirm('Remove this host history item?')) return
    removeFromHistory([id])
    statusEl.textContent = 'History item removed.'
    return void render()
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
    const row = getHostHistoryRows().find((item) => hostHistoryEntryKey(item) === id)
    if (!row) return
    await startHostFromHistoryItem(row)
  }
})

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)
  render()
}

async function hostSelectedFiles(ids) {
  if (state.hostingBusy) return void (statusEl.textContent = 'Host upload is already in progress.')
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

  state.hostingBusy = true
  state.latestInvite = ''
  updateInviteOutput()
  render()
  upsertWorkerActivityBar('host', 'Preparing selected files...', 1, 4)
  setWorkerLogMessage('preparing host upload')
  statusEl.textContent = `Hosting ${payloadFiles.length} selected file(s)...`
  try {
    upsertWorkerActivityBar('host', 'Starting host session...', 2, 4)
    setWorkerLogMessage('starting host session')
    const response = await state.rpc.request(RpcCommand.CREATE_UPLOAD, {
      files: payloadFiles,
      sessionName
    })
    upsertWorkerActivityBar('host', 'Generating invite...', 3, 4)
    rememberHostHistory(response?.transfer, {
      sessionName,
      manifest: response?.manifest || [],
      invite: response?.nativeInvite || response?.invite || '',
      totalBytes: payloadFiles.reduce((sum, item) => sum + Number(item?.byteLength || 0), 0),
      fileCount: payloadFiles.length
    })
    const invite = response.nativeInvite || response.invite || ''
    state.latestInvite = invite
    updateInviteOutput()
    const now = Date.now()
    for (const file of activeFiles) {
      upsertFile({ ...file, invite, updatedAt: now, source: 'upload' })
    }
    upsertWorkerActivityBar('host', 'Host ready', 4, 4)
    setWorkerLogMessage('host session ready')
    statusEl.textContent = `Hosting ready for ${payloadFiles.length} file(s).`
    await Promise.all([refreshTransfers(), refreshActiveHosts()])
    render()
  } catch (error) {
    setWorkerLogMessage(`host upload failed - ${error.message || String(error)}`)
    statusEl.textContent = `Host upload failed: ${error.message || String(error)}`
  } finally {
    setTimeout(() => clearWorkerActivityBar('host'), 700)
    state.hostingBusy = false
    render()
  }
}

async function toUploadPayload(file) {
  const localPath = String(
    file.path || file.localPath || file.absolutePath || file.downloadPath || ''
  ).trim()
  if (localPath) {
    return { name: file.name, mimeType: file.mimeType || guessMime(file.name), path: localPath }
  }
  if (typeof file.dataBase64 === 'string') {
    return {
      name: file.name,
      mimeType: file.mimeType || guessMime(file.name),
      dataBase64: file.dataBase64
    }
  }

  if (file.invite && state.rpc) {
    try {
      const manifest = await state.rpc.request(RpcCommand.GET_MANIFEST, { invite: file.invite })
      const files = Array.isArray(manifest?.files) ? manifest.files : []
      const manifestEntry =
        files.find((entry) => String(entry.drivePath || '') === String(file.drivePath || '')) ||
        files.find((entry) => String(entry.name || '') === String(file.name || '')) ||
        files[0]
      if (manifestEntry?.drivePath) {
        const read = await state.rpc.request(RpcCommand.READ_ENTRY, {
          invite: file.invite,
          drivePath: manifestEntry.drivePath
        })
        const dataBase64 = String(read?.dataBase64 || '')
        if (dataBase64) {
          upsertFile({
            ...file,
            dataBase64,
            drivePath: manifestEntry.drivePath,
            mimeType: file.mimeType || manifestEntry.mimeType || guessMime(file.name)
          })
          return {
            name: file.name,
            mimeType: file.mimeType || manifestEntry.mimeType || guessMime(file.name),
            dataBase64
          }
        }
      }
    } catch {
      // fall through to null if invite re-hydration is unavailable
    }
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
    syncHostHistoryFromTransfers(state.transfers)
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
  syncHostHistoryFromTransfers(state.transfers)
  transferCountEl.textContent = `${state.transfers.length} transfers indexed`
}

async function refreshActiveHosts() {
  if (!state.rpc) return
  const response = await state.rpc.request(RpcCommand.LIST_ACTIVE_HOSTS, {})
  state.activeHosts = response.hosts || []
}

function render() {
  for (const item of navItems) {
    const isAllFilesTab = item.dataset.view === 'all-files'
    const active =
      item.dataset.view === state.view &&
      !(isAllFilesTab && state.folderFilter && state.view === 'all-files')
    item.classList.toggle('active', active)
  }
  folderFilterEl.classList.toggle('active-filter', Boolean(state.folderFilter))
  renderSidebarFolders()
  updateInviteOutput()
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
    'search-results': ['Search results', 'Local files matching your search query.'],
    'invite-files': ['View drive', 'Browse invite drive and choose what to add or download.'],
    recent: ['Recent', 'Last 10 files added locally (upload or download).'],
    starred: ['Starred', 'Starred files and folder-contained files.'],
    host: ['Host', 'Active host sessions and upload history.'],
    deleted: ['Deleted files', 'Auto-cleaned after 30 days.']
  }
  const [title, sub] = titles[state.view] || titles['all-files']
  if (state.view === 'all-files' && state.folderFilter) {
    const folder = state.folders.find((item) => item.id === state.folderFilter)
    sectionTitleEl.textContent = folder?.name || 'All files'
    sectionSubtitleEl.textContent = folder
      ? `Files inside "${folder.name}".`
      : 'Everything available in the app.'
  } else {
    sectionTitleEl.textContent =
      state.view === 'host' && state.hostDetailInvite ? 'Host details' : title
    sectionSubtitleEl.textContent = sub
  }
  sectionBackBtn?.classList.toggle('hidden', !(state.view === 'host' && state.hostDetailInvite))
  clearDeletedBtn?.classList.toggle('hidden', state.view !== 'deleted')
  homeViewEl.classList.add('hidden')
  listViewEl.classList.remove('hidden')
  folderActionsEl.classList.toggle('hidden', !state.folderFilter)
  inviteDownloadBarEl?.classList.toggle('hidden', state.view !== 'invite-files')
  folderFilterEl.disabled = state.view === 'invite-files'
  if (state.view === 'host') {
    renderBulkBar([])
    renderHostHistoryBar(getHostHistoryRows())
    renderHostRows()
  } else if (state.view === 'invite-files') {
    renderBulkBar([])
    renderHostHistoryBar([])
    renderInviteRows()
  } else {
    renderBulkBar(files)
    renderHostHistoryBar([])
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
  bulkInviteBtn.textContent = state.hostingBusy ? 'Hosting...' : 'Host Upload'
  bulkInviteBtn.disabled = state.hostingBusy
}

function renderHostHistoryBar(historyRows) {
  if (!hostHistoryBarEl || !hostHistoryNoteEl) return
  const rows = Array.isArray(historyRows) ? historyRows : []
  const selected = rows.filter((row) =>
    state.selectedHostHistory.has(hostHistoryEntryKey(row))
  ).length
  if (state.view !== 'host' || state.hostDetailInvite || selected === 0) {
    hostHistoryBarEl.classList.add('hidden')
    hostHistoryNoteEl.textContent = '0 selected'
    return
  }
  hostHistoryBarEl.classList.remove('hidden')
  hostHistoryNoteEl.textContent = `${selected} selected`
}

function setView(view, options = {}) {
  const keepFolderFilter = Boolean(options.keepFolderFilter)
  const previousView = state.view
  if (state.view === 'host' && view !== 'host') state.hostDetailInvite = ''
  state.view = view
  if (previousView !== view) {
    state.latestInvite = ''
    updateInviteOutput()
  }
  state.selected.clear()
  state.selectedHostHistory.clear()
  state.inviteSelected.clear()
  state.openMenuId = ''
  if (view === 'recent') state.recentVisible = 10
  if (view === 'deleted') state.deletedVisible = 10
  if (view === 'all-files') {
    state.hostDetailInvite = ''
    if (!keepFolderFilter) {
      state.folderFilter = ''
      folderFilterEl.value = ''
    }
  }
  if (view !== 'search-results') state.searchResultsQuery = ''
  if (view !== 'invite-files') state.inviteEntries = []
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

  const history = getHostHistoryRows().map((transfer) => ({
    id: `history:${hostHistoryEntryKey(transfer)}`,
    historyKey: hostHistoryEntryKey(transfer),
    name: transfer.sessionLabel || transfer.sessionName || transfer.invite || 'Upload history',
    byteLength: Number(transfer.totalBytes || 0),
    updatedAt: Number(transfer.createdAt || Date.now()),
    source: 'history',
    invite: transfer.invite || '',
    transferId: String(transfer.transferId || transfer.id || ''),
    manifest: transfer.manifest || [],
    historySummary: true
  }))

  if (history.length) {
    output.push({ separator: true, label: 'History' }, ...history)
  }

  renderRows(output)
}

function getHostHistoryRows() {
  const activeInvites = new Set(state.activeHosts.map((host) => String(host.invite || '')))
  const activeTransferIds = new Set(state.activeHosts.map((host) => String(host.transferId || '')))
  return mergeHostHistory(
    state.hostHistory,
    state.transfers.filter((item) => item.type === 'upload')
  )
    .filter((item) => !state.hostHistoryRemoved.has(hostHistoryEntryKey(item)))
    .filter((item) => {
      const invite = String(item.invite || '')
      const transferId = String(item.transferId || item.id || '')
      if (invite && activeInvites.has(invite)) return false
      if (transferId && activeTransferIds.has(transferId)) return false
      return true
    })
    .slice(0, 15)
}

function removeFromHistory(keys) {
  const removeKeys = new Set(
    (Array.isArray(keys) ? keys : []).map((value) => String(value || '').trim()).filter(Boolean)
  )
  if (!removeKeys.size) return
  state.hostHistory = state.hostHistory.filter((item) => !removeKeys.has(hostHistoryEntryKey(item)))
  for (const key of removeKeys) state.hostHistoryRemoved.add(key)
  for (const key of removeKeys) state.selectedHostHistory.delete(key)
  persistAll()
}

async function startHostFromHistoryItem(historyEntry) {
  if (!historyEntry) return
  const transferId = String(historyEntry.transferId || historyEntry.id || '').trim()
  if (!transferId) return
  const key = hostHistoryEntryKey(historyEntry)
  const sessionName =
    String(historyEntry.sessionName || historyEntry.sessionLabel || 'Host Session').trim() ||
    'Host Session'
  upsertWorkerActivityBar('host', 'Starting host session...', 1, 3)
  setWorkerLogMessage('starting host from history')
  try {
    const response = await state.rpc.request(RpcCommand.START_HOST_FROM_TRANSFER, {
      transferId,
      sessionName
    })
    upsertWorkerActivityBar('host', 'Preparing invite...', 2, 3)
    rememberHostHistory(response?.transfer, {
      sessionName,
      manifest: response?.manifest || [],
      invite: response?.nativeInvite || response?.invite || ''
    })
    const invite = response.nativeInvite || response.invite || ''
    if (invite) {
      state.latestInvite = invite
      updateInviteOutput()
      statusEl.textContent = 'Hosting started from history.'
    }
    upsertWorkerActivityBar('host', 'Host ready', 3, 3)
    setWorkerLogMessage('host from history ready')
    state.selectedHostHistory.delete(key)
    await Promise.all([refreshTransfers(), refreshActiveHosts()])
    render()
  } catch (error) {
    setWorkerLogMessage(`host from history failed - ${error.message || String(error)}`)
    statusEl.textContent = `Host start failed: ${error.message || String(error)}`
  } finally {
    setTimeout(() => clearWorkerActivityBar('host'), 600)
  }
}

async function startSelectedHistoryHosts() {
  const keys = Array.from(state.selectedHostHistory)
  if (!keys.length) {
    statusEl.textContent = 'Select one or more history items first.'
    return
  }
  const rows = getHostHistoryRows().filter((row) => keys.includes(hostHistoryEntryKey(row)))
  if (!rows.length) {
    statusEl.textContent = 'Selected history items are no longer available.'
    state.selectedHostHistory.clear()
    render()
    return
  }
  for (const row of rows) {
    // Start sequentially to keep worker state transitions clear.
    // eslint-disable-next-line no-await-in-loop
    await startHostFromHistoryItem(row)
  }
  render()
}

function renderRows(files) {
  rowsEl.textContent = ''
  const rows = Array.isArray(files) ? files : []
  const allDataRows = rows.filter((row) => !row.separator)
  const selectableRows =
    state.view === 'host'
      ? allDataRows.filter((row) => row.historySummary)
      : allDataRows.filter((row) => !row.hostSummary && !row.historySummary)
  const selectedVisible =
    state.view === 'host'
      ? selectableRows.filter((row) => state.selectedHostHistory.has(row.historyKey)).length
      : selectableRows.filter((row) => state.selected.has(row.id)).length

  if (state.view === 'host') {
    const allHistorySelected =
      selectableRows.length > 0 && selectedVisible === selectableRows.length
    const includesNonSelectableRows = allDataRows.length > selectableRows.length
    checkAllEl.checked = allHistorySelected && !includesNonSelectableRows
    checkAllEl.indeterminate =
      selectedVisible > 0 && (!allHistorySelected || includesNonSelectableRows)
  } else {
    checkAllEl.checked = selectableRows.length > 0 && selectedVisible === selectableRows.length
    checkAllEl.indeterminate = selectedVisible > 0 && selectedVisible < selectableRows.length
  }

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
      ? `<div class="actions-wrap"><button class="mini-btn" data-action="open-host" data-id="${file.invite}">Open</button><button class="mini-btn danger-btn" data-action="stop-host" data-id="${file.invite}">Stop hosting</button><button class="mini-btn" data-action="copy" data-id="${file.id}">${state.copyFeedbackKey === `host-copy:${file.id}` ? 'Copied' : 'Copy invite'}</button></div>`
      : isHistorySummary
        ? `<div class="actions-wrap"><button class="mini-btn" data-action="restart-host" data-id="${file.historyKey}">Start hosting</button><button class="mini-btn danger-btn" data-action="remove-history" data-id="${file.historyKey}">Remove</button>${file.invite ? `<button class="mini-btn" data-action="copy-history-invite" data-id="${file.transferId}">${state.copyFeedbackKey === `history-copy:${file.transferId}` ? 'Copied' : 'Copy invite'}</button>` : ''}</div>`
        : `<div class="actions-wrap">
          <button class="icon-btn ${starred ? 'starred' : ''}" data-action="star" data-id="${file.id}">${starred ? '★' : '☆'}</button>
          <button class="icon-btn delete" data-action="delete" data-id="${file.id}">${TRASH_SVG}</button>
          <span class="menu">
            <button class="icon-btn" data-action="menu" data-id="${file.id}">⋯</button>
            ${state.openMenuId === file.id ? `<div class="menu-panel"><button class="menu-item" data-action="host" data-id="${file.id}" ${state.hostingBusy ? 'disabled' : ''}>${state.hostingBusy ? 'Hosting...' : 'Host Upload'}</button><button class="menu-item" data-action="copy" data-id="${file.id}">Copy Invite</button><button class="menu-item" data-action="folder" data-id="${file.id}">Put In Folder</button>${file.folderId ? `<button class="menu-item" data-action="unfolder" data-id="${file.id}">Remove From Folder</button>` : ''}<button class="menu-item" data-action="folder-invite" data-id="${file.id}">Invite Folder</button></div>` : ''}
          </span>
        </div>`
    const checkHtml = isHostSummary
      ? ''
      : isHistorySummary
        ? `<input type="checkbox" data-action="history-select" data-id="${file.historyKey}" ${state.selectedHostHistory.has(file.historyKey) ? 'checked' : ''} />`
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
  if (type === 'image') {
    const src = resolveImageSrc(file)
    if (src) return `${start}<div class="preview"><img alt="preview" src="${src}" /></div>${end}`
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

function sanitizeName(name) {
  return String(name || '')
    .replaceAll('/', '_')
    .replaceAll('\\', '_')
}

function folderNameById(id) {
  if (!id) return ''
  return state.folders.find((folder) => folder.id === id)?.name || ''
}

function selectVisibleFiles() {
  const query = state.view === 'search-results' ? state.searchResultsQuery : state.search
  return selectByView(state.view).filter((file) => {
    if (file.separator) return true
    if (state.view !== 'search-results' && state.view !== 'invite-files') {
      if (state.folderFilter && file.folderId !== state.folderFilter) return false
    }
    if (!query) return true
    return file.name.toLowerCase().includes(query)
  })
}

function renderInviteRows() {
  rowsEl.textContent = ''
  const entries = state.inviteEntries
  const selectedCount = entries.filter((entry) =>
    state.inviteSelected.has(String(entry.drivePath || entry.name))
  ).length
  if (inviteDownloadNoteEl) inviteDownloadNoteEl.textContent = `${selectedCount} selected`
  checkAllEl.checked = entries.length > 0 && selectedCount === entries.length
  checkAllEl.indeterminate = selectedCount > 0 && selectedCount < entries.length

  if (!entries.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td colspan="6" class="row-muted">No files loaded from invite.</td>'
    rowsEl.appendChild(tr)
    return
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const key = String(entry.drivePath || entry.name)
    const checked = state.inviteSelected.has(key) ? 'checked' : ''
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><input type="checkbox" data-action="invite-select" data-index="${i}" ${checked} /></td>
      <td><div class="preview">${escapeHtml(fileExt(entry.name).toUpperCase() || 'FILE')}</div></td>
      <td>${escapeHtml(entry.name || `File ${i + 1}`)}</td>
      <td class="row-muted">--</td>
      <td class="row-muted">${formatBytes(Number(entry.byteLength || 0))}</td>
      <td><button class="mini-btn" data-action="invite-download-one" data-index="${i}">Download</button></td>
    `
    rowsEl.appendChild(tr)
  }
}

function selectByView(view) {
  const all = state.files
  if (view === 'invite-files') return []
  if (view === 'search-results') {
    return all
      .filter((file) => !state.deleted.has(file.id))
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }
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
  if (state.view === 'invite-files' || state.view === 'search-results') {
    loadMoreBtn.classList.add('hidden')
    return
  }
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

function updateInviteOutput() {
  if (!inviteOutputTextEl) return
  const invite = String(state.latestInvite || '').trim()
  inviteOutputTextEl.textContent = invite
  if (inviteRowEl) inviteRowEl.classList.toggle('hidden', !invite)
}

async function onSearchAction() {
  const raw = String(searchInput.value || '').trim()
  if (!raw) {
    statusEl.textContent = 'Enter search text or paste an invite URL.'
    return
  }

  const isInvite = raw.startsWith('peardrops://invite') || raw.startsWith('peardrops-web://join')
  if (isInvite) {
    await openInviteFiles(raw)
    return
  }

  state.search = raw.toLowerCase()
  state.searchResultsQuery = state.search
  setView('search-results')
  statusEl.textContent = `Local search for "${raw}"`
}

async function openInviteFilesFromSearch() {
  const invite = String(searchInput.value || '').trim()
  if (!invite) {
    statusEl.textContent = 'Paste an invite URL into the search field first.'
    return
  }
  await openInviteFiles(invite)
}

async function openInviteFiles(invite) {
  if (!state.rpc) {
    statusEl.textContent = 'Worker is still starting.'
    return
  }
  try {
    statusEl.textContent = 'Loading invite manifest...'
    const manifest = await state.rpc.request(RpcCommand.GET_MANIFEST, { invite })
    state.inviteSource = invite
    state.inviteEntries = Array.isArray(manifest.files) ? manifest.files : []
    state.search = ''
    state.searchResultsQuery = ''
    setView('invite-files')
    state.inviteSelected = new Set(
      state.inviteEntries.map((entry) => String(entry.drivePath || entry.name))
    )
    render()
    statusEl.textContent = `Loaded ${state.inviteEntries.length} drive file(s).`
  } catch (error) {
    statusEl.textContent = `Invite load failed: ${error.message || String(error)}`
  }
}

async function downloadInviteSelected(mode) {
  if (!state.rpc) return
  const selectedEntries = state.inviteEntries.filter((entry) =>
    state.inviteSelected.has(String(entry.drivePath || entry.name))
  )
  const picked = mode === 'add-drive-folder' ? state.inviteEntries.slice() : selectedEntries
  if (!picked.length) {
    statusEl.textContent = 'Select one or more drive files first.'
    return
  }

  const shouldDownload = mode === 'download'
  const shouldAddToApp = mode === 'add-selected' || mode === 'add-drive-folder'

  let targetDir = ''
  if (shouldDownload) {
    targetDir = String((await bridge.getDownloadsPath?.()) || '')
    if (!targetDir) {
      statusEl.textContent = 'Could not resolve default Downloads folder.'
      return
    }
  }

  let folderId = ''
  if (mode === 'add-drive-folder') {
    const folder = ensureFolder(`Drive ${new Date().toLocaleDateString()}`)
    folderId = folder.id
  }

  statusEl.textContent = shouldDownload
    ? `Downloading ${picked.length} file(s)...`
    : mode === 'add-drive-folder'
      ? `Adding ${picked.length} drive file(s) as folder...`
      : `Adding ${picked.length} selected file(s) to app...`
  setWorkerLogMessage(
    shouldDownload ? 'downloading selected invite files' : 'adding selected drive files to app'
  )
  const knownTotalBytes = picked.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry?.byteLength || 0)),
    0
  )
  const totalBytes = Math.max(1, knownTotalBytes)
  const useByteProgress = knownTotalBytes > 0
  let downloadedBytes = 0
  upsertWorkerActivityBar(
    'download',
    'Downloading selected files...',
    0,
    useByteProgress ? totalBytes : picked.length,
    {
      subtitle: 'Current file: preparing...',
      displayMode: useByteProgress ? 'bytes' : 'count'
    }
  )
  try {
    const now = Date.now()
    for (let i = 0; i < picked.length; i++) {
      const entry = picked[i]
      upsertWorkerActivityBar(
        'download',
        'Downloading selected files...',
        useByteProgress ? downloadedBytes : i,
        useByteProgress ? totalBytes : picked.length,
        {
          subtitle: `Current file: ${entry.name || `file-${i + 1}`}`,
          displayMode: useByteProgress ? 'bytes' : 'count'
        }
      )
      let writtenPath = ''
      let writer = null
      const fileBuffers = []
      let fileDoneBytes = 0
      const expectedFileBytes = Math.max(0, Number(entry.byteLength || 0))
      if (shouldDownload) {
        const outDir = String((await bridge.getDownloadsPath?.()) || targetDir)
        if (!outDir) continue
        await fs.mkdir(outDir, { recursive: true })
        writtenPath = nodePath.join(outDir, sanitizeName(entry.name || `file-${i + 1}`))
        writer = nodeFs.createWriteStream(writtenPath)
      }

      const includeData = false
      if (expectedFileBytes > 0) {
        while (fileDoneBytes < expectedFileBytes) {
          const chunk = await state.rpc.request(RpcCommand.READ_ENTRY_CHUNK, {
            invite: state.inviteSource,
            drivePath: entry.drivePath,
            offset: fileDoneBytes,
            length: Math.min(256 * 1024, expectedFileBytes - fileDoneBytes)
          })
          const bytes = Buffer.from(String(chunk?.dataBase64 || ''), 'base64')
          if (!bytes.byteLength) break
          fileDoneBytes += bytes.byteLength
          if (writer) writer.write(bytes)
          if (includeData) fileBuffers.push(bytes)
          downloadedBytes += bytes.byteLength
          upsertWorkerActivityBar(
            'download',
            'Downloading selected files...',
            useByteProgress ? downloadedBytes : i,
            useByteProgress ? totalBytes : picked.length,
            {
              subtitle: `Current file: ${entry.name || `file-${i + 1}`}`,
              displayMode: useByteProgress ? 'bytes' : 'count'
            }
          )
        }
      } else {
        const read = await state.rpc.request(RpcCommand.READ_ENTRY, {
          invite: state.inviteSource,
          drivePath: entry.drivePath
        })
        const bytes = Buffer.from(String(read.dataBase64 || ''), 'base64')
        fileDoneBytes = bytes.byteLength
        if (writer) writer.write(bytes)
        if (includeData) fileBuffers.push(bytes)
        downloadedBytes += bytes.byteLength
      }

      if (writer) await new Promise((resolve) => writer.end(resolve))

      if (shouldAddToApp) {
        upsertFile({
          id: `invite:${now}:${i}:${entry.name}`,
          name: entry.name || `file-${i + 1}`,
          byteLength: fileDoneBytes || Number(entry.byteLength || 0),
          updatedAt: Date.now(),
          source: 'download',
          invite: state.inviteSource,
          mimeType: entry.mimeType || 'application/octet-stream',
          dataBase64: includeData ? Buffer.concat(fileBuffers).toString('base64') : '',
          path: writtenPath,
          drivePath: entry.drivePath || '',
          folderId
        })
      }
      upsertWorkerActivityBar(
        'download',
        'Downloading selected files...',
        useByteProgress ? downloadedBytes : i + 1,
        useByteProgress ? totalBytes : picked.length,
        {
          subtitle: `Current file: ${entry.name || `file-${i + 1}`}`,
          displayMode: useByteProgress ? 'bytes' : 'count'
        }
      )
    }

    await refreshTransfers()
    render()
    statusEl.textContent = shouldDownload
      ? `Downloaded ${picked.length} file(s).`
      : mode === 'add-drive-folder'
        ? `Added drive as folder with ${picked.length} file(s).`
        : `Added ${picked.length} selected file(s) to app.`
  } finally {
    clearWorkerActivityBar('download')
  }
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
  localStorage.setItem(HOST_HISTORY_KEY, JSON.stringify(state.hostHistory.slice(0, 300)))
  localStorage.setItem(
    HOST_HISTORY_REMOVED_KEY,
    JSON.stringify(Array.from(state.hostHistoryRemoved).slice(0, 600))
  )
}

function syncHostHistoryFromTransfers(transfers) {
  const uploads = Array.isArray(transfers)
    ? transfers.filter((item) => String(item?.type || '') === 'upload')
    : []
  if (!uploads.length) return
  const merged = mergeHostHistory(state.hostHistory, uploads)
  if (merged.length === state.hostHistory.length) return
  state.hostHistory = merged
  persistAll()
}

function rememberHostHistory(transfer, fallback = {}) {
  const record = transfer || fallback
  if (!record || typeof record !== 'object') return
  const normalized = normalizeHostHistoryRecord(record, fallback)
  if (!normalized) return
  state.hostHistoryRemoved.delete(hostHistoryEntryKey(normalized))
  state.hostHistory = mergeHostHistory([normalized], state.hostHistory)
  persistAll()
}

function mergeHostHistory(primary, secondary) {
  const map = new Map()
  const combined = [
    ...(Array.isArray(primary) ? primary : []),
    ...(Array.isArray(secondary) ? secondary : [])
  ]
  for (const entry of combined) {
    const normalized = normalizeHostHistoryRecord(entry)
    if (!normalized) continue
    const key =
      String(normalized.transferId || normalized.id || '') ||
      String(normalized.invite || '') ||
      `${String(normalized.sessionLabel || normalized.sessionName || 'upload')}:${Number(normalized.createdAt || 0)}`
    if (!key) continue
    const existing = map.get(key)
    if (!existing || Number(normalized.createdAt || 0) >= Number(existing.createdAt || 0)) {
      map.set(key, normalized)
    }
  }
  return Array.from(map.values())
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, 300)
}

function normalizeHostHistoryRecord(entry, fallback = {}) {
  if (!entry || typeof entry !== 'object') return null
  const invite = String(entry.invite || fallback.invite || '')
  const transferId = String(entry.transferId || fallback.transferId || entry.id || '')
  const manifest = Array.isArray(entry.manifest)
    ? entry.manifest
    : Array.isArray(fallback.manifest)
      ? fallback.manifest
      : []
  return {
    ...entry,
    type: 'upload',
    transferId: transferId || String(entry.id || ''),
    invite,
    sessionName: String(entry.sessionName || fallback.sessionName || 'Host Session'),
    sessionLabel: String(
      entry.sessionLabel || fallback.sessionLabel || entry.sessionName || fallback.sessionName || ''
    ),
    createdAt: Number(entry.createdAt || fallback.createdAt || Date.now()),
    totalBytes: Number(entry.totalBytes || fallback.totalBytes || 0),
    fileCount: Number(entry.fileCount || fallback.fileCount || manifest.length || 0),
    manifest
  }
}

function hostHistoryEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return ''
  return String(entry.transferId || entry.id || entry.invite || '').trim()
}

function readThemeMode() {
  const raw = String(localStorage.getItem(THEME_MODE_KEY) || 'system').toLowerCase()
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'system'
}

function applyThemeMode(mode) {
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
  document.body.classList.toggle('theme-light', resolved === 'light')
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
    const active = state.view === 'all-files' && state.folderFilter === folder.id
    btn.className = `folder-item${active ? ' active' : ''}`
    btn.textContent = `📁 ${folder.name}`
    btn.addEventListener('click', () => {
      state.folderFilter = folder.id
      folderFilterEl.value = folder.id
      setView('all-files', { keepFolderFilter: true })
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
  if (type === 'image') {
    const src = resolveImageSrc(file)
    if (!src) {
      const fallback = document.createElement('div')
      fallback.className = 'preview-frame-fallback'
      fallback.innerHTML = `<h3>${escapeHtml(file.name)}</h3><p>No inline preview available for this file type.</p>`
      previewFrameEl.appendChild(fallback)
      return
    }
    const img = document.createElement('img')
    img.src = src
    img.alt = file.name
    previewFrameEl.appendChild(img)
    return
  }
  if (type === 'video') {
    const src = resolveVideoSrc(file)
    if (!src) {
      const fallback = document.createElement('div')
      fallback.className = 'preview-frame-fallback'
      fallback.innerHTML = `<h3>${escapeHtml(file.name)}</h3><p>No inline preview available for this file type.</p>`
      previewFrameEl.appendChild(fallback)
      return
    }
    const video = document.createElement('video')
    video.controls = true
    video.autoplay = true
    video.src = src
    previewFrameEl.appendChild(video)
    return
  }
  const fallback = document.createElement('div')
  fallback.className = 'preview-frame-fallback'
  fallback.innerHTML = `<h3>${escapeHtml(file.name)}</h3><p>No inline preview available for this file type.</p>`
  previewFrameEl.appendChild(fallback)
}

function resolveImageSrc(file) {
  if (typeof file.dataBase64 === 'string') {
    return `data:${file.mimeType || guessMime(file.name)};base64,${file.dataBase64}`
  }
  const localPath = String(file.path || '').trim()
  if (!localPath) return ''
  try {
    return pathToFileURL(localPath).toString()
  } catch {
    return ''
  }
}

function resolveVideoSrc(file) {
  if (typeof file.dataBase64 === 'string') {
    return `data:${file.mimeType || guessMime(file.name)};base64,${file.dataBase64}`
  }
  const localPath = String(file.path || '').trim()
  if (!localPath) return ''
  try {
    return pathToFileURL(localPath).toString()
  } catch {
    return ''
  }
}

function setWorkerLogMessage(message) {
  if (!workerLogEl) return
  const text = String(message || '').trim()
  workerLogEl.textContent = `Worker log: ${text || 'waiting for events.'}`
}

function upsertWorkerActivityBar(id, label, done, total, options = {}) {
  const key = String(id || '').trim()
  if (!key) return
  const safeTotal = Math.max(1, Number(total || 0))
  const safeDone = Math.max(0, Math.min(safeTotal, Number(done || 0)))
  workerActivityBars.set(key, {
    id: key,
    label: String(label || 'Working...'),
    done: safeDone,
    total: safeTotal,
    subtitle: String(options.subtitle || ''),
    displayMode: String(options.displayMode || 'count')
  })
  renderWorkerActivityBars()
}

function clearWorkerActivityBar(id) {
  const key = String(id || '').trim()
  if (!key) return
  if (!workerActivityBars.has(key)) return
  workerActivityBars.delete(key)
  renderWorkerActivityBars()
}

function renderWorkerActivityBars() {
  if (!workerActivityBarsEl) return
  if (workerActivityBars.size === 0) {
    workerActivityBarsEl.classList.add('hidden')
    workerActivityBarsEl.textContent = ''
    return
  }
  workerActivityBarsEl.classList.remove('hidden')
  const barsHtml = Array.from(workerActivityBars.values())
    .map((bar) => {
      const percent = Math.round(
        (Number(bar.done || 0) / Math.max(1, Number(bar.total || 1))) * 100
      )
      const progressText =
        bar.displayMode === 'bytes'
          ? `${percent}% (${formatBytes(Number(bar.done || 0))} / ${formatBytes(Number(bar.total || 0))})`
          : `${Number(bar.done || 0)}/${Math.max(1, Number(bar.total || 1))}`
      const subtitleHtml = bar.subtitle
        ? `<div class="activity-progress-sub">${escapeHtml(bar.subtitle)}</div>`
        : ''
      return `<div class="activity-progress"><div class="activity-progress-label">${escapeHtml(bar.label)} ${progressText}</div>${subtitleHtml}<div class="activity-progress-track"><div class="activity-progress-fill" style="width:${percent}%"></div></div></div>`
    })
    .join('')
  workerActivityBarsEl.innerHTML = barsHtml
}

function setCopyFeedback(key, label = 'Copied') {
  state.copyFeedbackKey = String(key || '')
  if (copyFeedbackEl) {
    copyFeedbackEl.textContent = label
    copyFeedbackEl.classList.remove('hidden')
  }
  render()
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = setTimeout(() => {
    state.copyFeedbackKey = ''
    if (copyFeedbackEl) copyFeedbackEl.classList.add('hidden')
    render()
  }, 1400)
}

function normalizePathList(values) {
  if (!Array.isArray(values)) return []
  return values.map((value) => String(value || '')).filter(Boolean)
}

async function importPathsAsLocalFiles(paths) {
  const picked = normalizePathList(paths)
  if (!picked.length) return
  setWorkerLogMessage('indexing selected local files')
  upsertWorkerActivityBar('ingest', 'Loading files...', 0, picked.length)
  statusEl.textContent = `Loading ${picked.length} file(s)...`
  const now = Date.now()
  const newEntries = []

  for (let i = 0; i < picked.length; i++) {
    const filePath = picked[i]
    let stats = null
    try {
      stats = await fs.stat(filePath)
    } catch {}

    const fileName = nodePath.basename(filePath) || `file-${i + 1}`
    newEntries.push({
      id: `local:${now}:${i}:${fileName}`,
      name: fileName,
      byteLength: Number(stats?.size || 0),
      updatedAt: now,
      source: 'local',
      invite: '',
      mimeType: guessMime(fileName),
      path: filePath
    })
    upsertWorkerActivityBar('ingest', 'Loading files...', i + 1, picked.length)
    if ((i + 1) % 25 === 0) await sleep(0)
  }

  state.files.push(...newEntries)
  persistAll()
  clearWorkerActivityBar('ingest')
  statusEl.textContent = `Added ${newEntries.length} file(s). Select and click "Host Upload" to create invite.`
  render()
}

async function copyToClipboard(value) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const input = document.createElement('input')
    input.value = value
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    input.remove()
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
      Promise.resolve(bridge.writeWorkerIPC(workerSpecifier, data)).catch((error) => {
        const message = String(error?.message || error || '')
        if (!message.includes('No handler registered')) {
          if (workerLogEl) workerLogEl.textContent = `Worker log: IPC write failed: ${message}`
        }
      })
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
