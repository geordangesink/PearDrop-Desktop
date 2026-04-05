const { contextBridge, ipcRenderer } = require('electron')

const api = {
  pkg() {
    return ipcRenderer.sendSync('pkg')
  },
  startWorker(specifier) {
    return ipcRenderer.invoke('pear:startWorker', specifier)
  },
  writeWorkerIPC(specifier, data) {
    return ipcRenderer.invoke(`pear:worker:writeIPC:${specifier}`, data)
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
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('bridge', api)
} else {
  window.bridge = api
}
