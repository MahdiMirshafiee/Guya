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
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:copy', text),
  openPrivacySettings: (kind) => ipcRenderer.invoke('system:open-privacy', kind),
  accessibilityStatus: () => ipcRenderer.invoke('permissions:accessibility'),
  pasteSupport: () => ipcRenderer.invoke('permissions:paste'),
  requestAccessibility: () => ipcRenderer.invoke('permissions:request-accessibility'),
  onLevel: (handler) => {
    const listener = (_event, level) => handler(level);
    ipcRenderer.on('panel:level', listener);
    return () => ipcRenderer.removeListener('panel:level', listener);
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
  overlayResult: (wav, durationMs) => ipcRenderer.invoke('audio:result', { wav, durationMs }),
  overlayAutoStopped: () => ipcRenderer.invoke('audio:auto-stop'),
  sendLevel: (level) => ipcRenderer.send('audio:level', level)
});
