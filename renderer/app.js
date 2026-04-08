/* global window, document, navigator, TextDecoder, Buffer, localStorage */

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

const SOURCES_KEY = 'peardrops.desktop.sources.v1'
const HISTORY_KEY = 'peardrops.desktop.host-history.v1'
const STARRED_HOSTS_KEY = 'peardrops.desktop.starred-hosts.v1'
const workerSpecifier = '/workers/main.js'
const bridge = window.bridge
const decoder = new TextDecoder('utf8')
const workerActivityBars = new Map()

const statusEls = [
  document.getElementById('upload-status'),
  document.getElementById('download-status')
].filter(Boolean)
const workerLogEls = [
  document.getElementById('upload-worker-log'),
  document.getElementById('download-worker-log')
].filter(Boolean)
const workerActivityBarsEls = [
  document.getElementById('upload-worker-activity-bars'),
  document.getElementById('download-worker-activity-bars')
].filter(Boolean)

const uploadTabBtn = document.getElementById('tab-upload')
const downloadTabBtn = document.getElementById('tab-download')
const uploadPageEl = document.getElementById('upload-page')
const downloadPageEl = document.getElementById('download-page')
const inviteInputEl = document.getElementById('invite-input')
const viewDriveBtn = document.getElementById('view-drive')
const downloadSelectedBtn = document.getElementById('download-selected')

const sourceAddBtn = document.getElementById('source-add')
const sourceAddMenuEl = document.getElementById('source-add-menu')
const addFileActionBtn = document.getElementById('add-file-action')
const addFolderActionBtn = document.getElementById('add-folder-action')
const sourceSelectToggleBtn = document.getElementById('source-select-toggle')
const sourceRemoveAllBtn = document.getElementById('source-remove-all')
const hostSelectedBtn = document.getElementById('host-selected')
const sourcesGridEl = document.getElementById('sources-grid')

const driveRowsEl = document.getElementById('drive-files')
const checkAllDriveEl = document.getElementById('check-all-drive')
const driveSelectToggleBtn = document.getElementById('drive-select-toggle')

const hostsRowsEl = document.getElementById('hosts-rows')
const starredRowsEl = document.getElementById('starred-rows')
const hostsSelectToggleBtn = document.getElementById('hosts-select-toggle')
const hostsCopySelectedBtn = document.getElementById('hosts-copy-selected')
const hostsStarSelectedBtn = document.getElementById('hosts-star-selected')
const hostsStopSelectedBtn = document.getElementById('hosts-stop-selected')

const historyRowsEl = document.getElementById('history-rows')
const historySelectToggleBtn = document.getElementById('history-select-toggle')
const historyRehostSelectedBtn = document.getElementById('history-rehost-selected')
const historyRemoveSelectedBtn = document.getElementById('history-remove-selected')

const filePicker = document.getElementById('file-picker')
const shutdownOverlayEl = document.getElementById('shutdown-overlay')
const shutdownMessageEl = document.getElementById('shutdown-message')

const state = {
  rpc: null,
  sources: loadJson(SOURCES_KEY, []),
  selectedSources: new Set(),
  hostHistory: loadJson(HISTORY_KEY, []),
  selectedHistory: new Set(),
  activeHosts: [],
  selectedHosts: new Set(),
  starredHosts: new Set(loadJson(STARRED_HOSTS_KEY, [])),
  inviteEntries: [],
  inviteSelected: new Set(),
  inviteSource: '',
  themeMode: 'system',
  sourceMenuOpen: false,
  currentTab: 'upload'
}

if (!bridge || typeof bridge.startWorker !== 'function') {
  setStatus('Desktop bridge failed to load. Check preload configuration.')
  throw new Error('window.bridge is unavailable')
}

wireGlobalEvents()
wireUiEvents()
void boot()

function wireGlobalEvents() {
  bridge.onWorkerStdout?.(workerSpecifier, (data) => {
    const text = decoder.decode(data).trim()
    if (!text) return
    setWorkerLogMessage(text)
  })

  bridge.onWorkerStderr?.(workerSpecifier, (data) => {
    const text = decoder.decode(data)
    if (text.includes('ECONNRESET') || text.includes('connection reset by peer')) return
    const clean = text.trim()
    if (!clean) return
    setWorkerLogMessage(clean)
  })

  bridge.onDeepLink?.((url) => {
    if (!String(url || '').startsWith('peardrops://')) return
    inviteInputEl.value = url
    setStatus('Invite link received from deep link.')
  })

  bridge.onAppQuitting?.((payload) => {
    const message = String(payload?.message || '').trim()
    if (shutdownMessageEl && message) shutdownMessageEl.textContent = message
    shutdownOverlayEl?.classList.remove('hidden')
  })

  bridge.onThemeMode?.((payload) => {
    applyThemeMode(payload?.mode)
  })

  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
    if (state.themeMode === 'system') applyThemeMode('system')
  })

  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (
      state.sourceMenuOpen &&
      !target.closest('#source-add') &&
      !target.closest('#source-add-menu')
    ) {
      state.sourceMenuOpen = false
      renderSourceMenu()
    }
  })
}

