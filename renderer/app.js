/* global window, document, navigator, TextDecoder, Buffer, localStorage */

const RPC = require('bare-rpc')
const fs = require('fs/promises')
const nodeFs = require('fs')
const nodePath = require('path')
const { pathToFileURL, fileURLToPath } = require('url')
const os = require('os')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { webUtils } = require('electron')
const execFileAsync = promisify(execFile)

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
  READ_ENTRY_CHUNK: 10,
  UPDATE_ACTIVE_HOST: 11
}

const SOURCES_KEY = 'peardrops.desktop.sources.v1'
const HISTORY_KEY = 'peardrops.desktop.host-history.v1'
const STARRED_HOSTS_KEY = 'peardrops.desktop.starred-hosts.v1'
const HOST_PACKAGING_KEY = 'peardrops.desktop.host-packaging.v1'
const PUBLIC_SITE_ORIGIN = 'https://peardrop.online'
const FALLBACK_RELAY_URL = 'wss://pear-drops.up.railway.app'
const workerSpecifier = '/workers/main.js'
const WORKER_READY_TOKEN = '__PEARDROP_WORKER_RPC_READY__'
const WORKER_READY_TIMEOUT_MS = 45000
const WORKER_INIT_TIMEOUT_MS = 30000
const bridge = window.bridge
const decoder = new TextDecoder('utf8')
const workerActivityBars = new Map()
const sourceCoverLoadsInFlight = new Set()
const CLOSE_ICON = '<span aria-hidden="true">✕</span>'
const BIN_ICON =
  '<span class="mini-trash" aria-hidden="true"><span class="mini-trash-lid"></span><span class="mini-trash-body"><span class="mini-trash-line"></span><span class="mini-trash-line"></span></span></span>'
const SESSION_EDITOR_HISTORY_MARKER = '__peardropSessionEditor'
const IS_MAC = process.platform === 'darwin'
const SESSION_SWIPE_TRIGGER_PX = 180
const SESSION_SWIPE_IDLE_MS = 220

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
const hostsStarSelectedBtn = document.getElementById('hosts-star-selected')
const hostsStopSelectedBtn = document.getElementById('hosts-stop-selected')

const historyRowsEl = document.getElementById('history-rows')
const historySelectToggleBtn = document.getElementById('history-select-toggle')
const historyRehostSelectedBtn = document.getElementById('history-rehost-selected')
const historyRemoveSelectedBtn = document.getElementById('history-remove-selected')

const filePicker = document.getElementById('file-picker')
const hostNameModalEl = document.getElementById('host-name-modal')
const hostNameBackdropEl = document.getElementById('host-name-backdrop')
const hostNameInputEl = document.getElementById('host-name-input')
const hostNameCancelBtn = document.getElementById('host-name-cancel')
const hostNameSubmitBtn = document.getElementById('host-name-submit')
const appQuitModalEl = document.getElementById('app-quit-modal')
const appQuitBackdropEl = document.getElementById('app-quit-backdrop')
const appQuitSubEl = document.getElementById('app-quit-sub')
const appQuitCloseWindowBtn = document.getElementById('app-quit-close-window')
const appQuitConfirmBtn = document.getElementById('app-quit-confirm')
const appQuitCancelBtn = document.getElementById('app-quit-cancel')
const updateBannerEl = document.getElementById('update-banner')
const updateBannerSubEl = document.getElementById('update-banner-sub')
const updateShutdownBtn = document.getElementById('update-shutdown-btn')
const shutdownOverlayEl = document.getElementById('shutdown-overlay')
const shutdownMessageEl = document.getElementById('shutdown-message')
const sessionEditorEl = document.getElementById('host-session-editor')
const sessionEditorTitleEl = document.getElementById('session-editor-title')
const sessionEditorSubEl = document.getElementById('session-editor-sub')
const sessionEditorRowsEl = document.getElementById('session-editor-rows')
const sessionEditorBackBtn = document.getElementById('session-editor-back')
const sessionEditorCancelBtn = document.getElementById('session-editor-cancel')
const sessionEditorAddFileBtn = document.getElementById('session-editor-add-file')
const sessionEditorAddFolderBtn = document.getElementById('session-editor-add-folder')
const sessionEditorSelectToggleBtn = document.getElementById('session-editor-select-toggle')
const sessionEditorRemoveSelectedBtn = document.getElementById('session-editor-remove-selected')
const sessionEditorApplyBtn = document.getElementById('session-editor-apply')

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
  expandedDriveFolders: new Set(),
  runningHistoryByInvite: new Map(),
  rehostingHistoryIds: new Set(),
  stoppingInvites: new Set(),
  loadingInviteManifest: false,
  downloadingSelected: false,
  hostingSelected: false,
  stoppingSelectedHosts: false,
  rehostingSelectedBulk: false,
  inviteSource: '',
  themeMode: 'system',
  sourceMenuOpen: false,
  currentTab: 'upload',
  hostPackagingMode: loadHostPackagingMode(),
  highlightedHostInvite: '',
  highlightedHostTimer: null,
  sessionEditorOpen: false,
  sessionEditorMode: '',
  sessionEditorHistoryId: '',
  sessionEditorInvite: '',
  sessionEditorSessionName: 'Host Session',
  sessionEditorRefs: [],
  sessionEditorSelected: new Set(),
  sessionEditorApplying: false,
  sessionEditorHistoryActive: false,
  quitPromptOpen: false,
  updateReady: false,
  updatePlatform: ''
}
const dedupedInitialSources = dedupeSourceRows(state.sources)
if (dedupedInitialSources.length !== state.sources.length) {
  state.sources = dedupedInitialSources
  persistSources()
}

let startupLoading = true
let pendingHostNameResolve = null
let copyFeedbackTimer = null
let activeCopyFeedbackKey = ''
let activeHostsPollTimer = null
let workerReadySeen = false
let workerReadyWaiters = []
let sessionSwipeAccumulator = 0
let sessionSwipeTimer = null

if (!bridge || typeof bridge.startWorker !== 'function') {
  setStatus('Desktop bridge failed to load. Check preload configuration.')
  throw new Error('window.bridge is unavailable')
}

wireGlobalEvents()
wireUiEvents()
setStartupLoading(true)
void boot()

