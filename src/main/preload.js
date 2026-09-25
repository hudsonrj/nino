'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Assina um canal e devolve a função de cancelamento. */
function on(channel, fn) {
  const handler = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/**
 * Arrastar-e-soltar arquivos.
 * Feito aqui no preload porque `File.path` não existe mais e o objeto File
 * não atravessa o contextBridge.
 */
window.addEventListener(
  'dragover',
  (event) => {
    event.preventDefault();
    event.stopPropagation();
  },
  true
);

window.addEventListener(
  'drop',
  (event) => {
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    const paths = files
      .map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (paths.length) {
      ipcRenderer.send('kb:dropped', { paths, names: files.map((f) => f.name) });
    }
  },
  true
);

contextBridge.exposeInMainWorld('nino', {
  /* ------------------------------ Conversa ------------------------------ */
  chat: {
    send: (text, opts) => ipcRenderer.invoke('chat:send', { text, ...(opts || {}) }),
    abort: () => ipcRenderer.invoke('chat:abort'),
    reset: () => ipcRenderer.invoke('chat:reset'),
    onToken: (fn) => on('chat:token', fn),
    onDone: (fn) => on('chat:done', fn),
    onError: (fn) => on('chat:error', fn),
    onAborted: (fn) => on('chat:aborted', fn),
  },

  /* -------------------------------- Voz -------------------------------- */
  voice: {
    speak: (text) => ipcRenderer.invoke('tts:speak', { text }),
    stop: () => ipcRenderer.invoke('tts:stop'),
    listen: () => ipcRenderer.invoke('audio:listen'),
    stopListening: () => ipcRenderer.invoke('audio:stop'),
    onTtsState: (fn) => on('tts:state', fn),
    onAudioState: (fn) => on('audio:state', fn),
    onTranscript: (fn) => on('audio:transcript', fn),
    onError: (fn) => on('audio:error', fn),
  },

  /* ------------------------- Base de conhecimento ------------------------ */
  kb: {
    addViaDialog: () => ipcRenderer.invoke('kb:add'),
    addPaths: (paths) => ipcRenderer.invoke('kb:addPaths', { paths }),
    list: () => ipcRenderer.invoke('kb:list'),
    remove: (id) => ipcRenderer.invoke('kb:remove', { id }),
    clear: () => ipcRenderer.invoke('kb:clear'),
    stats: () => ipcRenderer.invoke('kb:stats'),
    search: (query) => ipcRenderer.invoke('kb:search', { query }),
    onProgress: (fn) => on('kb:progress', fn),
    onChanged: (fn) => on('kb:changed', fn),
  },

  /* ----------------------------- Ajustes ------------------------------- */
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', { patch }),
  },

  /* ------------------------------ Sistema ------------------------------ */
  system: {
    status: () => ipcRenderer.invoke('system:status'),
    voices: () => ipcRenderer.invoke('system:voices'),
    models: () => ipcRenderer.invoke('system:models'),
    openDataFolder: () => ipcRenderer.invoke('system:openData'),
    quit: () => ipcRenderer.invoke('app:quit'),
    onReady: (fn) => on('app:ready', fn),
    onClickThrough: (fn) => on('app:clickThrough', fn),
  },

  /* ------------------------------- Janela ------------------------------ */
  win: {
    dragStart: (x, y) => ipcRenderer.invoke('win:dragStart', { x, y }),
    dragMove: (x, y) => ipcRenderer.invoke('win:dragMove', { x, y }),
    dragEnd: () => ipcRenderer.invoke('win:dragEnd'),
    resize: (width, height, anchor) => ipcRenderer.invoke('win:resize', { width, height, anchor }),
    hide: () => ipcRenderer.invoke('win:hide'),
    clickThrough: (enabled) => ipcRenderer.invoke('win:clickThrough', { enabled }),
  },
});