function wireUiEvents() {
  uploadTabBtn.addEventListener('click', () => setTab('upload'))
  downloadTabBtn.addEventListener('click', () => setTab('download'))

  sourceAddBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    state.sourceMenuOpen = !state.sourceMenuOpen
    renderSourceMenu()
  })

  addFileActionBtn.addEventListener('click', async () => {
    state.sourceMenuOpen = false
    renderSourceMenu()
    const picked = normalizePathList(await bridge.pickFiles?.())
    if (picked.length) {
      addLocalSources(picked.map((srcPath) => ({ type: 'file', path: srcPath })))
      return
    }
    filePicker.click()
  })

  addFolderActionBtn.addEventListener('click', async () => {
    state.sourceMenuOpen = false
    renderSourceMenu()
    const dir = String((await bridge.pickDirectory?.()) || '').trim()
    if (!dir) return
    addLocalSources([{ type: 'folder', path: dir }])
  })

  filePicker.addEventListener('change', () => {
    const files = Array.from(filePicker.files || [])
    const paths = files.map((file) => String(file?.path || '')).filter(Boolean)
    if (paths.length) addLocalSources(paths.map((srcPath) => ({ type: 'file', path: srcPath })))
    filePicker.value = ''
  })

  sourceSelectToggleBtn.addEventListener('click', () => {
    if (!state.sources.length) return
    const allSelected = state.selectedSources.size === state.sources.length
    state.selectedSources.clear()
    if (!allSelected) {
      for (const source of state.sources) state.selectedSources.add(source.id)
    }
    renderSources()
  })

  sourceRemoveAllBtn.addEventListener('click', () => {
    if (!state.sources.length) return
    const removed = state.sources.length
    state.sources = []
    state.selectedSources.clear()
    persistSources()
    renderSources()
    setStatus(`Removed ${removed} source entr${removed === 1 ? 'y' : 'ies'}.`)
  })

  hostSelectedBtn.addEventListener('click', () => void hostSelectedSources())

  viewDriveBtn.addEventListener('click', () => void openInviteFiles())
  downloadSelectedBtn.addEventListener('click', () => void downloadInviteSelected())

  driveSelectToggleBtn.addEventListener('click', () => {
    if (!state.inviteEntries.length) return
    const allSelected = state.inviteSelected.size === state.inviteEntries.length
    state.inviteSelected.clear()
    if (!allSelected) {
      for (const entry of state.inviteEntries) state.inviteSelected.add(entryKey(entry))
    }
    renderDriveRows()
  })

  checkAllDriveEl.addEventListener('change', () => {
    state.inviteSelected.clear()
    if (checkAllDriveEl.checked) {
      for (const entry of state.inviteEntries) state.inviteSelected.add(entryKey(entry))
    }
    renderDriveRows()
  })

  driveRowsEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const node = target.closest('[data-action]')
    if (!(node instanceof HTMLElement)) return
    const action = String(node.dataset.action || '')
    const index = Number(node.dataset.index || -1)
    if (action !== 'toggle') return
    if (!Number.isInteger(index) || index < 0 || index >= state.inviteEntries.length) return
    const entry = state.inviteEntries[index]
    const key = entryKey(entry)
    if (state.inviteSelected.has(key)) state.inviteSelected.delete(key)
    else state.inviteSelected.add(key)
    renderDriveRows()
  })

  hostsSelectToggleBtn.addEventListener('click', () => {
    if (!state.activeHosts.length) return
    const allSelected = state.selectedHosts.size === state.activeHosts.length
    state.selectedHosts.clear()
    if (!allSelected) {
      for (const host of state.activeHosts) {
        const invite = String(host.invite || '').trim()
        if (invite) state.selectedHosts.add(invite)
      }
    }
    renderHosts()
  })

  hostsCopySelectedBtn.addEventListener('click', () => void copySelectedHosts())
  hostsStarSelectedBtn.addEventListener('click', () => {
    if (!state.selectedHosts.size) {
      setStatus('Select at least one active host first.')
      return
    }
    for (const invite of state.selectedHosts) state.starredHosts.add(invite)
    persistStarredHosts()
    renderHosts()
    setStatus(`Starred ${state.selectedHosts.size} host${state.selectedHosts.size === 1 ? '' : 's'}.`)
  })
  hostsStopSelectedBtn.addEventListener('click', () => void stopSelectedHosts())

  historySelectToggleBtn.addEventListener('click', () => {
    if (!state.hostHistory.length) return
    const allSelected = state.selectedHistory.size === state.hostHistory.length
    state.selectedHistory.clear()
    if (!allSelected) {
      for (const row of state.hostHistory) state.selectedHistory.add(row.id)
    }
    renderHistory()
  })

  historyRehostSelectedBtn.addEventListener('click', () => void rehostSelectedHistory())
  historyRemoveSelectedBtn.addEventListener('click', () => {
    if (!state.selectedHistory.size) {
      setStatus('Select at least one history item first.')
      return
    }
    const before = state.hostHistory.length
    state.hostHistory = state.hostHistory.filter((row) => !state.selectedHistory.has(row.id))
    const removed = before - state.hostHistory.length
    state.selectedHistory.clear()
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
    renderHistory()
    setStatus(`Removed ${removed} history entr${removed === 1 ? 'y' : 'ies'}.`)
  })

  sourcesGridEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const card = target.closest('[data-source-id]')
    if (!(card instanceof HTMLElement)) return
    const id = String(card.dataset.sourceId || '')
    if (!id) return

    const actionNode = target.closest('[data-action]')
    const action = String(actionNode?.getAttribute('data-action') || '')

    if (action === 'remove-source') {
      state.sources = state.sources.filter((row) => row.id !== id)
      state.selectedSources.delete(id)
      persistSources()
      renderSources()
      return
    }

    if (action === 'toggle-source') {
      if (state.selectedSources.has(id)) state.selectedSources.delete(id)
      else state.selectedSources.add(id)
      renderSources()
      return
    }

    if (action === 'preview-source') {
      const previewUrl = String(actionNode?.getAttribute('data-preview-url') || '').trim()
      if (previewUrl) window.open(previewUrl, '_blank', 'noopener,noreferrer')
    }
  })

  hostsRowsEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const row = target.closest('[data-invite]')
    if (!(row instanceof HTMLElement)) return
    const invite = String(row.dataset.invite || '').trim()
    if (!invite) return

    const actionNode = target.closest('[data-action]')
    const action = String(actionNode?.getAttribute('data-action') || '')

    if (action === 'copy') {
      void copyToClipboard(invite)
      return
    }
    if (action === 'star') {
      if (state.starredHosts.has(invite)) state.starredHosts.delete(invite)
      else state.starredHosts.add(invite)
      persistStarredHosts()
      renderHosts()
      return
    }
    if (action === 'stop') {
      void stopHost(invite)
      return
    }

    if (state.selectedHosts.has(invite)) state.selectedHosts.delete(invite)
    else state.selectedHosts.add(invite)
    renderHosts()
  })

  historyRowsEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const row = target.closest('[data-history-id]')
    if (!(row instanceof HTMLElement)) return
    const id = String(row.dataset.historyId || '').trim()
    if (!id) return

    const actionNode = target.closest('[data-action]')
    const action = String(actionNode?.getAttribute('data-action') || '')

    if (action === 'remove') {
      state.hostHistory = state.hostHistory.filter((entry) => entry.id !== id)
      state.selectedHistory.delete(id)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
      renderHistory()
      return
    }

    if (action === 'rehost') {
      const item = state.hostHistory.find((entry) => entry.id === id)
      if (!item) return
      void rehostHistoryItem(item)
      return
    }

    if (state.selectedHistory.has(id)) state.selectedHistory.delete(id)
    else state.selectedHistory.add(id)
    renderHistory()
  })

  starredRowsEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const row = target.closest('[data-starred-invite]')
    if (!(row instanceof HTMLElement)) return
    const invite = String(row.dataset.starredInvite || '').trim()
    if (!invite) return

    const actionNode = target.closest('[data-action]')
    const action = String(actionNode?.getAttribute('data-action') || '')

    if (action === 'copy') {
      void copyToClipboard(invite)
      return
    }
    if (action === 'unstar') {
      state.starredHosts.delete(invite)
      persistStarredHosts()
      renderHosts()
      return
    }
    if (action === 'stop') {
      void stopHost(invite)
      return
    }
    if (action === 'rehost') {
      const historyId = String(actionNode?.getAttribute('data-history-id') || '').trim()
      if (!historyId) {
        setStatus('No saved host history available for this starred host.')
        return
      }
      const historyItem = state.hostHistory.find((entry) => String(entry.id || '') === historyId)
      if (!historyItem) {
        setStatus('No saved host history available for this starred host.')
        return
      }
      void rehostHistoryItem(historyItem)
    }
  })
}

