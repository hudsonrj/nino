'use strict';

/**
 * Nino — shell nativo para Windows.
 *
 * Esta é a "casca": uma janela Electron transparente, sem borda e sempre no
 * topo, que roda no Windows e mostra a interface servida pelo WSL.
 *
 * Por que assim: o WSLg deste computador não consegue desenhar janelas (falta
 * /dev/dri e o Weston cai para software), então o mascote nunca aparecia.
 * Rodando a janela no Windows, tudo funciona — inclusive áudio e microfone —
 * e o trabalho pesado (Ollama, base de conhecimento, Piper, Whisper) continua
 * dentro do WSL.
 *
 * Se o servidor não estiver no ar, o shell sobe ele sozinho pelo wsl.exe.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, desktopCapturer,
} = require('electron');

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */

const SERVER_URL = process.env.NINO_URL || 'http://127.0.0.1:3081';
const WSL_DISTRO = process.env.NINO_WSL_DISTRO || 'kali-linux';
const WSL_USER = process.env.NINO_WSL_USER || 'hudson';
const WSL_DIR = process.env.NINO_WSL_DIR || '/home/hudson/clone/mascote';
const WSL_PORT = process.env.NINO_PORT || '3081';

const IDLE_SIZE = { width: 240, height: 260 };
const OPEN_SIZE = { width: 460, height: 700 };
const MARGIN = 16;

let win = null;
let tray = null;
let quitting = false;
let clickThrough = false;
let dragTimer = null;
let dragState = null;
let serverChild = null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