function wireGlobalEvents() {
  window.addEventListener('popstate', () => {
    if (!state.sessionEditorOpen) {
      state.sessionEditorHistoryActive = false
      resetSessionSwipeState()
      return
    }
    closeSessionEditor({ fromHistory: true })
  })

  window.addEventListener(
    'wheel',
    (event) => {
      if (!IS_MAC || !state.sessionEditorOpen) return
      if (event.defaultPrevented) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const absX = Math.abs(Number(event.deltaX || 0))
      const absY = Math.abs(Number(event.deltaY || 0))
      if (absX < 6) return
      if (absX < absY * 1.2) return

      sessionSwipeAccumulator += Number(event.deltaX || 0)
      if (sessionSwipeTimer) clearTimeout(sessionSwipeTimer)
      sessionSwipeTimer = setTimeout(() => resetSessionSwipeState(), SESSION_SWIPE_IDLE_MS)

      if (Math.abs(sessionSwipeAccumulator) < SESSION_SWIPE_TRIGGER_PX) return
      event.preventDefault()
      closeSessionEditor()
      resetSessionSwipeState()
    },
    { passive: false }
  )

  bridge.onWorkerStdout?.(workerSpecifier, (data) => {
    const text = decoder.decode(data).trim()
    if (!text) return
    if (text.includes(WORKER_READY_TOKEN)) {
      markWorkerReady()
      return
    }
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
    stopActiveHostsPolling()
    finalizeSessionsFromActiveHosts(state.activeHosts)
    const message = String(payload?.message || '').trim()
    if (shutdownMessageEl && message) shutdownMessageEl.textContent = message
    shutdownOverlayEl?.classList.remove('hidden')
  })

  bridge.onUpdateReady?.((payload) => {
    applyUpdateStatus(payload)
  })

  bridge.onQuitPrompt?.((payload) => {
    const open = Boolean(payload?.open)
    state.quitPromptOpen = open
    appQuitModalEl?.classList.toggle('hidden', !open)
    if (open) {
      const detail = String(payload?.detail || '').trim()
      if (detail && appQuitSubEl) appQuitSubEl.textContent = detail
      appQuitConfirmBtn?.focus?.()
    }
  })

  bridge.onThemeMode?.((payload) => {
    applyThemeMode(payload?.mode)
  })

  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
    if (state.themeMode === 'system') applyThemeMode('system')
  })

  window.addEventListener('beforeunload', () => {
    stopActiveHostsPolling()
  })

  window.addEventListener('focus', () => {
    void pruneMissingSources('wakeup')
  })

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void pruneMissingSources('wakeup')
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

  const onGlobalDragOver = (event) => {
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
  const onGlobalDrop = (event) => {
    event.preventDefault()
    void handleWindowDrop(event)
  }
  window.addEventListener('dragover', onGlobalDragOver)
  document.addEventListener('dragover', onGlobalDragOver, true)
  window.addEventListener('drop', onGlobalDrop)
  document.addEventListener('drop', onGlobalDrop, true)
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
    const paths = files.map((file) => resolveNativePathFromFile(file)).filter(Boolean)
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
    if (!state.selectedSources.size) {
      setStatus('Select at least one source first.')
      return
    }
    const selected = new Set(Array.from(state.selectedSources))
    const cleared = state.sources.filter((row) => selected.has(String(row?.id || ''))).length
    if (!cleared) {
      setStatus('Select at least one source first.')
      return
    }
    state.sources = state.sources.filter((row) => !selected.has(String(row?.id || '')))
    state.selectedSources.clear()
    persistSources()
    renderSources()
    setStatus(`Cleared ${cleared} selected source${cleared === 1 ? '' : 's'}.`)
  })

  hostSelectedBtn.addEventListener('click', async () => {
    if (state.hostingSelected || pendingHostNameResolve) return
    const options = await promptForHostOptions('Host Session')
    if (options === null) return
    void hostSelectedSources(options.sessionName, options.packaging)
  })

  hostNameBackdropEl?.addEventListener('click', () => resolveHostNamePrompt(null))
  hostNameCancelBtn?.addEventListener('click', () => resolveHostNamePrompt(null))
  hostNameSubmitBtn?.addEventListener('click', () => {
    const next = String(hostNameInputEl?.value || '').trim() || 'Host Session'
    const packaging = readHostPackagingMode()
    resolveHostNamePrompt({ sessionName: next, packaging })
  })
  hostNameInputEl?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const next = String(hostNameInputEl?.value || '').trim() || 'Host Session'
      const packaging = readHostPackagingMode()
      resolveHostNamePrompt({ sessionName: next, packaging })
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      resolveHostNamePrompt(null)
    }
  })

  appQuitBackdropEl?.addEventListener('click', () => {
    void bridge.quitPromptAction?.('cancel')
  })
  appQuitCancelBtn?.addEventListener('click', () => {
    void bridge.quitPromptAction?.('cancel')
  })
  appQuitCloseWindowBtn?.addEventListener('click', () => {
    void bridge.quitPromptAction?.('close-window')
  })
  appQuitConfirmBtn?.addEventListener('click', () => {
    void bridge.quitPromptAction?.('quit')
  })
  updateShutdownBtn?.addEventListener('click', () => {
    void bridge.updateAction?.('shutdown')
  })
  window.addEventListener('keydown', (event) => {
    if (!state.quitPromptOpen) return
    if (event.key === 'Escape') {
      event.preventDefault()
      void bridge.quitPromptAction?.('cancel')
    }
  })

  sessionEditorBackBtn?.addEventListener('click', () => closeSessionEditor())
  sessionEditorCancelBtn?.addEventListener('click', () => closeSessionEditor())
  sessionEditorAddFileBtn?.addEventListener('click', async () => {
    if (state.sessionEditorApplying) return
    const picked = normalizePathList(await bridge.pickFiles?.())
    if (!picked.length) return
    addSessionEditorRefs(picked.map((srcPath) => ({ type: 'file', path: srcPath })))
  })
  sessionEditorAddFolderBtn?.addEventListener('click', async () => {
    if (state.sessionEditorApplying) return
    const dir = String((await bridge.pickDirectory?.()) || '').trim()
    if (!dir) return
    addSessionEditorRefs([{ type: 'folder', path: dir }])
  })
  sessionEditorSelectToggleBtn?.addEventListener('click', () => {
    if (!state.sessionEditorRefs.length) return
    const allSelected = state.sessionEditorSelected.size === state.sessionEditorRefs.length
    state.sessionEditorSelected.clear()
    if (!allSelected) {
      for (const ref of state.sessionEditorRefs) state.sessionEditorSelected.add(ref.id)
    }
    renderSessionEditor()
  })
  sessionEditorRemoveSelectedBtn?.addEventListener('click', () => {
    if (!state.sessionEditorSelected.size) return
    state.sessionEditorRefs = state.sessionEditorRefs.filter(
      (ref) => !state.sessionEditorSelected.has(ref.id)
    )
    state.sessionEditorSelected.clear()
    renderSessionEditor()
  })
  sessionEditorApplyBtn?.addEventListener('click', () => {
    if (state.sessionEditorApplying) return
    void applySessionEditorChanges()
  })

  sessionEditorRowsEl?.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const row = target.closest('[data-session-ref-id]')
    if (!(row instanceof HTMLElement)) return
    const id = String(row.dataset.sessionRefId || '').trim()
    if (!id) return
    const actionNode = target.closest('[data-action]')
    const action = String(actionNode?.getAttribute('data-action') || '')
    if (action === 'remove') {
      state.sessionEditorRefs = state.sessionEditorRefs.filter((ref) => ref.id !== id)
      state.sessionEditorSelected.delete(id)
      renderSessionEditor()
      return
    }
    if (state.sessionEditorSelected.has(id)) state.sessionEditorSelected.delete(id)
    else state.sessionEditorSelected.add(id)
    renderSessionEditor()
  })

  viewDriveBtn.addEventListener('click', () => {
    if (state.loadingInviteManifest) return
    void openInviteFiles()
  })
  downloadSelectedBtn.addEventListener('click', () => {
    if (state.downloadingSelected) return
    void downloadInviteSelected()
  })

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
    if (action === 'toggle-file') {
      const key = String(node.dataset.key || '').trim()
      if (!key) return
      if (state.inviteSelected.has(key)) state.inviteSelected.delete(key)
      else state.inviteSelected.add(key)
      renderDriveRows()
      return
    }

    if (action === 'toggle-folder') {
      const folderPath = String(node.dataset.folder || '').trim()
      if (!folderPath) return
      const descendants = collectDriveFolderFileKeys(folderPath)
      if (!descendants.length) return
      const allSelected = descendants.every((key) => state.inviteSelected.has(key))
      for (const key of descendants) {
        if (allSelected) state.inviteSelected.delete(key)
        else state.inviteSelected.add(key)
      }
      renderDriveRows()
      return
    }

    if (action === 'toggle-expand') {
      const folderPath = String(node.dataset.folder || '').trim()
      if (!folderPath) return
      if (state.expandedDriveFolders.has(folderPath)) state.expandedDriveFolders.delete(folderPath)
      else state.expandedDriveFolders.add(folderPath)
      renderDriveRows()
    }
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

  hostsStarSelectedBtn?.addEventListener('click', () => {
    if (!state.selectedHosts.size) {
      setStatus('Select at least one active host first.')
      return
    }
    for (const invite of state.selectedHosts) state.starredHosts.add(invite)
    persistStarredHosts()
    renderHosts()
    setStatus(
      `Starred ${state.selectedHosts.size} host${state.selectedHosts.size === 1 ? '' : 's'}.`
    )
  })
  hostsStopSelectedBtn.addEventListener('click', () => {
    if (state.stoppingSelectedHosts) return
    void stopSelectedHosts()
  })

  historySelectToggleBtn.addEventListener('click', () => {
    if (!state.hostHistory.length) return
    const allSelected = state.selectedHistory.size === state.hostHistory.length
    state.selectedHistory.clear()
    if (!allSelected) {
      for (const row of state.hostHistory) state.selectedHistory.add(row.id)
    }
    renderHistory()
  })

  historyRehostSelectedBtn.addEventListener('click', () => {
    if (state.rehostingSelectedBulk) return
    void rehostSelectedHistory()
  })
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
      return
    }

    if (state.selectedSources.has(id)) state.selectedSources.delete(id)
    else state.selectedSources.add(id)
    renderSources()
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
      void copyToClipboard(toShareableInvite(invite) || invite)
      flashCopyFeedback(`host:${invite}`)
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
    if (target.closest('input[type="checkbox"]')) {
      if (state.selectedHosts.has(invite)) state.selectedHosts.delete(invite)
      else state.selectedHosts.add(invite)
      renderHosts()
      return
    }
    void openSessionEditorForActiveHost(invite)
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
    if (target.closest('input[type="checkbox"]')) {
      if (state.selectedHistory.has(id)) state.selectedHistory.delete(id)
      else state.selectedHistory.add(id)
      renderHistory()
      return
    }
    const item = state.hostHistory.find((entry) => String(entry.id || '') === id)
    if (item) openSessionEditorForHistory(item)
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
      void copyToClipboard(toShareableInvite(invite) || invite)
      flashCopyFeedback(`starred:${invite}`)
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
    workerReadySeen = false
    const start = await bridge.startWorker(workerSpecifier)
    if (start && typeof start === 'object' && start.alreadyRunning) {
      // On renderer refresh, the existing worker won't emit a fresh READY token.
      markWorkerReady()
      setWorkerLogMessage('reconnecting to existing worker')
    } else {
      await waitForWorkerReadySignal(WORKER_READY_TIMEOUT_MS)
    }
    state.rpc = createRpcClient()
    setWorkerLogMessage('initializing worker RPC')
    await state.rpc.request(RpcCommand.INIT, {}, { timeoutMs: WORKER_INIT_TIMEOUT_MS })

    const mode = await bridge.getThemeMode?.()
    applyThemeMode(mode)
    const updateStatus = await bridge.getUpdateStatus?.()
    applyUpdateStatus(updateStatus)

    await refreshActiveHosts()
    await pruneMissingSources('launch')
    startActiveHostsPolling()
    renderAll()
    setStartupLoading(false)
    setStatus('Ready.')
    setWorkerLogMessage('ready')
  } catch (error) {
    setStartupLoading(false)
    renderAll()
    setStatus(`Worker start failed: ${error.message || String(error)}`)
    setWorkerLogMessage(`start failed: ${error.message || String(error)}`)
  }
}

function setStartupLoading(isLoading) {
  startupLoading = !!isLoading
  if (document?.body) document.body.dataset.startupLoading = startupLoading ? '1' : '0'
  if (startupLoading) renderStartupSkeletons()
}

function renderStartupSkeletons() {
  if (!startupLoading) return
  if (sourcesGridEl) {
    sourcesGridEl.innerHTML = '<div class="skeleton-container source" aria-hidden="true"></div>'
  }
  if (hostsRowsEl) {
    hostsRowsEl.innerHTML = '<div class="skeleton-container hosts" aria-hidden="true"></div>'
  }
  if (starredRowsEl) {
    starredRowsEl.innerHTML = '<div class="skeleton-container starred" aria-hidden="true"></div>'
  }
  if (historyRowsEl) {
    historyRowsEl.innerHTML = '<div class="skeleton-container history" aria-hidden="true"></div>'
  }
  if (driveRowsEl) {
    driveRowsEl.innerHTML =
      '<tr class="skeleton-table-row" aria-hidden="true"><td colspan="4"><div class="skeleton-container drive"></div></td></tr>'
  }
}

