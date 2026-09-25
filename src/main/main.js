'use strict';

/**
 * Nino — mascote-assistente flutuante.
 * Processo principal: janela overlay, bandeja, IPC, conversa com RAG.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, dialog, shell, globalShortcut, nativeImage } = require('electron');

const config = require('./config');
const ollama = require('./ollama');
const kb = require('./kb');
const tts = require('./tts');
const stt = require('./stt');
const { createChatSession, takeSpeech } = require('./chat');
const { SUPPORTED_EXTENSIONS } = require('./ingest/extract');

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const IDLE_SIZE = { width: 220, height: 220 };
const OPEN_SIZE = { width: 440, height: 660 };
// No WSL a janela tem tamanho fixo: redimensioná-la usaria o sistema de
// coordenadas do WSLg e a jogaria para fora da tela de novo. O painel
// simplesmente aparece e some dentro dela.
const WSL_SIZE = { width: 480, height: 720 };
const MARGIN = 18;

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

let win = null;
let tray = null;
let quitting = false;
let clickThrough = false;

let ingesting = false;
let dragTimer = null;
let dragState = null;

/* ------------------------------------------------------------------ */
/* Ajustes iniciais                                                    */
/* ------------------------------------------------------------------ */

app.commandLine.appendSwitch('enable-transparent-visuals');
if (process.env.NINO_DISABLE_GPU === '1') app.disableHardwareAcceleration();

/* ------------------------------------------------------------------ */
/* Janela                                                              */
/* ------------------------------------------------------------------ */

