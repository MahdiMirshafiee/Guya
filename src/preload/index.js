/* Bridges the sandboxed renderers to the main process. Both the settings panel
 * and the overlay load this same bridge and use the parts they need. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guya', {
  platform: process.platform,

  /* ---- settings panel ---- */
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  listModels: () => ipcRenderer.invoke('models:list'),
  testKey: (model) => ipcRenderer.invoke('models:test', model),
  toggleRecording: () => ipcRenderer.invoke('recording:toggle'),
  cancelRecording: () => ipcRenderer.invoke('recording:cancel'),
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:copy', text),
  openPrivacySettings: (kind) => ipcRenderer.invoke('system:open-privacy', kind),
  openExternal: (what) => ipcRenderer.invoke('system:open-external', what),
  quit: () => ipcRenderer.invoke('app:quit'),
  suspendShortcutCapture: (suspended) => ipcRenderer.invoke('shortcut:suspend-capture', suspended),
  retryShortcut: () => ipcRenderer.invoke('shortcut:retry'),
  accessibilityStatus: () => ipcRenderer.invoke('permissions:accessibility'),
  pasteSupport: () => ipcRenderer.invoke('permissions:paste'),
  requestAccessibility: () => ipcRenderer.invoke('permissions:request-accessibility'),
  onSpectrum: (handler) => {
    const listener = (_event, levels) => handler(levels);
    ipcRenderer.on('panel:spectrum', listener);
    return () => ipcRenderer.removeListener('panel:spectrum', listener);
  },
  onPanelState: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('panel:state', listener);
    return () => ipcRenderer.removeListener('panel:state', listener);
  },

  /* ---- recording overlay ---- */
  onOverlayCommand: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('overlay:command', listener);
    return () => ipcRenderer.removeListener('overlay:command', listener);
  },
  overlayReady: () => ipcRenderer.invoke('audio:ready'),
  overlayFailed: (message) => ipcRenderer.invoke('audio:error', message),
  overlayResult: (wav, durationMs, voiceMs, trimmedMs) => ipcRenderer.invoke('audio:result', { wav, durationMs, voiceMs, trimmedMs }),
  overlayAutoStopped: (reason) => ipcRenderer.invoke('audio:auto-stop', reason),
  sendSpectrum: (levels) => ipcRenderer.send('audio:spectrum', levels)
});