function waitForWorkerReadySignal(timeoutMs) {
  if (workerReadySeen) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      workerReadyWaiters = workerReadyWaiters.filter((waiter) => waiter !== onReady)
      reject(new Error(`Worker ready signal timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const onReady = () => {
      clearTimeout(timer)
      resolve()
    }

    workerReadyWaiters.push(onReady)
  })
}

function markWorkerReady() {
  if (workerReadySeen) return
  workerReadySeen = true
  const waiters = workerReadyWaiters
  workerReadyWaiters = []
  for (const waiter of waiters) {
    try {
      waiter()
    } catch {}
  }
}

function startActiveHostsPolling() {
  stopActiveHostsPolling()
  activeHostsPollTimer = setInterval(() => {
    void refreshActiveHosts()
  }, 4000)
}

function stopActiveHostsPolling() {
  if (!activeHostsPollTimer) return
  clearInterval(activeHostsPollTimer)
  activeHostsPollTimer = null
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
    async request(command, payload = {}, options = {}) {
      const timeoutMs = Number(options.timeoutMs || 0)
      const req = client.request(command)
      req.send(Buffer.from(JSON.stringify(payload), 'utf8'))
      const replyPromise = req.reply()
      const reply = timeoutMs > 0 ? await withTimeout(replyPromise, timeoutMs) : await replyPromise
      const parsed = JSON.parse(Buffer.from(reply).toString('utf8'))
      if (parsed && parsed.ok === false) throw new Error(parsed.error || 'RPC request failed')
      return parsed && parsed.ok === true ? parsed.result : parsed
    }
  }
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function renderAll() {
  renderUpdateBanner()
  renderTabs()
  renderSourceMenu()
  renderSources()
  renderHosts()
  renderHistory()
  renderDriveRows()
  renderSessionEditor()
  renderActionButtons()
}

function applyUpdateStatus(payload) {
  const ready = Boolean(payload?.ready)
  state.updateReady = ready
  state.updatePlatform = ready
    ? String(payload?.platform || '')
        .trim()
        .toLowerCase()
    : ''
  renderUpdateBanner()
}

function renderUpdateBanner() {
  if (!updateBannerEl) return
  updateBannerEl.classList.toggle('hidden', !state.updateReady)
  if (!state.updateReady || !updateBannerSubEl) return
  if (state.updatePlatform === 'windows') {
    updateBannerSubEl.textContent =
      'An update is ready. Shut down PearDrop now to complete the Windows update.'
    return
  }
  if (state.updatePlatform === 'macos' || state.updatePlatform === 'linux') {
    updateBannerSubEl.textContent =
      'An update is ready. Shut down PearDrop now; the new version will open next launch.'
    return
  }
  updateBannerSubEl.textContent = 'An update is ready. Shut down PearDrop to finish updating.'
}

function renderActionButtons() {
  if (hostSelectedBtn) {
    hostSelectedBtn.disabled = state.hostingSelected || state.selectedSources.size === 0
    hostSelectedBtn.innerHTML = state.hostingSelected
      ? '<span class="mini-spinner"></span> Hosting...'
      : 'Host Selected'
  }
  if (viewDriveBtn) {
    viewDriveBtn.disabled = state.loadingInviteManifest
    viewDriveBtn.innerHTML = state.loadingInviteManifest
      ? '<span class="mini-spinner"></span> Loading...'
      : 'View Drive'
  }
  if (downloadSelectedBtn) {
    const disabled =
      state.downloadingSelected || !state.inviteEntries.length || state.inviteSelected.size === 0
    downloadSelectedBtn.disabled = disabled
    downloadSelectedBtn.innerHTML = state.downloadingSelected
      ? '<span class="mini-spinner"></span> Downloading...'
      : 'Download Selected'
  }
  if (hostsStopSelectedBtn) {
    hostsStopSelectedBtn.disabled = state.stoppingSelectedHosts || state.selectedHosts.size === 0
    hostsStopSelectedBtn.innerHTML = state.stoppingSelectedHosts
      ? '<span class="mini-spinner"></span>'
      : '⏹'
  }
  if (historyRehostSelectedBtn) {
    historyRehostSelectedBtn.disabled =
      state.rehostingSelectedBulk || state.selectedHistory.size === 0
    historyRehostSelectedBtn.innerHTML = state.rehostingSelectedBulk
      ? '<span class="mini-spinner"></span>'
      : '▶'
  }
  if (sessionEditorAddFileBtn) sessionEditorAddFileBtn.disabled = state.sessionEditorApplying
  if (sessionEditorAddFolderBtn) sessionEditorAddFolderBtn.disabled = state.sessionEditorApplying
  if (sessionEditorSelectToggleBtn) {
    sessionEditorSelectToggleBtn.disabled =
      state.sessionEditorApplying || state.sessionEditorRefs.length === 0
  }
  if (sessionEditorRemoveSelectedBtn) {
    sessionEditorRemoveSelectedBtn.disabled =
      state.sessionEditorApplying || state.sessionEditorSelected.size === 0
  }
  if (sessionEditorApplyBtn) {
    sessionEditorApplyBtn.disabled = state.sessionEditorApplying || !state.sessionEditorRefs.length
    sessionEditorApplyBtn.innerHTML = state.sessionEditorApplying
      ? '<span class="mini-spinner"></span> Applying...'
      : 'Apply Changes'
  }
}

function renderSessionEditor() {
  const open = Boolean(state.sessionEditorOpen)
  sessionEditorEl?.classList.toggle('hidden', !open)
  uploadPageEl?.classList.toggle('editor-open', open)
  if (!open) return

  if (sessionEditorTitleEl) {
    sessionEditorTitleEl.textContent = String(state.sessionEditorSessionName || 'Host Session')
  }
  if (sessionEditorSubEl) {
    const modeLabel =
      state.sessionEditorMode === 'active' ? 'active host session' : 'saved history session'
    sessionEditorSubEl.textContent = `Edit sources for this ${modeLabel}.`
  }
  if (!sessionEditorRowsEl) return
  sessionEditorRowsEl.textContent = ''

  const allSelected =
    state.sessionEditorRefs.length > 0 &&
    state.sessionEditorSelected.size === state.sessionEditorRefs.length
  if (sessionEditorSelectToggleBtn) {
    sessionEditorSelectToggleBtn.textContent = allSelected ? 'Deselect All' : 'Select All'
  }

  if (!state.sessionEditorRefs.length) {
    sessionEditorRowsEl.innerHTML = '<div class="muted-empty">No sources in this session.</div>'
    return
  }

  for (const ref of state.sessionEditorRefs) {
    const selected = state.sessionEditorSelected.has(ref.id)
    const row = document.createElement('div')
    row.className = `row-item${selected ? ' selected' : ''}`
    row.dataset.sessionRefId = String(ref.id || '')
    row.innerHTML = `
      <input type="checkbox" ${selected ? 'checked' : ''} />
      <div>
        <div class="row-title">${escapeHtml(String(ref.name || ref.path || 'Source'))}</div>
        <div class="row-sub">${escapeHtml(String(ref.type || 'file').toUpperCase())} · ${escapeHtml(String(ref.path || ''))}</div>
      </div>
      <div class="controls">
        <button class="btn alt icon icon-danger" data-action="remove" aria-label="Remove" title="Remove">${BIN_ICON}</button>
      </div>
    `
    sessionEditorRowsEl.appendChild(row)
  }
}

function toSessionEditorRef(ref) {
  const srcPath = String(ref?.path || '').trim()
  const srcType = ref?.type === 'folder' ? 'folder' : 'file'
  return {
    id: `sess:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    type: srcType,
    path: srcPath,
    name: String(ref?.name || nodePath.basename(srcPath) || srcPath)
  }
}

function openSessionEditorForActiveHost(invite) {
  const value = String(invite || '').trim()
  if (!value) return
  const activeHost = state.activeHosts.find((row) => String(row?.invite || '').trim() === value)
  const running = state.runningHistoryByInvite.get(value)
  const fallback = state.hostHistory.find((row) => String(row?.invite || '').trim() === value)
  const refs = Array.isArray(running?.sourceRefs)
    ? running.sourceRefs
    : Array.isArray(fallback?.sourceRefs)
      ? fallback.sourceRefs
      : []
  if (!refs.length) {
    setStatus('No editable source list was found for this host session.')
    return
  }
  state.sessionEditorMode = 'active'
  state.sessionEditorHistoryId = String(fallback?.id || '')
  state.sessionEditorInvite = value
  state.sessionEditorSessionName = String(
    activeHost?.sessionLabel ||
      activeHost?.sessionName ||
      running?.sessionName ||
      fallback?.sessionName ||
      'Host Session'
  )
  state.sessionEditorRefs = refs.map(toSessionEditorRef)
  state.sessionEditorSelected.clear()
  state.sessionEditorApplying = false
  ensureSessionEditorHistoryEntry()
  state.sessionEditorOpen = true
  renderSessionEditor()
  renderActionButtons()
}

function openSessionEditorForHistory(item) {
  if (!item) return
  const refs = Array.isArray(item.sourceRefs) ? item.sourceRefs : []
  if (!refs.length) {
    setStatus('No editable source list was found for this history session.')
    return
  }
  state.sessionEditorMode = 'history'
  state.sessionEditorHistoryId = String(item.id || '')
  state.sessionEditorInvite = String(item.invite || '')
  state.sessionEditorSessionName = String(item.sessionName || item.sessionLabel || 'Host Session')
  state.sessionEditorRefs = refs.map(toSessionEditorRef)
  state.sessionEditorSelected.clear()
  state.sessionEditorApplying = false
  ensureSessionEditorHistoryEntry()
  state.sessionEditorOpen = true
  renderSessionEditor()
  renderActionButtons()
}

function closeSessionEditor(options = {}) {
  const fromHistory = Boolean(options.fromHistory)
  if (!fromHistory && maybePopSessionEditorHistoryEntry()) return
  state.sessionEditorOpen = false
  resetSessionSwipeState()
  state.sessionEditorHistoryActive = false
  state.sessionEditorMode = ''
  state.sessionEditorHistoryId = ''
  state.sessionEditorInvite = ''
  state.sessionEditorSessionName = 'Host Session'
  state.sessionEditorRefs = []
  state.sessionEditorSelected.clear()
  state.sessionEditorApplying = false
  renderSessionEditor()
  renderActionButtons()
}

function ensureSessionEditorHistoryEntry() {
  if (state.sessionEditorHistoryActive) return
  try {
    const nextState = {
      ...(window.history.state && typeof window.history.state === 'object'
        ? window.history.state
        : {}),
      [SESSION_EDITOR_HISTORY_MARKER]: true
    }
    window.history.pushState(nextState, '')
    state.sessionEditorHistoryActive = true
  } catch {
    state.sessionEditorHistoryActive = false
  }
}

function maybePopSessionEditorHistoryEntry() {
  if (!state.sessionEditorHistoryActive) return false
  const currentState = window.history.state
  if (
    currentState &&
    typeof currentState === 'object' &&
    currentState[SESSION_EDITOR_HISTORY_MARKER]
  ) {
    window.history.back()
    return true
  }
  state.sessionEditorHistoryActive = false
  return false
}

function resetSessionSwipeState() {
  sessionSwipeAccumulator = 0
  if (sessionSwipeTimer) {
    clearTimeout(sessionSwipeTimer)
    sessionSwipeTimer = null
  }
}

function addSessionEditorRefs(entries) {
  const existing = new Set(
    state.sessionEditorRefs.map((ref) => `${String(ref.type || 'file')}::${String(ref.path || '')}`)
  )
  let added = 0
  for (const entry of entries) {
    const ref = toSessionEditorRef(entry)
    if (!ref.path) continue
    const key = `${ref.type}::${ref.path}`
    if (existing.has(key)) continue
    existing.add(key)
    state.sessionEditorRefs.push(ref)
    added++
  }
  if (added > 0) setStatus(`Added ${added} source${added === 1 ? '' : 's'} to session.`)
  renderSessionEditor()
  renderActionButtons()
}

function promptForHostOptions(defaultValue = 'Host Session') {
  return new Promise((resolve) => {
    pendingHostNameResolve = resolve
    if (hostNameInputEl) hostNameInputEl.value = String(defaultValue || 'Host Session')
    const mode = state.hostPackagingMode === 'zip' ? 'zip' : 'raw'
    const modeRadio = document.querySelector(`input[name="host-packaging"][value="${mode}"]`)
    if (modeRadio && typeof modeRadio === 'object' && 'checked' in modeRadio) {
      modeRadio.checked = true
    }
    hostNameModalEl?.classList.remove('hidden')
    setTimeout(() => hostNameInputEl?.focus(), 0)
  })
}

function resolveHostNamePrompt(value) {
  if (!pendingHostNameResolve) return
  const finish = pendingHostNameResolve
  pendingHostNameResolve = null
  hostNameModalEl?.classList.add('hidden')
  finish(value)
}

function readHostPackagingMode() {
  const selected = document.querySelector('input[name="host-packaging"]:checked')
  const nextMode =
    !selected || typeof selected !== 'object' || !('value' in selected)
      ? 'raw'
      : selected.value === 'zip'
        ? 'zip'
        : 'raw'
  if (state.hostPackagingMode !== nextMode) {
    state.hostPackagingMode = nextMode
    persistHostPackagingMode(nextMode)
  }
  return nextMode
}

function setTab(nextTab) {
  state.currentTab = nextTab === 'download' ? 'download' : 'upload'
  if (state.currentTab !== 'upload' && state.sessionEditorOpen) closeSessionEditor()
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
  const allSelected =
    state.sources.length > 0 && state.selectedSources.size === state.sources.length
  sourceSelectToggleBtn.textContent = allSelected ? 'Deselect All' : 'Select All'

  if (!state.sources.length) {
    sourcesGridEl.innerHTML =
      '<div class="muted-empty">Assets to prepare your Hosting session will show up here.</div>'
    renderActionButtons()
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
        <button class="btn alt icon icon-danger" data-action="remove-source" aria-label="Remove from list" title="Remove from list">${CLOSE_ICON}</button>
      </div>
    `
    sourcesGridEl.appendChild(card)
  }
  renderActionButtons()
}

function renderSourcePreview(source) {
  const type = source?.type === 'folder' ? 'folder' : 'file'
  if (type === 'folder') return '<div class="source-preview">DIR</div>'

  const srcPath = String(source?.path || '').trim()
  const coverArt = String(source?.coverArtDataUrl || '').trim()
  if (coverArt) {
    return `<div class="source-preview"><img src="${escapeHtmlAttr(coverArt)}" alt="audio cover"></div>`
  }
  const mime = guessMimeType(srcPath)
  if (mime.startsWith('image/')) {
    const src = safeFileUrl(srcPath)
    if (src) {
      return `<button class="source-preview-btn" type="button" data-action="preview-source" data-preview-url="${escapeHtmlAttr(src)}"><div class="source-preview"><img src="${escapeHtmlAttr(src)}" alt="preview"></div></button>`
    }
  }
  if (isMp3Path(srcPath) && !sourceCoverLoadsInFlight.has(String(source?.id || ''))) {
    void hydrateSourceCoverArt(source)
    return '<div class="source-preview">MP3</div>'
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
    renderActionButtons()
    return
  }

  for (const host of hosts) {
    const invite = String(host.invite || '').trim()
    const selected = state.selectedHosts.has(invite)
    const starred = state.starredHosts.has(invite)
    const isStopping = state.stoppingInvites.has(invite)
    const parsedLabel = parseSessionLabel(host.sessionLabel || host.sessionName || 'Host Session')
    const sessionDateTime = formatSessionDateTime(host.createdAt, parsedLabel.embeddedDateTime)

    const row = document.createElement('div')
    row.className = 'row-item host-row'
    if (selected) row.classList.add('selected')
    if (state.highlightedHostInvite && state.highlightedHostInvite === invite) {
      row.classList.add('row-item-highlight')
    }
    row.dataset.invite = invite
    row.innerHTML = `
      <input type="checkbox" ${selected ? 'checked' : ''} />
      <div>
        <div class="row-title">${starred ? '<span class="star">★</span> ' : ''}${escapeHtml(parsedLabel.title)}${parsedLabel.hash ? ` <span class="host-hash-inline">(${escapeHtml(parsedLabel.hash)})</span>` : ''}</div>
        ${sessionDateTime ? `<div class="host-date">${escapeHtml(sessionDateTime)}</div>` : ''}
        <div class="host-data">${formatBytes(Number(host.totalBytes || 0))}</div>
      </div>
      <div class="controls">
        <button class="btn alt icon" data-action="copy" aria-label="Copy" title="Copy">${isCopyFeedbackActive(`host:${invite}`) ? '✓' : '⧉'}</button>
        <button class="btn alt icon" data-action="star" aria-label="${starred ? 'Unstar' : 'Star'}" title="${starred ? 'Unstar' : 'Star'}">${starred ? '★' : '☆'}</button>
        <button class="btn warn icon" data-action="stop" aria-label="Stop" title="Stop" ${isStopping ? 'disabled' : ''}>${isStopping ? '<span class="mini-spinner"></span>' : '⏹'}</button>
      </div>
    `
    hostsRowsEl.appendChild(row)
  }
  renderStarredHosts()
  renderActionButtons()
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
    const label = String(host?.sessionLabel || historyItem?.sessionName || 'Starred Host')
    const size = host ? formatBytes(Number(host.totalBytes || 0)) : 'Not active'
    const canStop = Boolean(host)
    const isStopping = canStop && state.stoppingInvites.has(invite)
    const canRehost = Boolean(
      historyItem && Array.isArray(historyItem.sourceRefs) && historyItem.sourceRefs.length
    )
    const isRehosting =
      canRehost && state.rehostingHistoryIds.has(String(historyItem?.id || '').trim())
    const primaryActionHtml = canStop
      ? `<button class="btn warn icon" data-action="stop" aria-label="Stop" title="Stop" ${isStopping ? 'disabled' : ''}>${isStopping ? '<span class="mini-spinner"></span>' : '⏹'}</button>`
      : canRehost
        ? `<button class="btn alt icon" data-action="rehost" data-history-id="${escapeHtmlAttr(String(historyItem.id || ''))}" aria-label="Re-host" title="Re-host" ${isRehosting ? 'disabled' : ''}>${isRehosting ? '<span class="mini-spinner"></span>' : '▶'}</button>`
        : ''

    const row = document.createElement('div')
    row.className = 'row-item'
    row.dataset.starredInvite = invite
    row.innerHTML = `
      <div class="star">★</div>
      <div>
        <div class="row-title">${escapeHtml(label)}</div>
        <div class="host-data">${escapeHtml(size)}</div>
      </div>
      <div class="controls">
        ${primaryActionHtml}
        <button class="btn alt icon" data-action="copy" aria-label="Copy" title="Copy">${isCopyFeedbackActive(`starred:${invite}`) ? '✓' : '⧉'}</button>
        <button class="btn alt icon" data-action="unstar" aria-label="Unstar" title="Unstar">★</button>
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
    renderActionButtons()
    return
  }

  for (const item of state.hostHistory) {
    const selected = state.selectedHistory.has(item.id)
    const isRehosting = state.rehostingHistoryIds.has(String(item.id || '').trim())
    const sourceSummary =
      (item.sourceRefs || []).map((ref) => ref.path).join(' | ') || 'No source paths'
    const parsedLabel = parseSessionLabel(item.sessionName || 'Host Session')
    const sessionDateTime = formatSessionDateTime(item.createdAt, parsedLabel.embeddedDateTime)

    const row = document.createElement('div')
    row.className = 'row-item history-row'
    row.dataset.historyId = String(item.id || '')
    row.innerHTML = `
      <input type="checkbox" ${selected ? 'checked' : ''} />
      <div>
        <div class="row-title">${escapeHtml(parsedLabel.title)}${parsedLabel.hash ? ` <span class="host-hash-inline">(${escapeHtml(parsedLabel.hash)})</span>` : ''}</div>
        ${sessionDateTime ? `<div class="host-date">${escapeHtml(sessionDateTime)}</div>` : ''}
        <div class="row-sub">${escapeHtml(sourceSummary)}</div>
      </div>
      <div class="controls">
        <button class="btn alt icon" data-action="rehost" aria-label="Re-host" title="Re-host" ${isRehosting ? 'disabled' : ''}>${isRehosting ? '<span class="mini-spinner"></span>' : '▶'}</button>
        <button class="btn alt icon icon-danger" data-action="remove" aria-label="Remove" title="Remove">${BIN_ICON}</button>
      </div>
    `
    historyRowsEl.appendChild(row)
  }
  renderActionButtons()
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
    renderActionButtons()
    return
  }

  const selectedCount = state.inviteEntries.filter((entry) =>
    state.inviteSelected.has(entryKey(entry))
  ).length
  const rows = buildVisibleDriveRows()
  for (const row of rows) {
    if (row.type === 'file') {
      const key = row.key
      const checked = state.inviteSelected.has(key)
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td><input type="checkbox" data-action="toggle-file" data-key="${escapeHtmlAttr(key)}" ${checked ? 'checked' : ''}></td>
        <td>${'&nbsp;'.repeat(row.depth * 4)}${escapeHtml(row.name)}</td>
        <td class="small">${escapeHtml(row.drivePath)}</td>
        <td class="small">${formatBytes(Number(row.byteLength || 0))}</td>
      `
      driveRowsEl.appendChild(tr)
      continue
    }

    const folderChecked =
      row.fileKeys.length > 0 && row.fileKeys.every((key) => state.inviteSelected.has(key))
    const folderSomeChecked =
      !folderChecked && row.fileKeys.some((key) => state.inviteSelected.has(key))
    const expanded = state.expandedDriveFolders.has(row.folderPath)
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><input type="checkbox" data-action="toggle-folder" data-folder="${escapeHtmlAttr(row.folderPath)}" ${folderChecked ? 'checked' : ''}></td>
      <td>${'&nbsp;'.repeat(row.depth * 4)}<button class="btn alt" data-action="toggle-expand" data-folder="${escapeHtmlAttr(row.folderPath)}" style="padding:2px 6px; min-width: 26px;">${expanded ? '▾' : '▸'}</button> <strong>${escapeHtml(row.name)}</strong></td>
      <td class="small">${escapeHtml(`/files/${row.folderPath}`)}</td>
      <td class="small">${row.fileKeys.length} files</td>
    `
    const check = tr.querySelector('input[type="checkbox"]')
    if (check && typeof check === 'object' && 'indeterminate' in check) {
      check.indeterminate = folderSomeChecked
    }
    driveRowsEl.appendChild(tr)
  }

  checkAllDriveEl.checked = selectedCount === state.inviteEntries.length
  checkAllDriveEl.indeterminate = selectedCount > 0 && selectedCount < state.inviteEntries.length
  renderActionButtons()
}

async function openInviteFiles() {
  if (!state.rpc) return setStatus('Worker is still starting.')
  if (state.loadingInviteManifest) return
  const invite = normalizeInvite(inviteInputEl.value)
  if (!invite) return setStatus('Paste a peardrops invite URL first.')
  const inviteVariants = buildInviteManifestVariants(invite)

  try {
    state.loadingInviteManifest = true
    renderActionButtons()
    setWorkerLogMessage('loading invite manifest')
    let manifest = null
    let resolvedInvite = ''
    let lastError = null

    for (let i = 0; i < inviteVariants.length; i++) {
      const candidate = inviteVariants[i]
      try {
        setWorkerLogMessage(`loading invite manifest (attempt ${i + 1}/${inviteVariants.length})`)
        // eslint-disable-next-line no-await-in-loop
        manifest = await state.rpc.request(RpcCommand.GET_MANIFEST, { invite: candidate })
        resolvedInvite = candidate
        break
      } catch (error) {
        lastError = error
      }
    }

    if (!manifest) throw lastError || new Error('Failed to resolve invite manifest')

    const entries = Array.isArray(manifest?.files) ? manifest.files : []
    state.inviteSource = resolvedInvite || invite
    state.inviteEntries = entries
    state.inviteSelected = new Set(entries.map((entry) => entryKey(entry)))
    state.expandedDriveFolders.clear()
    renderDriveRows()
    setStatus(`Drive loaded (${entries.length} file${entries.length === 1 ? '' : 's'}).`)
  } catch (error) {
    setStatus(`View drive failed: ${error.message || String(error)}`)
  } finally {
    state.loadingInviteManifest = false
    renderActionButtons()
  }
}

async function downloadInviteSelected() {
  if (!state.rpc) return setStatus('Worker is still starting.')
  if (state.downloadingSelected) return
  if (!state.inviteSource) return setStatus('Load an invite drive first.')

  const selected = state.inviteEntries.filter((entry) => state.inviteSelected.has(entryKey(entry)))
  if (!selected.length) return setStatus('Select at least one drive file to download.')

  let targetDir = String((await bridge.pickDirectory?.()) || '').trim()
  if (!targetDir) targetDir = String((await bridge.getDownloadsPath?.()) || '').trim()
  if (!targetDir) return setStatus('No destination selected.')

  try {
    state.downloadingSelected = true
    renderActionButtons()
    upsertWorkerActivityBar('download-selected', 'Downloading selected files', 0, selected.length)

    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i]
      const drivePath = String(entry?.drivePath || '').trim()
      if (!drivePath) continue
      const outputPath = resolveOutputPath(targetDir, entry)
      await fs.mkdir(nodePath.dirname(outputPath), { recursive: true })
      await writeEntryToFile(
        state.rpc,
        state.inviteSource,
        drivePath,
        outputPath,
        Number(entry.byteLength || 0)
      )
      upsertWorkerActivityBar(
        'download-selected',
        'Downloading selected files',
        i + 1,
        selected.length
      )
    }

    clearWorkerActivityBar('download-selected')
    setStatus(
      `Downloaded ${selected.length} file${selected.length === 1 ? '' : 's'} to ${targetDir}.`
    )
  } catch (error) {
    clearWorkerActivityBar('download-selected')
    setStatus(`Download failed: ${error.message || String(error)}`)
  } finally {
    state.downloadingSelected = false
    renderActionButtons()
  }
}