async function boot() {
  try {
    setWorkerLogMessage('starting worker')
    await bridge.startWorker(workerSpecifier)
    state.rpc = createRpcClient()

    setWorkerLogMessage('initializing worker RPC')
    await state.rpc.request(RpcCommand.INIT, {})

    const mode = await bridge.getThemeMode?.()
    applyThemeMode(mode)

    await refreshActiveHosts()
    renderAll()
    setStatus('Ready.')
    setWorkerLogMessage('ready')
  } catch (error) {
    setStatus(`Worker start failed: ${error.message || String(error)}`)
    setWorkerLogMessage(`start failed: ${error.message || String(error)}`)
  }
}

function createRpcClient() {
  const ipc = {
    on(event, listener) {
      if (event === 'data') {
        bridge.onWorkerIPC(workerSpecifier, (chunk) => listener(Buffer.from(chunk)))
      }
      return ipc
    },
    write(data) {
      Promise.resolve(bridge.writeWorkerIPC(workerSpecifier, data)).catch((error) => {
        const message = String(error?.message || error || '')
        if (message) setWorkerLogMessage(`IPC write failed: ${message}`)
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

function renderAll() {
  renderTabs()
  renderSourceMenu()
  renderSources()
  renderHosts()
  renderHistory()
  renderDriveRows()
}

function setTab(nextTab) {
  state.currentTab = nextTab === 'download' ? 'download' : 'upload'
  renderTabs()
}

function renderTabs() {
  const isUpload = state.currentTab === 'upload'
  uploadTabBtn.classList.toggle('active', isUpload)
  downloadTabBtn.classList.toggle('active', !isUpload)
  uploadPageEl.classList.toggle('hidden', !isUpload)
  downloadPageEl.classList.toggle('hidden', isUpload)
}

function renderSourceMenu() {
  sourceAddMenuEl.classList.toggle('hidden', !state.sourceMenuOpen)
}

function renderSources() {
  sourcesGridEl.textContent = ''
  const allSelected = state.sources.length > 0 && state.selectedSources.size === state.sources.length
  sourceSelectToggleBtn.textContent = allSelected ? 'Deselect All' : 'Select All'

  if (!state.sources.length) {
    sourcesGridEl.innerHTML = '<div class="muted-empty">No local sources added yet.</div>'
    return
  }

  for (const source of state.sources) {
    const selected = state.selectedSources.has(source.id)
    const previewHtml = renderSourcePreview(source)
    const card = document.createElement('article')
    card.className = `source-card${selected ? ' selected' : ''}`
    card.dataset.sourceId = source.id
    card.innerHTML = `
      <div class="source-card-main">
        ${previewHtml}
        <div>
          <div class="source-name">${escapeHtml(source.name || source.path)}</div>
          <div class="source-path">${escapeHtml(source.type.toUpperCase())} · ${escapeHtml(source.path)}</div>
        </div>
        <div class="source-select">
          <input type="checkbox" data-action="toggle-source" ${selected ? 'checked' : ''} />
        </div>
      </div>
      <div class="controls" style="margin-top:8px;">
        <button class="btn alt" data-action="remove-source">Remove</button>
      </div>
    `
    sourcesGridEl.appendChild(card)
  }
}

function renderSourcePreview(source) {
  const type = source?.type === 'folder' ? 'folder' : 'file'
  if (type === 'folder') return '<div class="source-preview">DIR</div>'

  const srcPath = String(source?.path || '').trim()
  const mime = guessMimeType(srcPath)
  if (mime.startsWith('image/')) {
    const src = safeFileUrl(srcPath)
    if (src) {
      return `<button class="source-preview-btn" type="button" data-action="preview-source" data-preview-url="${escapeHtmlAttr(src)}"><div class="source-preview"><img src="${escapeHtmlAttr(src)}" alt="preview"></div></button>`
    }
  }
  if (mime.startsWith('video/')) return '<div class="source-preview">VID</div>'
  const ext = nodePath.extname(srcPath).replace('.', '').slice(0, 4).toUpperCase() || 'FILE'
  return `<div class="source-preview">${escapeHtml(ext)}</div>`
}

function safeFileUrl(filePath) {
  const localPath = String(filePath || '').trim()
  if (!localPath) return ''
  try {
    return pathToFileURL(localPath).toString()
  } catch {
    return ''
  }
}

function renderHosts() {
  hostsRowsEl.textContent = ''

  const hosts = state.activeHosts.slice().sort((a, b) => {
    const aInvite = String(a.invite || '')
    const bInvite = String(b.invite || '')
    const aStar = state.starredHosts.has(aInvite) ? 1 : 0
    const bStar = state.starredHosts.has(bInvite) ? 1 : 0
    if (aStar !== bStar) return bStar - aStar
    return Number(b.createdAt || 0) - Number(a.createdAt || 0)
  })

  const allSelected = hosts.length > 0 && state.selectedHosts.size === hosts.length
  hostsSelectToggleBtn.textContent = allSelected ? 'Deselect All' : 'Select All'

  if (!hosts.length) {
    hostsRowsEl.innerHTML = '<div class="muted-empty">No active hosts.</div>'
    renderStarredHosts()
    return
  }

  for (const host of hosts) {
    const invite = String(host.invite || '').trim()
    const selected = state.selectedHosts.has(invite)
    const starred = state.starredHosts.has(invite)

    const row = document.createElement('div')
    row.className = 'row-item'
    row.dataset.invite = invite
    row.innerHTML = `
      <input type="checkbox" ${selected ? 'checked' : ''} />
      <div>
        <div class="row-title">${starred ? '<span class="star">★</span> ' : ''}${escapeHtml(host.sessionLabel || invite || 'Host')}</div>
        <div class="row-sub">${formatBytes(Number(host.totalBytes || 0))}</div>
      </div>
      <div class="controls">
        <button class="btn alt" data-action="copy">Copy</button>
        <button class="btn alt" data-action="star">${starred ? 'Unstar' : 'Star'}</button>
        <button class="btn warn" data-action="stop">Stop</button>
      </div>
    `
    hostsRowsEl.appendChild(row)
  }
  renderStarredHosts()
}

function renderStarredHosts() {
  starredRowsEl.textContent = ''

  const starredInvites = Array.from(state.starredHosts)
  if (!starredInvites.length) {
    starredRowsEl.innerHTML = '<div class="muted-empty">No starred hosts.</div>'
    return
  }

  const activeByInvite = new Map(
    state.activeHosts.map((host) => [String(host.invite || '').trim(), host])
  )
  const historyByInvite = new Map()
  for (const entry of state.hostHistory) {
    const invite = String(entry?.invite || '').trim()
    if (!invite || historyByInvite.has(invite)) continue
    historyByInvite.set(invite, entry)
  }

  for (const invite of starredInvites) {
    const host = activeByInvite.get(invite)
    const historyItem = historyByInvite.get(invite)
    const label = host?.sessionLabel || 'Starred Host'
    const size = host ? formatBytes(Number(host.totalBytes || 0)) : 'Not active'
    const canStop = Boolean(host)
    const canRehost = Boolean(historyItem && Array.isArray(historyItem.sourceRefs) && historyItem.sourceRefs.length)
    const primaryActionHtml = canStop
      ? '<button class="btn warn" data-action="stop">Stop</button>'
      : canRehost
        ? `<button class="btn alt" data-action="rehost" data-history-id="${escapeHtmlAttr(String(historyItem.id || ''))}">Re-host</button>`
        : ''

    const row = document.createElement('div')
    row.className = 'row-item'
    row.dataset.starredInvite = invite
    row.innerHTML = `
      <div class="star">★</div>
      <div>
        <div class="row-title">${escapeHtml(label)}</div>
        <div class="row-sub">${escapeHtml(size)}</div>
      </div>
      <div class="controls">
        ${primaryActionHtml}
        <button class="btn alt" data-action="copy">Copy</button>
        <button class="btn alt" data-action="unstar">Unstar</button>
      </div>
    `
    starredRowsEl.appendChild(row)
  }
}

function renderHistory() {
  historyRowsEl.textContent = ''

  const allSelected =
    state.hostHistory.length > 0 && state.selectedHistory.size === state.hostHistory.length
  historySelectToggleBtn.textContent = allSelected ? 'Deselect All' : 'Select All'

  if (!state.hostHistory.length) {
    historyRowsEl.innerHTML = '<div class="muted-empty">No host history yet.</div>'
    return
  }

  for (const item of state.hostHistory) {
    const selected = state.selectedHistory.has(item.id)
    const sourceSummary = (item.sourceRefs || []).map((ref) => ref.path).join(' | ') || 'No source paths'

    const row = document.createElement('div')
    row.className = 'row-item'
    row.dataset.historyId = String(item.id || '')
    row.innerHTML = `
      <input type="checkbox" ${selected ? 'checked' : ''} />
      <div>
        <div class="row-title">${escapeHtml(item.sessionName || 'Host Session')}</div>
        <div class="row-sub">${escapeHtml(sourceSummary)}</div>
      </div>
      <div class="controls">
        <button class="btn alt" data-action="rehost">Re-host</button>
        <button class="btn warn" data-action="remove">Remove</button>
      </div>
    `
    historyRowsEl.appendChild(row)
  }
}

function renderDriveRows() {
  driveRowsEl.textContent = ''

  const allSelected =
    state.inviteEntries.length > 0 && state.inviteSelected.size === state.inviteEntries.length
  driveSelectToggleBtn.textContent = allSelected ? 'Deselect All' : 'Select All'

  if (!state.inviteEntries.length) {
    const tr = document.createElement('tr')
    tr.innerHTML = '<td colspan="4" class="small">No drive loaded.</td>'
    driveRowsEl.appendChild(tr)
    checkAllDriveEl.checked = false
    checkAllDriveEl.indeterminate = false
    return
  }

  let selectedCount = 0
  for (let i = 0; i < state.inviteEntries.length; i++) {
    const entry = state.inviteEntries[i]
    const key = entryKey(entry)
    const checked = state.inviteSelected.has(key)
    if (checked) selectedCount += 1
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><input type="checkbox" data-action="toggle" data-index="${i}" ${checked ? 'checked' : ''}></td>
      <td>${escapeHtml(entry.name || nodePath.basename(String(entry.drivePath || '')) || `File ${i + 1}`)}</td>
      <td class="small">${escapeHtml(String(entry.drivePath || ''))}</td>
      <td class="small">${formatBytes(Number(entry.byteLength || 0))}</td>
    `
    driveRowsEl.appendChild(tr)
  }

  checkAllDriveEl.checked = selectedCount === state.inviteEntries.length
  checkAllDriveEl.indeterminate = selectedCount > 0 && selectedCount < state.inviteEntries.length
}

async function openInviteFiles() {
  if (!state.rpc) return setStatus('Worker is still starting.')
  const invite = normalizeInvite(inviteInputEl.value)
  if (!invite) return setStatus('Paste a peardrops invite URL first.')

  try {
    setWorkerLogMessage('loading invite manifest')
    const manifest = await state.rpc.request(RpcCommand.GET_MANIFEST, { invite })
    const entries = Array.isArray(manifest?.files) ? manifest.files : []
    state.inviteSource = invite
    state.inviteEntries = entries
    state.inviteSelected = new Set(entries.map((entry) => entryKey(entry)))
    renderDriveRows()
    setStatus(`Drive loaded (${entries.length} file${entries.length === 1 ? '' : 's'}).`)
  } catch (error) {
    setStatus(`View drive failed: ${error.message || String(error)}`)
  }
}

async function downloadInviteSelected() {
  if (!state.rpc) return setStatus('Worker is still starting.')
  if (!state.inviteSource) return setStatus('Load an invite drive first.')

  const selected = state.inviteEntries.filter((entry) => state.inviteSelected.has(entryKey(entry)))
  if (!selected.length) return setStatus('Select at least one drive file to download.')

  let targetDir = String((await bridge.pickDirectory?.()) || '').trim()
  if (!targetDir) targetDir = String((await bridge.getDownloadsPath?.()) || '').trim()
  if (!targetDir) return setStatus('No destination selected.')

  try {
    upsertWorkerActivityBar('download-selected', 'Downloading selected files', 0, selected.length)

    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i]
      const drivePath = String(entry?.drivePath || '').trim()
      if (!drivePath) continue
      const outputPath = resolveOutputPath(targetDir, entry)
      await fs.mkdir(nodePath.dirname(outputPath), { recursive: true })
      await writeEntryToFile(state.rpc, state.inviteSource, drivePath, outputPath, Number(entry.byteLength || 0))
      upsertWorkerActivityBar('download-selected', 'Downloading selected files', i + 1, selected.length)
    }

    clearWorkerActivityBar('download-selected')
    setStatus(`Downloaded ${selected.length} file${selected.length === 1 ? '' : 's'} to ${targetDir}.`)
  } catch (error) {
    clearWorkerActivityBar('download-selected')
    setStatus(`Download failed: ${error.message || String(error)}`)
  }
}

async function hostSelectedSources() {
  if (!state.rpc) return setStatus('Worker is still starting.')

  const ids = Array.from(state.selectedSources)
  if (!ids.length) return setStatus('Select at least one local source first.')

  const picked = state.sources.filter((item) => ids.includes(item.id))
  if (!picked.length) return setStatus('Selected sources are no longer available.')

  try {
    upsertWorkerActivityBar('host-expand', 'Indexing local sources', 0, picked.length)

    const files = []
    for (let i = 0; i < picked.length; i++) {
      const source = picked[i]
      // Re-host/source-host must fail when saved source paths no longer exist.
      // eslint-disable-next-line no-await-in-loop
      const expanded = await expandSourceToFiles(source)
      files.push(...expanded)
      upsertWorkerActivityBar('host-expand', 'Indexing local sources', i + 1, picked.length)
    }

    clearWorkerActivityBar('host-expand')

    if (!files.length) return setStatus('No readable files found in selected sources.')

    setWorkerLogMessage('creating upload host')
    upsertWorkerActivityBar('host-upload', 'Creating host upload', 0, 1)

    const sessionName = `Host ${new Date().toLocaleString()}`
    const response = await state.rpc.request(RpcCommand.CREATE_UPLOAD, {
      files,
      sessionName
    })

    clearWorkerActivityBar('host-upload')

    const invite = String(response?.nativeInvite || response?.invite || '').trim()
    rememberHistory({
      id: `hist:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
      sourceRefs: picked.map((item) => ({ type: item.type, path: item.path, name: item.name })),
      invite,
      sessionName,
      createdAt: Date.now(),
      fileCount: Array.isArray(response?.manifest) ? response.manifest.length : files.length,
      totalBytes: Number(response?.transfer?.totalBytes || files.reduce((sum, row) => sum + Number(row.byteLength || 0), 0))
    })

    state.selectedSources.clear()
    await refreshActiveHosts()
    renderAll()
    setStatus('Hosting started.')
  } catch (error) {
    clearWorkerActivityBar('host-expand')
    clearWorkerActivityBar('host-upload')
    setStatus(`Host failed: ${error.message || String(error)}`)
  }
}

async function refreshActiveHosts() {
  if (!state.rpc) return
  try {
    const response = await state.rpc.request(RpcCommand.LIST_ACTIVE_HOSTS, {})
    const hosts = Array.isArray(response?.hosts) ? response.hosts : []
    state.activeHosts = hosts

    const validInvites = new Set(hosts.map((host) => String(host.invite || '').trim()).filter(Boolean))
    state.selectedHosts = new Set(Array.from(state.selectedHosts).filter((invite) => validInvites.has(invite)))

    renderHosts()
  } catch {
    state.activeHosts = []
    state.selectedHosts.clear()
    renderHosts()
  }
}

async function copySelectedHosts() {
  const invites = Array.from(state.selectedHosts).filter(Boolean)
  if (!invites.length) {
    setStatus('Select at least one active host first.')
    return
  }
  await copyToClipboard(invites.join('\n'))
  setStatus(`Copied ${invites.length} invite${invites.length === 1 ? '' : 's'}.`)
}

async function stopSelectedHosts() {
  if (!state.rpc) return setStatus('Worker is still starting.')
  const invites = Array.from(state.selectedHosts).filter(Boolean)
  if (!invites.length) return setStatus('Select at least one active host first.')

  upsertWorkerActivityBar('hosts-stop', 'Stopping selected hosts', 0, invites.length)

  for (let i = 0; i < invites.length; i++) {
    const invite = invites[i]
    try {
      // eslint-disable-next-line no-await-in-loop
      await state.rpc.request(RpcCommand.STOP_HOST, { invite })
    } catch {}
    upsertWorkerActivityBar('hosts-stop', 'Stopping selected hosts', i + 1, invites.length)
  }

  clearWorkerActivityBar('hosts-stop')
  state.selectedHosts.clear()
  await refreshActiveHosts()
  setStatus(`Stopped ${invites.length} host${invites.length === 1 ? '' : 's'}.`)
}

async function stopHost(invite) {
  if (!state.rpc) return
  try {
    await state.rpc.request(RpcCommand.STOP_HOST, { invite })
    state.selectedHosts.delete(invite)
    await refreshActiveHosts()
    setStatus('Host stopped.')
  } catch (error) {
    setStatus(`Stop failed: ${error.message || String(error)}`)
  }
}

async function rehostSelectedHistory() {
  const picked = state.hostHistory.filter((item) => state.selectedHistory.has(item.id))
  if (!picked.length) return setStatus('Select at least one history item first.')

  upsertWorkerActivityBar('rehost-bulk', 'Re-hosting selected history', 0, picked.length)

  for (let i = 0; i < picked.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    await rehostHistoryItem(picked[i])
    upsertWorkerActivityBar('rehost-bulk', 'Re-hosting selected history', i + 1, picked.length)
  }

  clearWorkerActivityBar('rehost-bulk')
  await refreshActiveHosts()
  renderAll()
}

async function rehostHistoryItem(historyItem) {
  if (!state.rpc) return setStatus('Worker is still starting.')
  try {
    const refs = Array.isArray(historyItem.sourceRefs) ? historyItem.sourceRefs : []
    if (!refs.length) throw new Error('History entry does not include saved source paths')

    upsertWorkerActivityBar('rehost-expand', 'Validating history paths', 0, refs.length)

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]
      // eslint-disable-next-line no-await-in-loop
      const exists = await pathExists(ref.path)
      if (!exists) throw new Error(`Cannot re-host: source no longer exists (${ref.path})`)
      upsertWorkerActivityBar('rehost-expand', 'Validating history paths', i + 1, refs.length)
    }

    const files = []
    for (const ref of refs) {
      // eslint-disable-next-line no-await-in-loop
      const expanded = await expandSourceToFiles(ref)
      files.push(...expanded)
    }

    clearWorkerActivityBar('rehost-expand')

    if (!files.length) throw new Error('No files available from saved sources')

    const response = await state.rpc.request(RpcCommand.CREATE_UPLOAD, {
      files,
      sessionName: String(historyItem.sessionName || 'Host Session').trim() || 'Host Session'
    })

    const invite = String(response?.nativeInvite || response?.invite || '').trim()
    const next = {
      ...historyItem,
      invite,
      createdAt: Date.now(),
      fileCount: Array.isArray(response?.manifest) ? response.manifest.length : files.length,
      totalBytes: Number(response?.transfer?.totalBytes || historyItem.totalBytes || 0)
    }

    state.hostHistory = [next, ...state.hostHistory.filter((row) => row.id !== historyItem.id)].slice(0, 200)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
    setStatus('Re-host started.')
  } catch (error) {
    clearWorkerActivityBar('rehost-expand')
    setStatus(`Re-host failed: ${error.message || String(error)}`)
  }
}

function addLocalSources(entries) {
  const now = Date.now()
  const next = state.sources.slice()

  for (const entry of entries) {
    const srcPath = String(entry.path || '').trim()
    if (!srcPath) continue
    const type = entry.type === 'folder' ? 'folder' : 'file'
    const exists = next.find((row) => row.path === srcPath && row.type === type)
    if (exists) continue
    next.unshift({
      id: `src:${now}:${Math.random().toString(16).slice(2, 8)}`,
      type,
      path: srcPath,
      name: nodePath.basename(srcPath) || srcPath,
      addedAt: Date.now()
    })
  }

  state.sources = next.slice(0, 300)
  persistSources()
  renderSources()
  setStatus(`Source list updated (${state.sources.length}).`)
}

function rememberHistory(entry) {
  state.hostHistory = [entry, ...state.hostHistory].slice(0, 200)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
}

function persistSources() {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(state.sources))
}

