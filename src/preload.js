'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const handler = (_event, payload) => {
    try {
      callback(payload)
    } catch (error) {
      console.error('[remielle] listener failed', channel, error)
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('remielle', {
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke('remielle:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('remielle:set-config', patch),
  resetConfig: () => ipcRenderer.invoke('remielle:reset-config'),
  openSettings: () => ipcRenderer.invoke('remielle:open-settings'),
  closeSettings: () => ipcRenderer.invoke('remielle:close-settings'),
  setIgnoreMouse: (value) => ipcRenderer.invoke('remielle:set-ignore', value),
  petClick: (action) => ipcRenderer.invoke('remielle:pet-click', action),
  dismissBubble: () => ipcRenderer.invoke('remielle:dismiss-bubble'),
  browseRes: () => ipcRenderer.invoke('remielle:browse-res'),
  reloadAssets: () => ipcRenderer.invoke('remielle:reload-assets'),
  openRes: () => ipcRenderer.invoke('remielle:open-res'),
  openLog: () => ipcRenderer.invoke('remielle:open-log'),
  testConnection: () => ipcRenderer.invoke('remielle:test-connection'),
  testBubble: () => ipcRenderer.invoke('remielle:test-bubble'),
  getRuntime: () => ipcRenderer.invoke('remielle:get-runtime'),
  onConfig: (callback) => {
    subscribe('remielle:config', callback)
  },
  onState: (callback) => {
    subscribe('remielle:state', callback)
  },
  onBubble: (callback) => {
    subscribe('remielle:bubble', callback)
  },
  onBubbleHide: (callback) => {
    subscribe('remielle:bubble-hide', callback)
  },
})