async function hostSelectedSources(sessionNameInput = 'Host Session', packaging = 'raw') {
  if (!state.rpc) return setStatus('Worker is still starting.')
  if (state.hostingSelected) return

  const ids = Array.from(state.selectedSources)
  if (!ids.length) return setStatus('Select at least one local source first.')

  const picked = dedupeSourceRows(state.sources.filter((item) => ids.includes(item.id)))
  if (!picked.length) return setStatus('Selected sources are no longer available.')

  try {
    state.hostingSelected = true
    renderActionButtons()
    let files = []
    if (packaging === 'zip') {
      upsertWorkerActivityBar('host-expand', 'Preparing zip package', 0, 1)
      setWorkerLogMessage('building zip package')
      files = [await buildZipUploadPayload(picked, sessionNameInput)]
      upsertWorkerActivityBar('host-expand', 'Preparing zip package', 1, 1)
      clearWorkerActivityBar('host-expand')
    } else {
      upsertWorkerActivityBar('host-expand', 'Indexing local sources', 0, picked.length)
      for (let i = 0; i < picked.length; i++) {
        const source = picked[i]
        // Re-host/source-host must fail when saved source paths no longer exist.
        // eslint-disable-next-line no-await-in-loop
        const expanded = await expandSourceToFiles(source)
        files.push(...expanded)
        upsertWorkerActivityBar('host-expand', 'Indexing local sources', i + 1, picked.length)
      }
      clearWorkerActivityBar('host-expand')
    }

    if (!files.length) return setStatus('No readable files found in selected sources.')

    setWorkerLogMessage('creating upload host')
    upsertWorkerActivityBar('host-upload', 'Creating host upload', 0, 1)

    const sessionName = String(sessionNameInput || '').trim() || 'Host Session'
    const response = await state.rpc.request(RpcCommand.CREATE_UPLOAD, {
      files,
      sessionName
    })

    clearWorkerActivityBar('host-upload')

    const invite = String(response?.nativeInvite || response?.invite || '').trim()
    if (invite) {
      state.runningHistoryByInvite.set(invite, {
        id: `hist:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
        sourceRefs: picked.map((item) => ({ type: item.type, path: item.path, name: item.name })),
        invite,
        sessionName,
        createdAt: Date.now(),
        fileCount: Array.isArray(response?.manifest) ? response.manifest.length : files.length,
        totalBytes: Number(
          response?.transfer?.totalBytes ||
            files.reduce((sum, row) => sum + Number(row.byteLength || 0), 0)
        )
      })
    }

    const selectedSet = new Set(ids.map((id) => String(id || '')))
    state.sources = state.sources.filter((item) => !selectedSet.has(String(item?.id || '')))
    state.selectedSources.clear()
    persistSources()
    await refreshActiveHosts()
    if (invite) highlightHostRow(invite)
    renderAll()
    setStatus('Hosting started.')
  } catch (error) {
    clearWorkerActivityBar('host-expand')
    clearWorkerActivityBar('host-upload')
    setStatus(`Host failed: ${error.message || String(error)}`)
  } finally {
    state.hostingSelected = false
    renderActionButtons()
  }
}

async function buildZipUploadPayload(sources, sessionNameInput) {
  const sourcePaths = []
  const parentDirs = []
  for (const source of sources) {
    const srcPath = String(source?.path || '').trim()
    if (!srcPath) continue
    // eslint-disable-next-line no-await-in-loop
    const exists = await pathExists(srcPath)
    if (!exists) throw new Error(`Source path does not exist: ${srcPath}`)
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.stat(srcPath)
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Source is not a file or folder: ${srcPath}`)
    }
    const absolute = nodePath.resolve(srcPath)
    sourcePaths.push(absolute)
    parentDirs.push(stat.isDirectory() ? nodePath.dirname(absolute) : nodePath.dirname(absolute))
  }
  if (!sourcePaths.length) throw new Error('No source paths available for zip package')

  const workspaceDir = commonParentDir(parentDirs)
  const relTargets = sourcePaths.map((item) => nodePath.relative(workspaceDir, item))
  const zipNameBase = sanitizePathPart(String(sessionNameInput || 'Host Session'))
  const zipName = `${zipNameBase || 'Host-Session'}-${Date.now()}.zip`
  const zipPath = nodePath.join(os.tmpdir(), zipName)
  await fs.unlink(zipPath).catch(() => {})

  try {
    await execFileAsync('zip', ['-r', '-y', zipPath, ...relTargets], { cwd: workspaceDir })
  } catch (error) {
    const details = String(error?.stderr || error?.message || '').trim()
    throw new Error(
      details
        ? `Zip packaging failed: ${details}`
        : 'Zip packaging failed. Install the zip utility or choose Raw files in host options.'
    )
  }

  const stat = await fs.stat(zipPath)
  return {
    name: zipName,
    path: zipPath,
    drivePath: `/files/${sanitizePathPart(zipName)}`,
    byteLength: Number(stat.size || 0),
    mimeType: 'application/zip'
  }
}

function commonParentDir(paths) {
  if (!Array.isArray(paths) || !paths.length) return os.tmpdir()
  const resolved = paths.map((item) => nodePath.resolve(String(item || ''))).filter(Boolean)
  if (!resolved.length) return os.tmpdir()
  let common = resolved[0]
  for (let i = 1; i < resolved.length; i++) {
    const current = resolved[i]
    while (!isPathInsideOrSame(common, current)) {
      const parent = nodePath.dirname(common)
      if (parent === common) return parent || os.tmpdir()
      common = parent
    }
  }
  return common || os.tmpdir()
}

function isPathInsideOrSame(basePath, targetPath) {
  const base = nodePath.resolve(String(basePath || ''))
  const target = nodePath.resolve(String(targetPath || ''))
  const rel = nodePath.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel))
}

