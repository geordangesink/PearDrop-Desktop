const { contextBridge, ipcRenderer } = require('electron')

const api = {
  pkg() {
    return ipcRenderer.sendSync('pkg')
  },
  startWorker(specifier) {
    return ipcRenderer.invoke('pear:startWorker', specifier)
  },
  writeWorkerIPC(specifier, data) {
    return ipcRenderer.invoke('pear:worker:writeIPC', specifier, data)
  },
  onWorkerIPC(specifier, listener) {
    const wrap = (evt, data) => listener(Buffer.from(data))
    ipcRenderer.on(`pear:worker:ipc:${specifier}`, wrap)
    return () => ipcRenderer.removeListener(`pear:worker:ipc:${specifier}`, wrap)
  },
  onWorkerStdout(specifier, listener) {
    const wrap = (evt, data) => listener(Buffer.from(data))
    ipcRenderer.on(`pear:worker:stdout:${specifier}`, wrap)
    return () => ipcRenderer.removeListener(`pear:worker:stdout:${specifier}`, wrap)
  },
  onWorkerStderr(specifier, listener) {
    const wrap = (evt, data) => listener(Buffer.from(data))
    ipcRenderer.on(`pear:worker:stderr:${specifier}`, wrap)
    return () => ipcRenderer.removeListener(`pear:worker:stderr:${specifier}`, wrap)
  },
  onDeepLink(listener) {
    const wrap = (evt, url) => listener(String(url || ''))
    ipcRenderer.on('app:deep-link', wrap)
    return () => ipcRenderer.removeListener('app:deep-link', wrap)
  },
  onAppQuitting(listener) {
    const wrap = (evt, payload) => listener(payload || {})
    ipcRenderer.on('app:quitting', wrap)
    return () => ipcRenderer.removeListener('app:quitting', wrap)
  },
  pickDirectory() {
    return ipcRenderer.invoke('app:pickDirectory')
  },
  pickFiles() {
    return ipcRenderer.invoke('app:pickFiles')
  },
  getDownloadsPath() {
    return ipcRenderer.invoke('app:getDownloadsPath')
  },
  getThemeMode() {
    return ipcRenderer.invoke('app:getThemeMode')
  },
  setHostingActive(active) {
    return ipcRenderer.invoke('app:setHostingActive', Boolean(active))
  },
  onThemeMode(listener) {
    const wrap = (evt, payload) => listener(payload || {})
    ipcRenderer.on('app:theme-mode', wrap)
    return () => ipcRenderer.removeListener('app:theme-mode', wrap)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('bridge', api)
} else {
  window.bridge = api
}