function persistStarredHosts() {
  localStorage.setItem(STARRED_HOSTS_KEY, JSON.stringify(Array.from(state.starredHosts)))
}

async function expandSourceToFiles(source) {
  const srcPath = String(source?.path || '').trim()
  const srcType = source?.type === 'folder' ? 'folder' : 'file'
  if (!srcPath) return []

  const exists = await pathExists(srcPath)
  if (!exists) throw new Error(`Source path does not exist: ${srcPath}`)

  if (srcType === 'file') {
    const stat = await fs.stat(srcPath)
    if (!stat.isFile()) throw new Error(`Source is not a file: ${srcPath}`)
    return [
      {
        name: nodePath.basename(srcPath),
        path: srcPath,
        drivePath: `/files/${sanitizePathPart(nodePath.basename(srcPath))}`,
        byteLength: Number(stat.size || 0),
        mimeType: guessMimeType(srcPath)
      }
    ]
  }

  const files = []
  await walkDir(srcPath, async (filePath) => {
    const rel = nodePath.relative(srcPath, filePath).split(nodePath.sep).join('/')
    const stat = await fs.stat(filePath)
    files.push({
      name: nodePath.basename(filePath),
      path: filePath,
      drivePath: `/files/${sanitizeRelativePath(rel)}`,
      byteLength: Number(stat.size || 0),
      mimeType: guessMimeType(filePath)
    })
  })

  return files
}