async function refreshActiveHosts() {
  if (!state.rpc) return
  try {
    const response = await state.rpc.request(RpcCommand.LIST_ACTIVE_HOSTS, {})
    const hosts = Array.isArray(response?.hosts) ? response.hosts : []
    finalizeEndedRunningSessions(hosts)
    state.activeHosts = hosts
    void bridge.setHostingActive?.(hosts.length > 0).catch?.(() => {})

    const validInvites = new Set(
      hosts.map((host) => String(host.invite || '').trim()).filter(Boolean)
    )
    state.selectedHosts = new Set(
      Array.from(state.selectedHosts).filter((invite) => validInvites.has(invite))
    )

    renderHosts()
  } catch {
    state.activeHosts = []
    state.selectedHosts.clear()
    void bridge.setHostingActive?.(false).catch?.(() => {})
    renderHosts()
  }
}

async function stopSelectedHosts() {
  if (!state.rpc) return setStatus('Worker is still starting.')
  if (state.stoppingSelectedHosts) return
  const invites = Array.from(state.selectedHosts).filter(Boolean)
  if (!invites.length) return setStatus('Select at least one active host first.')

  state.stoppingSelectedHosts = true
  renderActionButtons()
  try {
    upsertWorkerActivityBar('hosts-stop', 'Stopping selected hosts', 0, invites.length)

    for (let i = 0; i < invites.length; i++) {
      const invite = invites[i]
      const activeHost = state.activeHosts.find(
        (host) => String(host?.invite || '').trim() === invite
      )
      try {
        // eslint-disable-next-line no-await-in-loop
        await state.rpc.request(RpcCommand.STOP_HOST, { invite })
        finalizeStoppedSession(invite, activeHost)
      } catch {}
      upsertWorkerActivityBar('hosts-stop', 'Stopping selected hosts', i + 1, invites.length)
    }

    clearWorkerActivityBar('hosts-stop')
    state.selectedHosts.clear()
    await refreshActiveHosts()
    setStatus(`Stopped ${invites.length} host${invites.length === 1 ? '' : 's'}.`)
  } finally {
    state.stoppingSelectedHosts = false
    clearWorkerActivityBar('hosts-stop')
    renderActionButtons()
  }
}

