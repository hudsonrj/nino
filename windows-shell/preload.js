'use strict';

/**
 * Preload do shell nativo do Windows.
 *
 * A interface vem do servidor (HTTP), então quem define `window.nino` é o
 * bridge-web.js. Aqui só expomos os controles que só a janela nativa tem:
 * redimensionar, arrastar, esconder e o modo clique-através.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__ninoShell', {
  isShell: true,
  resize: (width, height) => ipcRenderer.invoke('win:resize', { width, height }),
  dragStart: () => ipcRenderer.invoke('win:dragStart'),
  dragEnd: () => ipcRenderer.invoke('win:dragEnd'),
  hide: () => ipcRenderer.invoke('win:hide'),
  clickThrough: (enabled) => ipcRenderer.invoke('win:clickThrough', { enabled }),
  quit: () => ipcRenderer.invoke('app:quit'),
  info: () => ipcRenderer.invoke('app:info'),
  // Captura a tela direto pelo processo principal: sem seletor e sem permissão.
  captureScreen: (maxSide) => ipcRenderer.invoke('screen:capture', { maxSide }),
});