async function writeEntryToFile(rpc, invite, drivePath, outputPath, byteLength) {
  const fd = await fs.open(outputPath, 'w')
  const chunkSize = 256 * 1024

  try {
    const total = Math.max(0, Number(byteLength || 0))
    let offset = 0

    if (total <= 0) {
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await rpc.request(RpcCommand.READ_ENTRY_CHUNK, {
          invite,
          drivePath,
          offset,
          length: chunkSize
        })
        const bytes = Buffer.from(String(chunk?.dataBase64 || ''), 'base64')
        if (!bytes.byteLength) break
        // eslint-disable-next-line no-await-in-loop
        await fd.write(bytes)
        offset += bytes.byteLength
        if (bytes.byteLength < chunkSize) break
      }
      return
    }

    while (offset < total) {
      const length = Math.min(chunkSize, total - offset)
      // eslint-disable-next-line no-await-in-loop
      const chunk = await rpc.request(RpcCommand.READ_ENTRY_CHUNK, {
        invite,
        drivePath,
        offset,
        length
      })
      const bytes = Buffer.from(String(chunk?.dataBase64 || ''), 'base64')
      if (!bytes.byteLength) throw new Error(`Empty chunk at offset ${offset}`)
      // eslint-disable-next-line no-await-in-loop
      await fd.write(bytes)
      offset += bytes.byteLength
    }
  } finally {
    await fd.close()
  }
}