async function stopHost(invite) {
  if (!state.rpc) return
  const key = String(invite || '').trim()
  if (key && state.stoppingInvites.has(key)) return
  try {
    if (key) {
      state.stoppingInvites.add(key)
      renderHosts()
      renderStarredHosts()
    }
    const activeHost = state.activeHosts.find(
      (host) => String(host?.invite || '').trim() === String(invite || '').trim()
    )
    await state.rpc.request(RpcCommand.STOP_HOST, { invite })
    finalizeStoppedSession(invite, activeHost)
    state.selectedHosts.delete(invite)
    await refreshActiveHosts()
    setStatus('Host stopped.')
  } catch (error) {
    setStatus(`Stop failed: ${error.message || String(error)}`)
  } finally {
    const key = String(invite || '').trim()
    if (key) {
      state.stoppingInvites.delete(key)
      renderHosts()
      renderStarredHosts()
    }
  }
}

async function rehostSelectedHistory() {
  if (state.rehostingSelectedBulk) return
  const picked = state.hostHistory.filter((item) => state.selectedHistory.has(item.id))
  if (!picked.length) return setStatus('Select at least one history item first.')

  state.rehostingSelectedBulk = true
  renderActionButtons()
  try {
    upsertWorkerActivityBar('rehost-bulk', 'Re-hosting selected history', 0, picked.length)

    for (let i = 0; i < picked.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      await rehostHistoryItem(picked[i])
      upsertWorkerActivityBar('rehost-bulk', 'Re-hosting selected history', i + 1, picked.length)
    }

    clearWorkerActivityBar('rehost-bulk')
    await refreshActiveHosts()
    renderAll()
  } finally {
    state.rehostingSelectedBulk = false
    clearWorkerActivityBar('rehost-bulk')
    renderActionButtons()
  }
}

async function resolveExistingSourceRefsWithPrompt(refs, actionLabel = 'Host') {
  const uniqueRefs = dedupeSourceRows(refs)
  const existing = []
  const missing = []
  for (const ref of uniqueRefs) {
    const srcPath = String(ref?.path || '').trim()
    if (!srcPath) continue
    // eslint-disable-next-line no-await-in-loop
    const exists = await pathExists(srcPath)
    if (exists) existing.push(ref)
    else missing.push(srcPath)
  }
  if (!missing.length) return existing

  const preview = missing.slice(0, 5).join('\n')
  const tail = missing.length > 5 ? `\n…and ${missing.length - 5} more.` : ''
  const proceed = window.confirm(
    `${actionLabel} found missing sources:\n\n${preview}${tail}\n\nContinue anyway and remove missing sources?`
  )
  if (!proceed) throw new Error(`${actionLabel} cancelled because some sources were missing`)
  if (!existing.length) throw new Error('No remaining sources are available to host')
  return existing
}

async function applySessionEditorChanges() {
  if (!state.rpc) return setStatus('Worker is still starting.')
  if (!state.sessionEditorOpen || state.sessionEditorApplying) return
  if (!state.sessionEditorRefs.length) return setStatus('Add at least one source first.')

  try {
    state.sessionEditorApplying = true
    renderActionButtons()

    const rawRefs = state.sessionEditorRefs.map((ref) => ({
      type: ref.type === 'folder' ? 'folder' : 'file',
      path: ref.path,
      name: ref.name
    }))
    const validRefs = await resolveExistingSourceRefsWithPrompt(rawRefs, 'Apply changes')

    if (state.sessionEditorMode === 'history') {
      state.hostHistory = state.hostHistory.map((row) =>
        String(row?.id || '') === String(state.sessionEditorHistoryId || '')
          ? { ...row, sourceRefs: validRefs, sessionName: state.sessionEditorSessionName }
          : row
      )
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
      closeSessionEditor()
      renderHistory()
      setStatus('Session source list updated.')
      return
    }

    const files = []
    upsertWorkerActivityBar('session-apply', 'Applying session source changes', 0, validRefs.length)
    for (let i = 0; i < validRefs.length; i++) {
      const ref = validRefs[i]
      // eslint-disable-next-line no-await-in-loop
      const expanded = await expandSourceToFiles(ref)
      files.push(...expanded)
      upsertWorkerActivityBar(
        'session-apply',
        'Applying session source changes',
        i + 1,
        validRefs.length
      )
    }
    clearWorkerActivityBar('session-apply')
    if (!files.length) throw new Error('No readable files available from selected sources')

    const previousInvite = String(state.sessionEditorInvite || '').trim()
    if (!previousInvite) {
      throw new Error('Active host invite missing; cannot apply in-place changes')
    }

    const response = await state.rpc.request(RpcCommand.UPDATE_ACTIVE_HOST, {
      invite: previousInvite,
      files,
      sessionName: String(state.sessionEditorSessionName || 'Host Session').trim() || 'Host Session'
    })
    const invite = previousInvite
    if (invite) {
      const totalBytes = Number(files.reduce((sum, row) => sum + Number(row.byteLength || 0), 0))
      state.runningHistoryByInvite.set(invite, {
        id: String(
          state.sessionEditorHistoryId ||
            `hist:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`
        ),
        sourceRefs: validRefs,
        invite,
        sessionName: state.sessionEditorSessionName,
        createdAt: Number(
          state.runningHistoryByInvite.get(invite)?.createdAt ||
            state.activeHosts.find((row) => String(row?.invite || '').trim() === invite)
              ?.createdAt ||
            Date.now()
        ),
        fileCount: Array.isArray(response?.manifest) ? response.manifest.length : files.length,
        totalBytes
      })
    }

    if (state.sessionEditorHistoryId) {
      state.hostHistory = state.hostHistory.map((row) =>
        String(row?.id || '') === String(state.sessionEditorHistoryId || '')
          ? { ...row, sourceRefs: validRefs, sessionName: state.sessionEditorSessionName }
          : row
      )
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
    }

    await refreshActiveHosts()
    closeSessionEditor()
    renderAll()
    setStatus('Session changes applied to active host.')
  } catch (error) {
    clearWorkerActivityBar('session-apply')
    setStatus(`Apply failed: ${error.message || String(error)}`)
  } finally {
    state.sessionEditorApplying = false
    clearWorkerActivityBar('session-apply')
    renderActionButtons()
    renderSessionEditor()
  }
}

