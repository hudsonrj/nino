'use strict';

/**
 * Modo web do Nino.
 *
 * Serve a mesma interface em HTTP puro (sem Electron), para funcionar em
 * qualquer navegador — inclusive quando o ambiente não exibe janelas nativas
 * (WSLg quebrado, servidor remoto, container, etc.).
 *
 * Reaproveita exatamente os mesmos módulos do app de desktop:
 *   config, kb (RAG), ollama, tts (Piper) e stt (Whisper).
 *
 *   node src/server/web.js [--port 3081]
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('../main/config');
const ollama = require('../main/ollama');
const kb = require('../main/kb');
const tts = require('../main/tts');
const stt = require('../main/stt');
const { createChatSession } = require('../main/chat');
const { SUPPORTED_EXTENSIONS } = require('../main/ingest/extract');

const RENDERER = path.join(config.ROOT, 'src', 'renderer');
const UPLOADS = path.join(config.DATA_DIR, 'uploads');

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(process.env.NINO_PORT || argOf('--port', 3081));
const HOST = process.env.NINO_HOST || argOf('--host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* Utilidades HTTP                                                     */
/* ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Corpo da requisição grande demais'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = (await readBody(req)).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('JSON inválido');
  }
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.resolve(RENDERER, rel);
  // Nunca sai da pasta do renderer.
  if (!file.startsWith(RENDERER + path.sep) && file !== path.join(RENDERER, 'index.html')) {
    sendText(res, 403, 'proibido');
    return;
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'não encontrado');
  }
}

/* ------------------------------------------------------------------ */
/* Progresso da indexação (SSE)                                        */
/* ------------------------------------------------------------------ */

const eventClients = new Set();

function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventClients) {
    try {
      client.write(line);
    } catch {
      eventClients.delete(client);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

const session = createChatSession();
let ingesting = false;

async function handleStatus(res) {
  sendJson(res, 200, {
    ollama: await ollama.ping(),
    ollamaHost: ollama.HOST,
    autoThreads: config.autoThreads(),
    voices: tts.listVoices(),
    settings: config.loadSettings(),
    kb: kb.stats(),
    dataDir: config.DATA_DIR,
    mode: 'web',
  });
}

async function handleChat(req, res) {
  const body = await readJson(req);
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });

  let alive = true;
  req.on('close', () => {
    alive = false;
    session.abort();
  });

  const send = (obj) => {
    if (alive) {
      try {
        res.write(`${JSON.stringify(obj)}\n`);
      } catch {
        /* cliente foi embora */
      }
    }
  };

  let sources = [];
  await session.ask(body.text, {
    onSources: (s) => {
      sources = s;
      send({ type: 'sources', sources: s });
    },
    onToken: (token, full) => send({ type: 'token', token, full }),
    onDone: (result) =>
      send({
        type: 'done',
        text: result.text,
        stats: result.stats,
        sources: result.sources || sources,
      }),
    onError: (error, meta) => send({ type: 'error', error, ...(meta || {}) }),
    onAborted: () => send({ type: 'aborted' }),
  });
  res.end();
}

async function handleUpload(req, res, url) {
  const rawName = url.searchParams.get('name') || `arquivo-${Date.now()}`;
  const name = path.basename(rawName).replace(/[/\\]/g, '_');
  const data = await readBody(req);
  if (!data.length) {
    sendJson(res, 400, { ok: false, error: 'Arquivo vazio' });
    return;
  }

  fs.mkdirSync(UPLOADS, { recursive: true });
  const file = path.join(UPLOADS, name);
  await fsp.writeFile(file, data);

  if (ingesting) {
    sendJson(res, 409, { ok: false, error: 'Já existe uma importação em andamento' });
    return;
  }
  ingesting = true;
  broadcast('kb-progress', { stage: 'iniciando', file: name, done: 0, total: 1 });
  try {
    const report = await kb.addPaths([file], (p) => broadcast('kb-progress', p));
    broadcast('kb-progress', { stage: 'fim', file: name, done: 1, total: 1 });
    broadcast('kb-changed', { stats: kb.stats() });
    sendJson(res, 200, { ok: true, report, stats: kb.stats() });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  } finally {
    ingesting = false;
  }
}