async function walkDir(root, onFile) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = nodePath.join(root, entry.name)
    if (entry.isDirectory()) {
      // eslint-disable-next-line no-await-in-loop
      await walkDir(fullPath, onFile)
      continue
    }
    if (!entry.isFile()) continue
    // eslint-disable-next-line no-await-in-loop
    await onFile(fullPath)
  }
}

function resolveOutputPath(baseDir, entry) {
  const drivePath = String(entry?.drivePath || '').trim()
  if (drivePath.startsWith('/files/')) {
    const rel = sanitizeRelativePath(drivePath.slice('/files/'.length))
    return nodePath.join(baseDir, rel)
  }
  const safeName = sanitizePathPart(String(entry?.name || 'download.bin'))
  return nodePath.join(baseDir, safeName)
}

function guessMimeType(filePath) {
  const ext = nodePath.extname(String(filePath || '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.txt') return 'text/plain'
  if (ext === '.json') return 'application/json'
  return 'application/octet-stream'
}

function entryKey(entry) {
  return String(entry?.drivePath || entry?.name || '').trim()
}

function sanitizePathPart(value) {
  return String(value || '')
    .replaceAll('\\', '_')
    .replaceAll('/', '_')
    .replace(/\s+/g, ' ')
    .trim() || 'file'
}

function sanitizeRelativePath(value) {
  return String(value || '')
    .split('/')
    .map((part) => sanitizePathPart(part))
    .filter(Boolean)
    .join('/')
}

function normalizePathList(value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => String(entry || '').trim()).filter(Boolean)
}