async function rehostHistoryItem(historyItem) {
  if (!state.rpc) return setStatus('Worker is still starting.')
  const rowId = String(historyItem?.id || '').trim()
  if (rowId && state.rehostingHistoryIds.has(rowId)) return
  if (rowId) {
    state.rehostingHistoryIds.add(rowId)
    renderHistory()
    renderStarredHosts()
  }
  try {
    setWorkerLogMessage('re-hosting session')
    const refs = Array.isArray(historyItem.sourceRefs) ? historyItem.sourceRefs : []
    if (!refs.length) throw new Error('History entry does not include saved source paths')

    upsertWorkerActivityBar('rehost-expand', 'Validating history paths', 0, refs.length)

    const validRefs = await resolveExistingSourceRefsWithPrompt(refs, 'Re-host')
    for (let i = 0; i < validRefs.length; i++) {
      upsertWorkerActivityBar('rehost-expand', 'Validating history paths', i + 1, validRefs.length)
    }

    const files = []
    for (const ref of validRefs) {
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
    if (invite) {
      state.runningHistoryByInvite.set(invite, {
        ...historyItem,
        sourceRefs: validRefs,
        invite,
        createdAt: Number(historyItem.createdAt || Date.now()),
        fileCount: Array.isArray(response?.manifest) ? response.manifest.length : files.length,
        totalBytes: Number(response?.transfer?.totalBytes || historyItem.totalBytes || 0)
      })
    }
    state.hostHistory = state.hostHistory.filter((row) => row.id !== historyItem.id)
    state.selectedHistory.delete(String(historyItem.id || ''))
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
    await refreshActiveHosts()
    renderHistory()
    setStatus('Re-host started.')
  } catch (error) {
    clearWorkerActivityBar('rehost-expand')
    setStatus(`Re-host failed: ${error.message || String(error)}`)
  } finally {
    if (rowId) {
      state.rehostingHistoryIds.delete(rowId)
      renderHistory()
      renderStarredHosts()
    }
  }
}

function addLocalSources(entries) {
  const now = Date.now()
  const next = state.sources.slice()
  const existingKeys = new Set(next.map((row) => sourceIdentityKey(row)).filter(Boolean))
  const added = []

  for (const entry of entries) {
    const srcPath = String(entry.path || '').trim()
    if (!srcPath) continue
    const type = entry.type === 'folder' ? 'folder' : 'file'
    const key = sourceIdentityKey({ type, path: srcPath })
    if (key && existingKeys.has(key)) continue
    const row = {
      id: `src:${now}:${Math.random().toString(16).slice(2, 8)}`,
      type,
      path: srcPath,
      name: nodePath.basename(srcPath) || srcPath,
      addedAt: Date.now()
    }
    if (key) existingKeys.add(key)
    next.unshift(row)
    added.push(row)
    state.selectedSources.add(row.id)
  }

  state.sources = next.slice(0, 300)
  persistSources()
  renderSources()
  setStatus(`Source list updated (${state.sources.length}).`)
  for (const source of added) {
    if (source?.type !== 'file') continue
    if (!isMp3Path(source?.path)) continue
    void hydrateSourceCoverArt(source)
  }
}

async function handleWindowDrop(event) {
  const droppedPaths = extractDroppedPaths(event)
  if (!droppedPaths.length) return
  const dropIntoSessionEditor = shouldDropIntoSessionEditor(event)

  const entries = []
  for (const droppedPath of droppedPaths) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(droppedPath)
      entries.push({
        type: stat.isDirectory() ? 'folder' : 'file',
        path: droppedPath
      })
    } catch {
      // Ignore entries that no longer exist by the time drop is processed.
    }
  }

  if (!entries.length) {
    setStatus('No readable dropped files or folders were found.')
    return
  }
  if (dropIntoSessionEditor) {
    addSessionEditorRefs(entries)
    return
  }
  addLocalSources(entries)
}

function shouldDropIntoSessionEditor(event) {
  if (!state.sessionEditorOpen || !sessionEditorEl) return false
  const target = event?.target
  const DomElement = globalThis?.Element
  if (!DomElement || !(target instanceof DomElement)) return false
  return sessionEditorEl.contains(target)
}

function extractDroppedPaths(event) {
  const transfer = event?.dataTransfer
  if (!transfer) return []
  const rawPaths = []

  for (const file of Array.from(transfer.files || [])) {
    const value = resolveNativePathFromFile(file)
    if (value) rawPaths.push(value)
  }

  for (const item of Array.from(transfer.items || [])) {
    if (item?.kind !== 'file') continue
    const file = item.getAsFile?.()
    const value = resolveNativePathFromFile(file)
    if (value) rawPaths.push(value)
  }

  const uriList = String(transfer.getData?.('text/uri-list') || '').trim()
  if (uriList) rawPaths.push(...extractFileUrisFromText(uriList))

  const plainText = String(transfer.getData?.('text/plain') || '').trim()
  if (plainText) rawPaths.push(...extractFileUrisFromText(plainText))

  return normalizePathList(rawPaths)
}

function resolveNativePathFromFile(file) {
  if (!file) return ''
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const nativePath = String(webUtils.getPathForFile(file) || '').trim()
      if (nativePath) return nativePath
    }
  } catch {}
  return String(file?.path || '').trim()
}

function extractFileUrisFromText(text) {
  const output = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('file://')) {
      try {
        output.push(nodePath.normalize(fileURLToPath(line)))
      } catch {}
    }
  }
  return output
}

function finalizeStoppedSession(invite, activeHost = null) {
  const key = String(invite || '').trim()
  if (!key) return
  const running = state.runningHistoryByInvite.get(key)
  if (running) {
    state.runningHistoryByInvite.delete(key)
    rememberHistory({
      ...running,
      invite: key
    })
    return
  }

  const host =
    activeHost || state.activeHosts.find((row) => String(row?.invite || '').trim() === key)
  if (!host) return
  rememberHistory({
    id: `hist:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    sourceRefs: [],
    invite: key,
    sessionName: String(host?.sessionLabel || host?.sessionName || 'Host Session'),
    createdAt: Number(host?.createdAt || Date.now()),
    fileCount: Number(host?.fileCount || 0),
    totalBytes: Number(host?.totalBytes || 0)
  })
}

function finalizeEndedRunningSessions(activeHosts) {
  const activeInvites = new Set(
    Array.isArray(activeHosts)
      ? activeHosts.map((host) => String(host?.invite || '').trim()).filter(Boolean)
      : []
  )
  for (const [invite, entry] of state.runningHistoryByInvite.entries()) {
    if (activeInvites.has(invite)) continue
    state.runningHistoryByInvite.delete(invite)
    rememberHistory({
      ...entry
    })
  }
}

function finalizeSessionsFromActiveHosts(activeHosts) {
  if (!Array.isArray(activeHosts) || !activeHosts.length) return
  for (const host of activeHosts) {
    const invite = String(host?.invite || '').trim()
    if (!invite) continue
    finalizeStoppedSession(invite, host)
  }
}

function rememberHistory(entry) {
  state.hostHistory = [entry, ...state.hostHistory].slice(0, 200)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.hostHistory))
  renderHistory()
  renderStarredHosts()
}

function persistSources() {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(state.sources))
}

function loadHostPackagingMode() {
  const raw = String(localStorage.getItem(HOST_PACKAGING_KEY) || '')
    .trim()
    .toLowerCase()
  return raw === 'raw' ? 'raw' : 'zip'
}

function persistHostPackagingMode(mode) {
  const nextMode = mode === 'zip' ? 'zip' : 'raw'
  localStorage.setItem(HOST_PACKAGING_KEY, nextMode)
}

function highlightHostRow(invite) {
  const value = String(invite || '').trim()
  if (!value) return
  state.highlightedHostInvite = value
  if (state.highlightedHostTimer) {
    clearTimeout(state.highlightedHostTimer)
    state.highlightedHostTimer = null
  }
  state.highlightedHostTimer = setTimeout(() => {
    state.highlightedHostInvite = ''
    state.highlightedHostTimer = null
    renderHosts()
  }, 2800)
  renderHosts()
  requestAnimationFrame(() => {
    const escapedInvite = escapeCssSelector(value)
    const row = hostsRowsEl?.querySelector(`[data-invite="${escapedInvite}"]`)
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    }
  })
}

function escapeCssSelector(value) {
  const cssApi = globalThis?.CSS
  if (cssApi && typeof cssApi.escape === 'function') {
    return cssApi.escape(value)
  }
  return String(value || '').replace(/["\\]/g, '\\$&')
}

async function pruneMissingSources(reason = 'refresh') {
  if (!state.sources.length) return 0
  const checks = await Promise.all(
    state.sources.map(async (entry) => ({
      entry,
      exists: await pathExists(String(entry?.path || '').trim())
    }))
  )
  const nextSources = checks.filter((row) => row.exists).map((row) => row.entry)
  const removed = state.sources.length - nextSources.length
  if (removed <= 0) return 0

  state.sources = nextSources
  const remainingIds = new Set(nextSources.map((entry) => String(entry.id || '')))
  state.selectedSources = new Set(
    Array.from(state.selectedSources).filter((id) => remainingIds.has(String(id || '')))
  )
  persistSources()
  renderSources()
  setWorkerLogMessage(`[sources] pruned ${removed} missing path(s) on ${reason}`)
  setStatus(`Removed ${removed} missing source path${removed === 1 ? '' : 's'} from list.`)
  return removed
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
  return (
    String(value || '')
      .replaceAll('\\', '_')
      .replaceAll('/', '_')
      .replace(/\s+/g, ' ')
      .trim() || 'file'
  )
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

function sourceIdentityKey(entry) {
  const type = entry?.type === 'folder' ? 'folder' : 'file'
  const srcPath = nodePath.normalize(String(entry?.path || '').trim())
  if (!srcPath) return ''
  return `${type}::${srcPath}`
}

function dedupeSourceRows(rows) {
  if (!Array.isArray(rows)) return []
  const seen = new Set()
  const next = []
  for (const row of rows) {
    const key = sourceIdentityKey(row)
    if (!key || seen.has(key)) continue
    seen.add(key)
    next.push(row)
  }
  return next
}

function normalizeInvite(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (text.startsWith('peardrops://invite')) return ensureInviteRelay(text)
  if (text.startsWith('peardrops-web://join')) {
    try {
      const parsed = new URL(text)
      const nested = parsed.searchParams.get('invite')
      if (nested && nested.startsWith('peardrops://invite')) return ensureInviteRelay(nested)
      if (parsed.search) return ensureInviteRelay(`peardrops://invite${parsed.search}`)
    } catch {
      return ''
    }
  }
  try {
    const parsed = new URL(text)
    const nested = parsed.searchParams.get('invite')
    if (nested && nested.startsWith('peardrops://invite')) return ensureInviteRelay(nested)
  } catch {}
  return ''
}