async function handleStt(req, res, url) {
  const ext = (url.searchParams.get('ext') || 'webm').replace(/[^a-z0-9]/gi, '');
  const data = await readBody(req);
  if (!data.length) {
    sendJson(res, 400, { ok: false, error: 'Áudio vazio' });
    return;
  }
  fs.mkdirSync(config.AUDIO_DIR, { recursive: true });
  const file = path.join(config.AUDIO_DIR, `voz-web-${Date.now()}.${ext}`);
  await fsp.writeFile(file, data);
  const result = await stt.transcribe(file);
  sendJson(res, 200, {
    ok: true,
    text: (result.text || '').trim(),
    duration: result.duration,
    language: result.language,
  });
}

/**
 * Visão: recebe uma imagem (câmera ou tela) e devolve a análise em streaming.
 * A imagem fica só na memória e nunca é gravada em disco.
 */
async function handleVision(req, res) {
  const body = await readJson(req);
  const settings = config.loadSettings();

  if (!settings.visionEnabled) {
    sendJson(res, 403, { ok: false, error: 'A visão está desligada nos ajustes.' });
    return;
  }

  // Aceita tanto base64 puro quanto data URL.
  const image = String(body.image || '').replace(/^data:image\/[a-zA-Z+]+;base64,/, '');
  if (!image) {
    sendJson(res, 400, { ok: false, error: 'Imagem ausente' });
    return;
  }
  // Sanidade: ~20 MB de base64 é imagem demais.
  if (image.length > 20 * 1024 * 1024) {
    sendJson(res, 413, { ok: false, error: 'Imagem grande demais' });
    return;
  }

  const modo = body.mode === 'screen' ? 'screen' : 'camera';
  const systemPrompt = modo === 'camera' ? settings.cameraPrompt : settings.screenPrompt;
  const pergunta =
    String(body.question || '').trim() ||
    (modo === 'camera'
      ? 'O que você está vendo? Como eu pareço estar me sentindo e o que há ao redor?'
      : 'Explique o que está acontecendo nesta tela e o que eu estou fazendo.');

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });

  let alive = true;
  req.on('close', () => {
    alive = false;
    session.abort();
  });

  const send = (obj) => {
    if (!alive) return;
    try {
      res.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* cliente foi embora */
    }
  };

  send({ type: 'vision-start', mode: modo });

  await session.ask(
    pergunta,
    {
      onToken: (token, full) => send({ type: 'token', token, full }),
      onDone: (result) => send({ type: 'done', text: result.text, stats: result.stats, sources: [] }),
      onError: (error) => send({ type: 'error', error }),
      onAborted: () => send({ type: 'aborted' }),
    },
    { image, systemPrompt, numPredict: settings.maxTokens || 400 }
  );

  res.end();
}