function normalizeInvite(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (text.startsWith('peardrops://invite') || text.startsWith('peardrops-web://join')) {
    return text
  }
  try {
    const parsed = new URL(text)
    const nested = parsed.searchParams.get('invite')
    if (nested && nested.startsWith('peardrops://invite')) return nested
  } catch {}
  return ''
}

function setWorkerLogMessage(message) {
  const text = redactInviteText(String(message || '').trim())
  for (const el of workerLogEls) {
    if (!el) continue
    el.textContent = `Worker log: ${text || 'waiting for events.'}`
  }
}

function redactInviteText(value) {
  const text = String(value || '')
  return text
    .replace(/peardrops:\/\/invite[^\s)]+/gi, '[invite hidden]')
    .replace(/peardrops-web:\/\/join[^\s)]+/gi, '[invite hidden]')
    .replace(/([?&]invite=)[^&\s)]+/gi, '$1[invite hidden]')
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
  if (!key || !workerActivityBars.has(key)) return
  workerActivityBars.delete(key)
  renderWorkerActivityBars()
}

function renderWorkerActivityBars() {
  if (!workerActivityBarsEls.length) return
  const barsHtml = Array.from(workerActivityBars.values())
    .map((bar) => {
      const percent = Math.round((Number(bar.done || 0) / Math.max(1, Number(bar.total || 1))) * 100)
      const progressText =
        bar.displayMode === 'bytes'
          ? `${percent}% (${formatBytes(Number(bar.done || 0))} / ${formatBytes(Number(bar.total || 0))})`
          : `${Number(bar.done || 0)}/${Math.max(1, Number(bar.total || 1))}`
      const subtitleHtml = bar.subtitle
        ? `<div class="activity-label" style="margin-top:3px;">${escapeHtml(bar.subtitle)}</div>`
        : ''
      return `<div class="activity-bar"><div class="activity-label">${escapeHtml(bar.label)} ${progressText}</div>${subtitleHtml}<div class="activity-track"><div class="activity-fill" style="width:${percent}%"></div></div></div>`
    })
    .join('')

  for (const el of workerActivityBarsEls) {
    if (!el) continue
    if (workerActivityBars.size === 0) {
      el.classList.add('hidden')
      el.textContent = ''
      continue
    }
    el.classList.remove('hidden')
    el.innerHTML = barsHtml
  }
}

function applyThemeMode(mode) {
  const raw = String(mode || 'system').trim().toLowerCase()
  state.themeMode = raw === 'dark' || raw === 'light' ? raw : 'system'
  const next = state.themeMode === 'system' ? resolveSystemTheme() : state.themeMode
  document.body.setAttribute('data-theme', next)
}

function resolveSystemTheme() {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
  return prefersDark ? 'dark' : 'light'
}

function setStatus(message) {
  const text = String(message || '')
  for (const el of statusEls) {
    if (!el) continue
    el.textContent = text
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(String(targetPath || ''), nodeFs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function formatBytes(value = 0) {
  const n = Math.max(0, Number(value || 0))
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function copyToClipboard(value) {
  try {
    await navigator.clipboard.writeText(String(value || ''))
  } catch {
    setStatus('Could not copy automatically.')
    return
  }
  setStatus('Copied invite(s).')
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeHtmlAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;')
}