function pingServer() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_URL}/api/status`, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startServerInWsl() {
  if (serverChild) return;
  const comando = `cd ${WSL_DIR} && node src/server/web.js --port ${WSL_PORT}`;
  try {
    console.log('[shell] subindo o servidor no WSL…');
    serverChild = spawn(
      'wsl.exe',
      ['-d', WSL_DISTRO, '-u', WSL_USER, '--', 'bash', '-lc', comando],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    serverChild.unref();
  } catch (err) {
    console.error('[shell] não consegui iniciar o servidor no WSL:', err.message);
  }
}

async function ensureServer() {
  if (await pingServer()) {
    console.log('[shell] servidor já está no ar');
    return true;
  }
  if (process.env.NINO_NO_AUTOSTART === '1') return false;

  startServerInWsl();
  for (let i = 0; i < 45; i += 1) {
    await delay(1000);
    if (await pingServer()) {
      console.log(`[shell] servidor respondeu depois de ${i + 1}s`);
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Página de espera / erro                                             */
/* ------------------------------------------------------------------ */

function paginaDeErro(mensagem) {
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Nino</title>
<style>
  html,body{margin:0;height:100%;background:transparent;font-family:"Segoe UI",sans-serif;color:#e8f4f8}
  .cx{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
      background:linear-gradient(160deg,#1b2733,#0d141c);border-radius:16px;padding:22px;box-sizing:border-box;
      border:1px solid rgba(255,255,255,.1)}
  .b{font-size:52px;margin-bottom:10px}
  h1{font-size:16px;margin:0 0 8px}
  p{font-size:12.5px;color:#93a9b8;line-height:1.6;margin:0 0 14px}
  code{background:rgba(0,0,0,.35);padding:2px 6px;border-radius:5px;font-size:11.5px}
  button{background:linear-gradient(160deg,#48d6e8,#1d8fb4);border:0;color:#04181f;font-weight:700;
         padding:9px 16px;border-radius:9px;cursor:pointer;font-size:12.5px}
</style></head><body><div class="cx">
  <div class="b">🐣</div>
  <h1>Nino não conseguiu falar com o servidor</h1>
  <p>${mensagem}</p>
  <p>Para subir o servidor manualmente, no WSL:<br>
     <code>cd ~/clone/mascote &amp;&amp; ./nino-web.sh</code></p>
  <button onclick="location.href='${SERVER_URL}'">Tentar de novo</button>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/* ------------------------------------------------------------------ */
/* Janela                                                              */
/* ------------------------------------------------------------------ */

function workAreaFor(target) {
  const display = target
    ? screen.getDisplayNearestPoint(target)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

function bottomRightBounds(width, height, keepCorner) {
  const area = workAreaFor(
    keepCorner && win ? { x: win.getBounds().x + 10, y: win.getBounds().y + 10 } : null
  );
  if (keepCorner && win) {
    const b = win.getBounds();
    let x = b.x + b.width - width;
    let y = b.y + b.height - height;
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
    return { x: Math.round(x), y: Math.round(y), width, height };
  }
  return {
    x: Math.round(area.x + area.width - width - MARGIN),
    y: Math.round(area.y + area.height - height - MARGIN),
    width,
    height,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...bottomRightBounds(IDLE_SIZE.width, IDLE_SIZE.height, false),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // `resizable: false` pode fazer o setBounds ser ignorado; a janela é sem
    // borda, então na prática ninguém redimensiona à mão.
    resizable: true,
    maximizable: false,
    minimizable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    title: 'Nino',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');

  // Mostrar a janela é surpreendentemente frágil: com `transparent: true` o
  // evento `ready-to-show` às vezes nunca dispara e a janela fica invisível
  // (aparecendo só na barra de tarefas). Por isso três caminhos redundantes.
  const mostrar = (motivo) => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) {
      win.show();
      console.log(`[shell] janela exibida (${motivo})`);
    }
    win.setAlwaysOnTop(true, 'screen-saver');
  };

  win.once('ready-to-show', () => mostrar('ready-to-show'));
  win.webContents.once('did-finish-load', () => mostrar('did-finish-load'));
  setTimeout(() => mostrar('tempo limite'), 7000);

  win.loadURL(SERVER_URL);

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[shell] falha ao carregar:', code, desc);
    win.loadURL(paginaDeErro('O servidor não respondeu.'));
  });

  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });

  // Se a página tentar abrir links, manda para o navegador do sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ */
/* Sempre no topo                                                      */
/* ------------------------------------------------------------------ */

/**
 * O `alwaysOnTop` do Electron nem sempre se sustenta no Windows: quando outro
 * programa pede foco, a janela pode ser rebaixada. Reafirmamos de tempos em
 * tempos — é o que apps de overlay fazem.
 */
function startTopmostWatchdog() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(true, 'screen-saver');
  }, 8000);
}

/* ------------------------------------------------------------------ */
/* Bandeja                                                             */
/* ------------------------------------------------------------------ */

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Mostrar / esconder', click: toggleWindow },
    {
      label: 'Trazer para a frente',
      click: () => {
        if (!win) return;
        win.setAlwaysOnTop(true, 'screen-saver');
        win.show();
        win.moveTop();
        win.focus();
      },
    },
      {
        label: 'Modo clique-através',
        type: 'checkbox',
        checked: clickThrough,
        click: (item) => setClickThrough(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Abrir no navegador',
        click: () => shell.openExternal(SERVER_URL),
      },
      {
        label: 'Reiniciar servidor (WSL)',
        click: async () => {
          serverChild = null;
          startServerInWsl();
          await delay(3000);
          if (win) win.loadURL(SERVER_URL);
        },
      },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray.png');
    const image = nativeImage.createFromPath(iconPath);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip('Nino — assistente flutuante');
    refreshTrayMenu();
    tray.on('click', toggleWindow);
  } catch (err) {
    console.error('[shell] bandeja indisponível:', err.message);
  }
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
  }
}

function setClickThrough(enabled) {
  clickThrough = enabled;
  if (win) win.setIgnoreMouseEvents(enabled, { forward: true });
  return clickThrough;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('win:resize', (_e, { width, height }) => {
    if (!win) return { ok: false };
    win.setBounds(bottomRightBounds(width, height, true));
    return { ok: true, bounds: win.getBounds() };
  });

  ipcMain.handle('win:dragStart', () => {
    if (!win) return { ok: false };
    dragState = { startCursor: screen.getCursorScreenPoint(), startBounds: win.getBounds() };
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!win || !dragState) return;
      const cur = screen.getCursorScreenPoint();
      win.setPosition(
        Math.round(dragState.startBounds.x + (cur.x - dragState.startCursor.x)),
        Math.round(dragState.startBounds.y + (cur.y - dragState.startCursor.y))
      );
    }, 16);
    return { ok: true };
  });

  ipcMain.handle('win:dragEnd', () => {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
    dragState = null;
    return { ok: true };
  });

  ipcMain.handle('win:hide', () => {
    if (win) win.hide();
    return { ok: true };
  });

  ipcMain.handle('win:clickThrough', (_e, { enabled }) => {
    setClickThrough(!!enabled);
    refreshTrayMenu();
    return { ok: true, clickThrough };
  });

  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('app:info', () => ({
    shell: true,
    server: SERVER_URL,
    version: app.getVersion(),
  }));

  /**
   * Captura a tela para o modo visão.
   * O Electron já entrega a imagem pronta (miniatura), sem precisar de
   * permissão nem de seletor de janela — diferente do navegador.
   */
  ipcMain.handle('screen:capture', async (_e, { maxSide = 1280 } = {}) => {
    try {
      const display = screen.getPrimaryDisplay();
      const { width, height } = display.size;
      const escala = Math.min(1, maxSide / Math.max(width, height));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.max(1, Math.round(width * escala)),
          height: Math.max(1, Math.round(height * escala)),
        },
      });
      if (!sources.length) return { error: 'Nenhuma tela encontrada' };
      const dataUrl = sources[0].thumbnail.toDataURL();
      if (!dataUrl || dataUrl.length < 100) return { error: 'Captura vazia' };
      console.log(`[shell] tela capturada: ${Math.round(dataUrl.length / 1024)} KB`);
      return { dataUrl };
    } catch (err) {
      console.error('[shell] falha ao capturar a tela:', err.message);
      return { error: err.message };
    }
  });
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    createWindow();
    createTray();
    startTopmostWatchdog();

    const ok = await ensureServer();
    if (!ok) {
      console.error('[shell] servidor não respondeu; mostrando instruções');
      if (win) win.loadURL(paginaDeErro('O servidor do Nino não iniciou a tempo.'));
    } else if (win && win.webContents.getURL() !== SERVER_URL) {
      win.loadURL(SERVER_URL);
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    if (dragTimer) clearInterval(dragTimer);
  });
}