function ensureInviteRelay(invite) {
  const value = String(invite || '').trim()
  if (!value.startsWith('peardrops://invite')) return value
  try {
    const parsed = new URL(value)
    const relay = String(parsed.searchParams.get('relay') || '').trim()
    const fallbackRelay = String(FALLBACK_RELAY_URL || '').trim()
    const relayIsLocal =
      relay.includes('localhost') || relay.includes('127.0.0.1') || relay.includes('0.0.0.0')
    if (fallbackRelay && (!relay || relayIsLocal)) parsed.searchParams.set('relay', fallbackRelay)
    return parsed.toString()
  } catch {
    return value
  }
}

function buildInviteManifestVariants(invite) {
  const base = ensureInviteRelay(invite)
  const variants = []
  const add = (value) => {
    const next = String(value || '').trim()
    if (!next) return
    if (!variants.includes(next)) variants.push(next)
  }

  add(base)

  try {
    const parsed = new URL(base)
    const drive = String(parsed.searchParams.get('drive') || '').trim()
    const room = String(parsed.searchParams.get('room') || '').trim()
    const relay = String(parsed.searchParams.get('relay') || '').trim()
    const topic = String(parsed.searchParams.get('topic') || '').trim()
    const web = String(parsed.searchParams.get('web') || '').trim()

    if (room) {
      const roomOnly = new URL('peardrops://invite')
      roomOnly.searchParams.set('room', room)
      if (relay) roomOnly.searchParams.set('relay', relay)
      if (topic) roomOnly.searchParams.set('topic', topic)
      if (web) roomOnly.searchParams.set('web', web)
      roomOnly.searchParams.set('app', 'native')
      add(roomOnly.toString())
    }

    if (drive) {
      const driveOnly = new URL('peardrops://invite')
      driveOnly.searchParams.set('drive', drive)
      if (relay) driveOnly.searchParams.set('relay', relay)
      driveOnly.searchParams.set('app', 'native')
      add(driveOnly.toString())
    }
  } catch {}

  return variants
}

function toShareableInvite(rawInvite) {
  const nativeInvite = normalizeInvite(rawInvite)
  if (!nativeInvite) return ''
  return `${PUBLIC_SITE_ORIGIN}/open/?invite=${encodeURIComponent(nativeInvite)}`
}

function parseSessionLabel(label) {
  const value = String(label || '').trim()
  if (!value) return { title: 'Host Session', embeddedDateTime: '', hash: '' }

  const parts = value.split(/\s+/).filter(Boolean)
  if (!parts.length) return { title: 'Host Session', embeddedDateTime: '', hash: '' }

  let hash = ''
  if (/^[a-f0-9]{3,8}$/i.test(parts[parts.length - 1])) {
    hash = parts.pop() || ''
  }

  let embeddedDateTime = ''
  const isDate = (part) => /^\d{4}-\d{2}-\d{2}$/.test(part)
  const isTime = (part) => /^\d{2}:\d{2}(:\d{2})?$/.test(part)
  if (parts.length >= 2 && isDate(parts[parts.length - 2]) && isTime(parts[parts.length - 1])) {
    embeddedDateTime = `${parts[parts.length - 2]} ${parts[parts.length - 1]}`
    parts.splice(parts.length - 2, 2)
  } else if (parts.length >= 1 && isDate(parts[parts.length - 1])) {
    embeddedDateTime = parts[parts.length - 1]
    parts.splice(parts.length - 1, 1)
  }

  const title = parts.join(' ').trim() || 'Host Session'
  return { title, embeddedDateTime, hash }
}

function formatSessionDateTime(createdAt, fallbackDateTime = '') {
  const ts = Number(createdAt || 0)
  if (Number.isFinite(ts) && ts > 0) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch {}
  }
  return String(fallbackDateTime || '').trim()
}

function buildVisibleDriveRows() {
  const root = { folders: new Map(), files: [] }

  for (const entry of state.inviteEntries) {
    const drivePath = String(entry?.drivePath || '').trim()
    if (!drivePath) continue
    const rel = drivePath.startsWith('/files/') ? drivePath.slice('/files/'.length) : drivePath
    const parts = rel.split('/').filter(Boolean)
    if (!parts.length) continue

    let cursor = root
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!cursor.folders.has(part)) cursor.folders.set(part, { folders: new Map(), files: [] })
      cursor = cursor.folders.get(part)
    }

    cursor.files.push({ name: parts[parts.length - 1], entry, drivePath })
  }

  const rows = []
  const walk = (node, parentPath = '', depth = 0) => {
    const folderNames = Array.from(node.folders.keys()).sort((a, b) => a.localeCompare(b))
    for (const folderName of folderNames) {
      const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName
      const fileKeys = collectDriveFolderFileKeys(folderPath)
      rows.push({
        type: 'folder',
        name: folderName,
        folderPath,
        depth,
        fileKeys
      })
      if (state.expandedDriveFolders.has(folderPath)) {
        walk(node.folders.get(folderName), folderPath, depth + 1)
      }
    }

    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name))
    for (const file of files) {
      rows.push({
        type: 'file',
        key: entryKey(file.entry),
        name: file.name,
        drivePath: file.drivePath,
        byteLength: Number(file.entry?.byteLength || 0),
        depth
      })
    }
  }

  walk(root, '', 0)
  return rows
}

function collectDriveFolderFileKeys(folderPath) {
  const prefix = `/files/${String(folderPath || '').trim()}/`
  if (!prefix.trim()) return []
  return state.inviteEntries
    .filter((entry) => {
      const drivePath = String(entry?.drivePath || '').trim()
      return drivePath.startsWith(prefix)
    })
    .map((entry) => entryKey(entry))
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
      const percent = Math.round(
        (Number(bar.done || 0) / Math.max(1, Number(bar.total || 1))) * 100
      )
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
  const raw = String(mode || 'system')
    .trim()
    .toLowerCase()
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

function isMp3Path(filePath) {
  const ext = nodePath.extname(String(filePath || '').trim()).toLowerCase()
  return ext === '.mp3'
}

async function hydrateSourceCoverArt(source) {
  const id = String(source?.id || '').trim()
  if (!id || sourceCoverLoadsInFlight.has(id)) return
  const srcPath = String(source?.path || '').trim()
  if (!srcPath || !isMp3Path(srcPath)) return
  sourceCoverLoadsInFlight.add(id)
  try {
    const cover = await extractMp3CoverDataUrl(srcPath)
    if (!cover) return
    const index = state.sources.findIndex((row) => String(row?.id || '') === id)
    if (index < 0) return
    state.sources[index] = {
      ...state.sources[index],
      coverArtDataUrl: cover
    }
    persistSources()
    renderSources()
  } catch {}
  sourceCoverLoadsInFlight.delete(id)
}

async function extractMp3CoverDataUrl(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const maxBytes = 4 * 1024 * 1024
    const head = Buffer.allocUnsafe(maxBytes)
    const { bytesRead } = await handle.read(head, 0, maxBytes, 0)
    if (!bytesRead) return ''
    const slice = head.subarray(0, bytesRead)
    return extractId3CoverDataUrl(slice)
  } finally {
    await handle.close()
  }
}

function extractId3CoverDataUrl(bytes) {
  if (!bytes || bytes.length < 10) return ''
  if (bytes.toString('ascii', 0, 3) !== 'ID3') return ''
  const version = bytes[3]
  if (version !== 3 && version !== 4) return ''

  const tagSize = readSynchsafe(bytes, 6)
  const tagEnd = Math.min(bytes.length, 10 + tagSize)
  let cursor = 10

  while (cursor + 10 <= tagEnd) {
    const frameId = bytes.toString('ascii', cursor, cursor + 4)
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break

    const frameSize =
      version === 4 ? readSynchsafe(bytes, cursor + 4) : readUInt32BE(bytes, cursor + 4)
    if (!Number.isFinite(frameSize) || frameSize <= 0) break

    const payloadStart = cursor + 10
    const payloadEnd = payloadStart + frameSize
    if (payloadEnd > tagEnd) break

    if (frameId === 'APIC') {
      const payload = bytes.subarray(payloadStart, payloadEnd)
      const cover = parseApicFrame(payload)
      if (cover) return cover
    }

    cursor = payloadEnd
  }

  return ''
}

function parseApicFrame(payload) {
  if (!payload || payload.length < 4) return ''
  const encoding = payload[0]
  let cursor = 1
  const mimeEnd = payload.indexOf(0x00, cursor)
  if (mimeEnd < 0) return ''
  const mimeType = payload.toString('latin1', cursor, mimeEnd).trim() || 'image/jpeg'
  cursor = mimeEnd + 1
  if (cursor >= payload.length) return ''
  cursor += 1
  if (cursor >= payload.length) return ''

  if (encoding === 0x01 || encoding === 0x02) {
    while (cursor + 1 < payload.length) {
      if (payload[cursor] === 0x00 && payload[cursor + 1] === 0x00) {
        cursor += 2
        break
      }
      cursor += 2
    }
  } else {
    const descEnd = payload.indexOf(0x00, cursor)
    if (descEnd >= 0) cursor = descEnd + 1
  }

  if (cursor >= payload.length) return ''
  const image = payload.subarray(cursor)
  if (!image.length) return ''
  return `data:${mimeType};base64,${image.toString('base64')}`
}

function readSynchsafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  )
}

function readUInt32BE(bytes, offset) {
  return (
    (((bytes[offset] & 0xff) << 24) |
      ((bytes[offset + 1] & 0xff) << 16) |
      ((bytes[offset + 2] & 0xff) << 8) |
      (bytes[offset + 3] & 0xff)) >>>
    0
  )
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

function flashCopyFeedback(key) {
  activeCopyFeedbackKey = String(key || '')
  renderHosts()
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = setTimeout(() => {
    activeCopyFeedbackKey = ''
    renderHosts()
  }, 1200)
}

function isCopyFeedbackActive(key) {
  return activeCopyFeedbackKey === String(key || '')
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