/** Monitor onde o mascote deve viver: o do cursor (ou o da janela, se já existir). */
function targetDisplay() {
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    return screen.getDisplayNearestPoint({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) });
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function bottomRightBounds(width, height, keepCorner) {
  if (keepCorner && win) {
    const area = targetDisplay().workArea;
    const b = win.getBounds();
    let x = b.x + b.width - width;
    let y = b.y + b.height - height;
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
    return { x, y, width, height };
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return {
    x: area.x + area.width - width - MARGIN,
    y: area.y + area.height - height - MARGIN,
    width,
    height,
  };
}

function createWindow() {
  const inicial = IS_WSL ? WSL_SIZE : IDLE_SIZE;
  win = new BrowserWindow({
    ...inicial,
    ...bottomRightBounds(inicial.width, inicial.height, false),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    acceptFirstMouse: true,
    icon: path.join(config.ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* não suportado em alguns ambientes */
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    send('app:ready', { version: app.getVersion() });
    // No WSLg a janela costuma nascer fora da tela; tenta resgatá-la assim
    // que ela existe de verdade.
    setTimeout(() => {
      rescueWindow()
        .then((res) => {
          if (res.ok) console.log('[janela] reposicionada:', res.moved);
          else if (res.reason && res.reason !== 'não é WSL') {
            console.error('[janela] resgate falhou:', res.reason);
          }
        })
        .catch((err) => console.error('[janela] resgate:', err.message));
    }, 3500);
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
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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
  if (!win) return clickThrough;
  win.setIgnoreMouseEvents(enabled, { forward: true });
  return clickThrough;
}

/* ------------------------------------------------------------------ */
/* Resgate da janela no WSLg                                           */
/* ------------------------------------------------------------------ */

const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/** Estamos dentro do WSL (onde as janelas precisam de resgate)? */
const IS_WSL = fs.existsSync(WSL_POWERSHELL);

function runPowerShell(args, timeout = 45000) {
  return new Promise((resolve) => {
    execFile(WSL_POWERSHELL, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, stderr: String(stderr || '') });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

/**
 * No WSLg a janela nasce fora da área visível: o WSLg usa um sistema de
 * coordenadas próprio (reporta o monitor em y=847 quando o Windows diz y=0)
 * e as janelas acabam espalhadas ou fora da tela.
 *
 * Aqui a janela é encontrada pelo título e reposicionada pela API do Windows,
 * que é a única fonte confiável de coordenadas. Fora do WSL não faz nada.
 *
 * @returns {Promise<{ok:boolean, reason?:string, moved?:string}>}
 */
async function rescueWindow() {
  if (!fs.existsSync(WSL_POWERSHELL)) return { ok: false, reason: 'não é WSL' };

  const script = path.join(config.ROOT, 'scripts', 'win-rescue.ps1');
  if (!fs.existsSync(script)) return { ok: false, reason: 'scripts/win-rescue.ps1 ausente' };

  // Descobre a pasta temporária do Windows e o caminho equivalente no WSL.
  const temp = await runPowerShell(['-NoProfile', '-Command', 'Write-Output $env:TEMP'], 20000);
  if (!temp.ok) return { ok: false, reason: temp.error };

  const winTemp = temp.stdout.trim();
  if (!winTemp) return { ok: false, reason: 'não descobri a pasta temporária do Windows' };

  const wslTemp = path.join(
    '/mnt',
    winTemp.replace(/^([A-Za-z]):/, (_m, d) => d.toLowerCase()).replace(/\\/g, '/')
  );

  try {
    fs.mkdirSync(wslTemp, { recursive: true });
    fs.copyFileSync(script, path.join(wslTemp, 'win-rescue.ps1'));
  } catch (err) {
    return { ok: false, reason: `não consegui copiar o script: ${err.message}` };
  }

  const winPath = path.win32.join(winTemp, 'win-rescue.ps1');
  const res = await runPowerShell([
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winPath, '-Titulo', 'Nino',
  ]);

  if (res.ok) {
    const linha = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    return { ok: true, moved: linha };
  }
  return { ok: false, reason: res.error };
}

/* ------------------------------------------------------------------ */
/* Bandeja                                                             */
/* ------------------------------------------------------------------ */

function createTray() {
  try {
    const iconPath = path.join(config.ROOT, 'assets', 'tray.png');
    const image = nativeImage.createFromPath(iconPath);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    tray.setToolTip('Nino — assistente flutuante');
    refreshTrayMenu();
    tray.on('click', toggleWindow);
  } catch (err) {
    console.error('[tray] indisponível:', err.message);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  const speaking = tts.isSpeaking();
  const menu = Menu.buildFromTemplate([
    { label: 'Mostrar / esconder', click: toggleWindow },
    {
      label: 'Trazer o mascote para a tela',
      click: () => {
        rescueWindow()
          .then((res) => {
            if (win && res.ok) win.show();
          })
          .catch(() => {});
      },
    },
    { type: 'separator' },
    {
      label: 'Modo clique-através',
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => setClickThrough(item.checked),
    },
    {
      label: 'Parar de falar',
      enabled: speaking,
      click: () => tts.stop(),
    },
    { type: 'separator' },
    {
      label: 'Abrir pasta de dados',
      click: () => shell.openPath(config.DATA_DIR),
    },
    {
      label: 'Recarregar',
      click: () => win && win.reload(),
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

/* ------------------------------------------------------------------ */
/* Conversa                                                            */
/* ------------------------------------------------------------------ */

const chatSession = createChatSession();

/**
 * Conversa: a orquestração (base de conhecimento + histórico + Ollama) fica
 * em chat.js, compartilhada com o modo web. Aqui só o que é do desktop:
 * empurrar eventos para a interface e falar as frases conforme chegam.
 */
async function handleChat(text) {
  const settings = config.loadSettings();
  tts.stop();
  let speechBuf = '';

  return chatSession.ask(text, {
    onSources: (sources) => send('chat:sources', { sources }),
    onToken: (token, full) => {
      send('chat:token', { token, full });
      if (!settings.ttsEnabled) return;
      speechBuf += token;
      let slice;
      while ((slice = takeSpeech(speechBuf, false)).flush) {
        tts.speak(slice.flush);
        speechBuf = slice.rest;
      }
    },
    onDone: ({ text: full, stats, sources }) => {
      if (settings.ttsEnabled) {
        const tail = takeSpeech(speechBuf, true).flush;
        if (tail) tts.speak(tail);
      }
      send('chat:done', { text: full, sources, stats });
    },
    onError: (error, meta) => send('chat:error', { error, ...(meta || {}) }),
    onAborted: () => send('chat:aborted', {}),
  });
}

/**
 * Carrega o modelo de conversa na memória logo no início.
 * Sem isso, a primeira pergunta espera ~60 s só para o modelo subir.
 */
async function warmChatModel() {
  const settings = config.loadSettings();
  const threads = settings.numThread > 0 ? settings.numThread : config.autoThreads();
  try {
    if (!(await ollama.ping())) return;
    await ollama.chatStream({
      model: settings.model,
      messages: [{ role: 'user', content: 'oi' }],
      options: { num_predict: 1, num_thread: threads },
    });
    console.log('[chat] modelo pré-carregado:', settings.model);
    send('chat:warm', { ok: true, model: settings.model });
  } catch (err) {
    console.error('[chat] pré-carga falhou:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Ingestão                                                            */
/* ------------------------------------------------------------------ */

async function runIngest(filePaths) {
  if (ingesting) return { ok: false, error: 'Já existe uma importação em andamento' };
  ingesting = true;
  send('kb:progress', { stage: 'iniciando', file: '', done: 0, total: filePaths.length });
  try {
    const report = await kb.addPaths(filePaths, (p) => send('kb:progress', p));
    send('kb:progress', { stage: 'fim', file: '', done: filePaths.length, total: filePaths.length });
    send('kb:changed', { stats: kb.stats() });
    return { ok: true, report, stats: kb.stats() };
  } finally {
    ingesting = false;
  }
}

/* ------------------------------------------------------------------ */
/* Áudio                                                               */
/* ------------------------------------------------------------------ */

async function recordAndTranscribe() {
  try {
    send('audio:state', { state: 'listening' });
    const rec = await stt.record();

    if (rec.tooShort) {
      send('audio:state', { state: 'idle' });
      send('audio:error', { error: 'Não ouvi nada. Fale mais perto do microfone.' });
      return;
    }

    // Carrega o modelo de transcrição enquanto o usuário ainda está falando.
    send('audio:state', { state: 'transcribing' });
    const result = await stt.transcribe(rec.path);
    send('audio:state', { state: 'idle' });

    const text = (result.text || '').trim();
    if (!text) {
      send('audio:error', { error: 'Não consegui entender o áudio.' });
      return;
    }
    send('audio:transcript', { text, duration: result.duration });
  } catch (err) {
    console.error('[audio]', err.message);
    send('audio:state', { state: 'idle' });
    send('audio:error', { error: err.message });
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  /* Conversa */
  ipcMain.handle('chat:send', (_e, { text }) => handleChat(text));
  ipcMain.handle('chat:abort', () => {
    chatSession.abort();
    tts.stop();
    return { ok: true };
  });
  ipcMain.handle('chat:reset', () => {
    chatSession.reset();
    return { ok: true };
  });

  /* Voz */
  ipcMain.handle('tts:speak', (_e, { text }) => {
    tts.speak(text);
    return { ok: true };
  });
  ipcMain.handle('tts:stop', () => {
    tts.stop();
    return { ok: true };
  });
  ipcMain.handle('audio:listen', () => {
    if (stt.isRecording()) return { ok: false, error: 'Já estou ouvindo' };
    // Pré-carrega o Whisper em paralelo: quando a gravação terminar, o modelo
    // já está na memória e a transcrição começa na hora.
    stt.warmWhisper().catch((err) => console.error('[whisper] warmup:', err.message));
    recordAndTranscribe();
    return { ok: true };
  });
  ipcMain.handle('audio:stop', () => {
    stt.stopRecording();
    return { ok: true };
  });

  /* Base de conhecimento */
  ipcMain.handle('kb:add', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Escolha documentos ou livros',
      buttonLabel: 'Adicionar à base',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documentos e livros', extensions: SUPPORTED_EXTENSIONS },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    return runIngest(result.filePaths);
  });
  ipcMain.handle('kb:addPaths', (_e, { paths }) => runIngest(paths || []));
  // Arquivos arrastados e soltos sobre o mascote (tratado no preload).
  ipcMain.on('kb:dropped', (_e, { paths }) => {
    if (paths && paths.length) runIngest(paths);
  });
  ipcMain.handle('kb:list', () => ({ documents: kb.listDocuments(), stats: kb.stats() }));
  ipcMain.handle('kb:remove', async (_e, { id }) => {
    const ok = await kb.removeDocument(id);
    send('kb:changed', { stats: kb.stats() });
    return { ok, stats: kb.stats() };
  });
  ipcMain.handle('kb:clear', async () => {
    await kb.clear();
    send('kb:changed', { stats: kb.stats() });
    return { ok: true, stats: kb.stats() };
  });
  ipcMain.handle('kb:stats', () => kb.stats());
  ipcMain.handle('kb:search', async (_e, { query }) => {
    const settings = config.loadSettings();
    const hits = await kb.search(query, { topK: settings.topK, minScore: settings.minScore });
    return { hits };
  });

  /* Ajustes */
  ipcMain.handle('settings:get', () => config.loadSettings());
  ipcMain.handle('settings:set', (_e, { patch }) => {
    const before = config.loadSettings();
    const after = config.saveSettings(patch || {});
    if (patch && patch.embedModel && patch.embedModel !== before.embedModel) {
      const stats = kb.stats();
      if (stats.chunks > 0) {
        return {
          settings: after,
          warning: `A base está indexada com "${stats.embedModel}". Trocar o modelo exige limpar e reindexar a base.`,
        };
      }
    }
    return { settings: after };
  });

  /* Sistema */
  ipcMain.handle('system:status', async () => {
    const stats = kb.stats();
    return {
      ollama: await ollama.ping(),
      ollamaHost: ollama.HOST,
      autoThreads: config.autoThreads(),
      voices: tts.listVoices(),
      settings: config.loadSettings(),
      kb: stats,
      dataDir: config.DATA_DIR,
      speaking: tts.isSpeaking(),
      recording: stt.isRecording(),
    };
  });
  ipcMain.handle('system:voices', () => tts.listVoices());
  ipcMain.handle('system:models', async () => {
    try {
      return { models: await ollama.listModels() };
    } catch (err) {
      return { models: [], error: err.message };
    }
  });
  ipcMain.handle('system:openData', () => {
    shell.openPath(config.DATA_DIR);
    return { ok: true };
  });
  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
    return { ok: true };
  });

  /* Janela */
  ipcMain.handle('win:dragStart', () => {
    if (!win) return { ok: false };
    dragState = { startCursor: screen.getCursorScreenPoint(), startBounds: win.getBounds() };
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!win || !dragState) return;
      const cur = screen.getCursorScreenPoint();
      const x = dragState.startBounds.x + (cur.x - dragState.startCursor.x);
      const y = dragState.startBounds.y + (cur.y - dragState.startCursor.y);
      win.setPosition(Math.round(x), Math.round(y));
    }, 16);
    return { ok: true };
  });
  ipcMain.handle('win:dragMove', () => ({ ok: true }));
  ipcMain.handle('win:dragEnd', () => {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
    dragState = null;
    return { ok: true };
  });
  ipcMain.handle('win:resize', (_e, { width, height }) => {
    if (!win) return { ok: false };
    // No WSL, redimensionar moveria a janela com as coordenadas erradas do
    // WSLg. O tamanho fica fixo e o layout se adapta dentro dele.
    if (IS_WSL) return { ok: true, fixed: true };
    win.setBounds(bottomRightBounds(width, height, true));
    return { ok: true, bounds: win.getBounds() };
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
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    config.ensureDirs();
    kb.load();

    // No WSLg o primeiro play acorda o sink e demora; aquece em segundo plano.
    tts.warmup().catch(() => {});
    tts.onState((state) => {
      send('tts:state', state);
      refreshTrayMenu();
    });

    registerIpc();

    // Pequeno atraso ajuda o compositor a aceitar a janela transparente.
    setTimeout(() => {
      createWindow();
      createTray();
    }, 120);

    // Pré-carga do modelo de conversa, depois que a interface já subiu.
    setTimeout(() => {
      warmChatModel();
    }, 2500);

    try {
      globalShortcut.register('CommandOrControl+Alt+N', toggleWindow);
      globalShortcut.register('CommandOrControl+Alt+T', () => {
        setClickThrough(!clickThrough);
        refreshTrayMenu();
        send('app:clickThrough', { enabled: clickThrough });
      });
      globalShortcut.register('CommandOrControl+Alt+S', () => tts.stop());
    } catch (err) {
      console.error('[atalhos] não registrados:', err.message);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (win) win.show();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    chatSession.abort();
    tts.stop();
    stt.stopWhisper();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  // App vive na bandeja mesmo sem janelas.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) app.quit();
  });
}