async function handleTts(req, res) {
  const body = await readJson(req);
  const wav = await tts.synthesize(body.text, {
    voice: body.voice,
    lengthScale: body.lengthScale,
  });
  if (!wav) {
    sendJson(res, 400, { ok: false, error: 'Nada para falar' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': wav.length,
    'Cache-Control': 'no-store',
  });
  res.end(wav);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  if (p.startsWith('/api/')) {
    try {
      if (p === '/api/status' && method === 'GET') return await handleStatus(res);
      if (p === '/api/models' && method === 'GET') {
        try {
          return sendJson(res, 200, { models: await ollama.listModels() });
        } catch (err) {
          return sendJson(res, 200, { models: [], error: err.message });
        }
      }
      if (p === '/api/settings' && method === 'GET') {
        return sendJson(res, 200, config.loadSettings());
      }
      if (p === '/api/settings' && method === 'POST') {
        const { patch } = await readJson(req);
        const before = config.loadSettings();
        const after = config.saveSettings(patch || {});
        let warning;
        if (patch && patch.embedModel && patch.embedModel !== before.embedModel) {
          const stats = kb.stats();
          if (stats.chunks > 0) {
            warning =
              `A base está indexada com "${stats.embedModel}". ` +
              'Trocar o modelo exige limpar e reindexar a base.';
          }
        }
        return sendJson(res, 200, { settings: after, warning });
      }
      if (p === '/api/kb' && method === 'GET') {
        return sendJson(res, 200, { documents: kb.listDocuments(), stats: kb.stats() });
      }
      if (p === '/api/kb/upload' && method === 'POST') return await handleUpload(req, res, url);
      if (p === '/api/kb/remove' && method === 'POST') {
        const { id } = await readJson(req);
        const ok = await kb.removeDocument(id);
        broadcast('kb-changed', { stats: kb.stats() });
        return sendJson(res, 200, { ok, stats: kb.stats() });
      }
      if (p === '/api/kb/clear' && method === 'POST') {
        await kb.clear();
        broadcast('kb-changed', { stats: kb.stats() });
        return sendJson(res, 200, { ok: true, stats: kb.stats() });
      }
      if (p === '/api/chat' && method === 'POST') return await handleChat(req, res);
      if (p === '/api/chat/reset' && method === 'POST') {
        session.reset();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/chat/abort' && method === 'POST') {
        session.abort();
        tts.stop();
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/tts' && method === 'POST') return await handleTts(req, res);
      if (p === '/api/vision' && method === 'POST') return await handleVision(req, res);
      if (p === '/api/stt' && method === 'POST') return await handleStt(req, res, url);
      if (p === '/api/events' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write('event: hello\ndata: {}\n\n');
        eventClients.add(res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* ignora */
          }
        }, 20000);
        req.on('close', () => {
          clearInterval(ping);
          eventClients.delete(res);
        });
        return undefined;
      }
      if (p === '/api/quit' && method === 'POST') {
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return undefined;
      }
      return sendJson(res, 404, { ok: false, error: `Rota desconhecida: ${method} ${p}` });
    } catch (err) {
      console.error(`[web] erro em ${method} ${p}:`, err.message);
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (method !== 'GET') return sendText(res, 405, 'método não permitido');
  return serveStatic(res, p);
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

/**
 * Carrega o modelo de conversa na memória. Sem isso a primeira pergunta
 * espera mais de um minuto só para o modelo subir.
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
    console.log(`  modelo pré-carregado: ${settings.model}\n`);
  } catch (err) {
    console.error('[web] pré-carga falhou:', err.message);
  }
}

/**
 * Carrega o projetor visual do modelo. A primeira imagem custa ~100 s só para
 * carregar; fazendo isso em segundo plano, a primeira foto do usuário já é
 * rápida. Usa uma imagem 1x1 para não gastar processamento à toa.
 */
const IMAGEM_MINIMA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function warmVisionModel() {
  const settings = config.loadSettings();
  if (!settings.visionEnabled) return;
  const threads = settings.numThread > 0 ? settings.numThread : config.autoThreads();
  try {
    if (!(await ollama.ping())) return;
    console.log('  carregando o modo visão em segundo plano (leva ~1 min)…');
    await ollama.chatStream({
      model: settings.visionModel || settings.model,
      messages: [
        {
          role: 'user',
          content: 'ok',
          images: [IMAGEM_MINIMA],
        },
      ],
      options: { num_predict: 1, num_thread: threads },
    });
    console.log('  modo visão pronto.\n');
  } catch (err) {
    console.error('[web] pré-carga da visão falhou:', err.message);
  }
}

function localAddresses() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function start() {
  config.ensureDirs();
  kb.load();

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error('[web] falha não tratada:', err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    });
  });

  server.listen(PORT, HOST, () => {
    const stats = kb.stats();
    console.log('');
    console.log('  🐣  Nino — modo web');
    console.log(`      http://${HOST}:${PORT}`);
    for (const ip of localAddresses()) console.log(`      http://${ip}:${PORT}`);
    console.log('');
    console.log(`      base: ${stats.documents} documento(s), ${stats.chunks} trecho(s)`);
    console.log(`      fala: ${tts.listVoices().length} voz(es) disponível(is)`);
    console.log(`      arquivos: ${SUPPORTED_EXTENSIONS.slice(0, 8).join(', ')}…`);
    console.log('');
    console.log('  Abra no Chrome ou Edge e clique em "Flutuar" para deixar o');
    console.log('  mascote numa janela sempre no topo. Ctrl+C encerra.');
    console.log('');

    // Pré-carga em segundo plano, depois que o servidor já responde.
    setTimeout(warmChatModel, 1200);
    setTimeout(warmVisionModel, 45000);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Porta ${PORT} já está em uso. Use: node src/server/web.js --port 3090\n`);
    } else {
      console.error('[web] erro no servidor:', err.message);
    }
    process.exit(1);
  });

  const shutdown = () => {
    console.log('\n  encerrando…');
    session.abort();
    tts.stop();
    stt.stopWhisper();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) start();

module.exports = { start };
