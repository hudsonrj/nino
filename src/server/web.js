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
const credentials = require('../main/credentials');
const jev = require('../main/jev');
const mailbox = require('../main/mailbox');
const google = require('../main/google');
const agenda = require('../main/agenda');

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

/* ------------------------------------------------------------------ */
/* JEV, e-mail e agenda                                                */
/* ------------------------------------------------------------------ */

/** Última triagem, para o painel poder responder perguntas sobre ela. */
let ultimaTriagem = null;

function opcoesDaAgenda(corpo, settings) {
  return {
    dias: Number(corpo.dias) || settings.agendaDias,
    limiteMensagens: Number(corpo.limiteMensagens) || settings.agendaMensagens,
    somenteNaoLidos:
      corpo.somenteNaoLidos === undefined
        ? settings.agendaSomenteNaoLidos
        : Boolean(corpo.somenteNaoLidos),
    incluirCorpo:
      corpo.incluirCorpo === undefined
        ? settings.agendaIncluirCorpo
        : Boolean(corpo.incluirCorpo),
    confiancaMinima: settings.jevConfiancaMinima,
  };
}

/** Estado das credenciais. Nunca devolve o valor dos segredos. */
async function handleCredenciaisGet(res) {
  const st = credentials.status();
  const jevStatus = st.typesafe.configurado ? await jev.disponivel() : { ok: false, motivo: 'sem_chave' };
  sendJson(res, 200, {
    ok: true,
    credenciais: st,
    jev: jevStatus,
    modeloJev: config.loadSettings().jevModel,
    estatisticas: jev.estatisticas(),
  });
}

/**
 * Grava credenciais. Depois de gravar, já testa a conexão e devolve o
 * resultado — assim o usuário sabe na hora se colou a senha certa, em vez
 * de descobrir só quando a triagem falhar.
 */
async function handleCredenciaisPost(req, res) {
  const { patch } = await readJson(req);
  credentials.gravar(patch || {});
  const st = credentials.status();

  const resultado = { ok: true, credenciais: st };
  if (st.typesafe.configurado) {
    resultado.jev = await jev.disponivel();
  }
  // Só testa o que está realmente configurado — e pelo caminho que está
  // ativo (OAuth tem prioridade sobre senha de app).
  if (mailbox.caminhoDeEmail()) {
    resultado.email = await mailbox.ping();
  }
  if (mailbox.caminhoDeAgenda()) {
    const r = await mailbox.eventos({ dias: 1, max: 1 });
    resultado.agenda = r.ok
      ? { ok: true, mensagem: 'Agenda lida com sucesso.' }
      : { ok: false, erro: r.erro };
  }
  resultado.estatisticas = jev.estatisticas();
  sendJson(res, 200, resultado);
}

/* ------------------------------------------------------------------ */
/* Conexão com o Google (OAuth)                                        */
/* ------------------------------------------------------------------ */

/** Estado da conexão, sem nunca devolver segredo. */
async function handleGoogleStatus(res) {
  const st = credentials.status();
  const r = {
    ok: true,
    ...google.status(),
    caminhoEmail: mailbox.caminhoDeEmail(),
    caminhoAgenda: mailbox.caminhoDeAgenda(),
    dicaCliente: st.google.clienteDica,
  };
  // Se já está conectado, confirma que a autorização ainda vale.
  if (r.conectado) {
    try {
      const p = await mailbox.ping();
      r.email = p.email || r.email;
      r.funcionando = p.ok;
      if (!p.ok) r.erro = p.erro;
    } catch (err) {
      r.funcionando = false;
      r.erro = err.message;
    }
  }
  sendJson(res, 200, r);
}

/** Salva client_id e client_secret e já começa o fluxo de autorização. */
async function handleGoogleConectar(req, res) {
  const { patch, abrir } = await readJson(req).catch(() => ({}));
  if (patch) credentials.gravar({ google: patch });

  const r = await google.iniciar({ abrir: abrir !== false });
  if (!r.ok) return sendJson(res, 200, r);
  sendJson(res, 200, {
    ok: true,
    url: r.url,
    redirecionamento: r.redirecionamento,
    jaEsperando: Boolean(r.jaEsperando),
    instrucoes:
      'Abra o endereço, autorize o acesso e volte aqui. O Nino percebe ' +
      'sozinho quando o Google responder.',
  });
}

async function handleGoogleCancelar(res) {
  google.cancelar();
  sendJson(res, 200, { ok: true });
}

async function handleGoogleDesconectar(res) {
  google.desconectar();
  sendJson(res, 200, { ok: true, ...google.status() });
}

/**
 * Diagnóstico do OAuth: descobre o que costuma dar errado ANTES de o usuário
 * perder tempo no navegador. O teste principal é se o Google aceita o
 * endereço de retorno — se não estiver cadastrado, ele responde
 * `redirect_uri_mismatch` sem nem mostrar a tela de consentimento.
 */
async function handleGoogleDiagnostico(req, res) {
  const g = credentials.google();
  const problemas = [];
  const itensOk = [];
  let descoberta = null;

  if (!g.clientId || !g.clientSecret) {
    problemas.push({
      campo: 'credenciais',
      erro: 'Faltam o client_id e o client_secret do projeto no Google Cloud.',
    });
  } else {
    itensOk.push(`Cliente OAuth informado (${credentials.mascarar(g.clientId)}).`);

    // A pergunta que importa: qual endereço de retorno ESTE projeto aceita?
    // Em vez de exigir que o usuário adivinhe, testamos os candidatos.
    descoberta = await google.descobrirRedirecionamento({ forcar: true });
    if (descoberta.ok) {
      itensOk.push(`Endereço de retorno aceito pelo Google: ${descoberta.uri}`);
    } else {
      problemas.push({
        campo: descoberta.campo,
        erro: descoberta.erro,
        ...(descoberta.comoResolver ? { comoResolver: descoberta.comoResolver } : {}),
      });
    }
  }

  if (g.refreshToken) {
    try {
      await google.token();
      itensOk.push('A autorização salva continua válida.');
    } catch (err) {
      problemas.push({ campo: 'token', erro: err.message });
    }
  }

  sendJson(res, 200, {
    ok: problemas.length === 0,
    problemas,
    itensOk,
    redirecionamento: google.redirecionamento(),
    descoberta,
    porta: google.portaEscuta(),
    escopos: google.ESCOPOS,
    avisoSeteDias:
      'Enquanto o app estiver com status "Testing" no Google Cloud, o Google ' +
      'expira a autorização em 7 dias. Para não reconectar toda semana, ' +
      'publique o app (tela de consentimento → Publicar aplicativo).',
  });
}

/** Apaga as credenciais do disco. */
async function handleCredenciaisDelete(res) {
  credentials.apagar();
  sendJson(res, 200, { ok: true, credenciais: credentials.status() });
}

/** Teste real do JEV, como o guia pede: e-mail inventado, três perguntas. */
async function handleJevTeste(res) {
  try {
    sendJson(res, 200, await jev.teste());
  } catch (err) {
    sendJson(res, 200, { ok: false, erro: err.message });
  }
}

async function handleAgendaPrevia(req, res) {
  const settings = config.loadSettings();
  const corpo = await readJson(req).catch(() => ({}));
  const opcoes = opcoesDaAgenda(corpo, settings);
  try {
    const p = await agenda.previaComCache(opcoes, Boolean(corpo.forcar));
    sendJson(res, 200, {
      ok: p.ok,
      doCache: Boolean(p.doCache),
      resumo: p.resumo,
      quantidadePerguntas: p.quantidadePerguntas,
      caracteres: p.caracteres,
      tokensAproximados: p.tokensAproximados,
      custoEstimadoUSD: p.custoEstimadoUSD,
      avisos: p.avisos,
      eventos: p.planos,
      mensagens: p.dados.mensagens.map((m) => ({
        uid: m.uid,
        de: m.de,
        assunto: m.assunto,
        data: m.data,
        naoLido: m.naoLido,
        temCorpo: Boolean(m.trecho),
        caracteresCorpo: (m.trecho || '').length,
      })),
    });
  } catch (err) {
    sendJson(res, 200, { ok: false, erro: err.message, avisos: [] });
  }
}

async function handleAgendaTriar(req, res) {
  const settings = config.loadSettings();
  if (!settings.jevEnabled) {
    sendJson(res, 200, {
      ok: false,
      erro: 'O JEV está desligado. Ligue-o no painel para triar com ele.',
    });
    return;
  }
  const corpo = await readJson(req).catch(() => ({}));
  if (corpo.aprovado !== true) {
    // Trava de segurança: a triagem manda o conteúdo do usuário para a
    // nuvem, então exige uma aprovação explícita da prévia.
    sendJson(res, 200, {
      ok: false,
      erro: 'É preciso aprovar a prévia antes de enviar qualquer coisa ao JEV.',
      precisaAprovacao: true,
    });
    return;
  }
  try {
    const t = await agenda.triar(opcoesDaAgenda(corpo, settings));
    if (t.ok) ultimaTriagem = t;
    sendJson(res, 200, t);
  } catch (err) {
    sendJson(res, 200, { ok: false, erro: err.message });
  }
}

/** Só a agenda, sem e-mail e sem JEV. */
async function handleAgendaEventos(res) {
  const settings = config.loadSettings();
  const r = await mailbox.eventos({ dias: settings.agendaDias, max: 40 });
  sendJson(res, 200, r);
}

/**
 * Resumo do dia falado: o JEV classifica e o modelo local escreve. Reusa o
 * mesmo fluxo de tokens do chat, então a interface não precisa de caso
 * especial para falar e legendar.
 */
async function handleAgendaResumo(req, res) {
  const settings = config.loadSettings();
  if (!settings.jevEnabled) {
    sendJson(res, 200, {
      ok: false,
      erro: 'O JEV está desligado. Ligue-o no painel.',
    });
    return;
  }

  const corpo = await readJson(req).catch(() => ({}));
  let t;
  try {
    t = await agenda.triar(opcoesDaAgenda(corpo, settings));
  } catch (err) {
    sendJson(res, 200, { ok: false, erro: err.message });
    return;
  }
  if (!t.ok) {
    sendJson(res, 200, t);
    return;
  }
  ultimaTriagem = t;

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
      /* cliente saiu */
    }
  };

  // A triagem vem antes do primeiro token: a interface mostra o progresso.
  send({ type: 'triagem', ms: t.ms, custoUSD: t.custoUSD, contagens: {
    hoje: t.filaDoDia.length, semana: t.daSemana.length, incerto: t.revisar.length, ruido: t.ruido.length,
  } });

  await session.ask(
    `Fatos do meu dia, já classificados:\n\n${t.resumo}\n\n` +
      'Faça o resumo do meu dia para eu ouvir agora.',
    {
      onToken: (token, full) => send({ type: 'token', token, full }),
      onDone: (r) => send({ type: 'done', text: r.text, stats: r.stats, triagem: t }),
      onError: (error, meta) => send({ type: 'error', error, ...(meta || {}) }),
      onAborted: () => send({ type: 'aborted' }),
    },
    { systemPrompt: settings.agendaPrompt, semBase: true }
  );
  res.end();
}

/** Localiza uma mensagem da última triagem pelo uid. */
function mensagemDaTriagem(uid) {
  if (!ultimaTriagem) return null;
  return ultimaTriagem.mensagens.find((m) => String(m.uid) === String(uid)) || null;
}

/**
 * Rascunho de resposta escrito pelo modelo local. O JEV decide; quem escreve
 * é o modelo da casa — e o texto só é enviado depois de o usuário aprovar.
 */
async function handleAgendaRascunho(req, res) {
  const settings = config.loadSettings();
  const corpo = await readJson(req);
  const alvo = mensagemDaTriagem(corpo.uid);
  if (!alvo) {
    sendJson(res, 200, {
      ok: false,
      erro: 'Mensagem não encontrada. Rode a triagem de novo.',
    });
    return;
  }

  // O rascunho precisa do texto completo, não do trecho usado na triagem.
  let corpoMensagem = alvo.trecho || '';
  if (!corpoMensagem || corpo.textoCompleto) {
    const r = await mailbox.ler(alvo.uid);
    if (r.ok && r.mensagem) corpoMensagem = r.mensagem.texto;
  }

  const instrucoes = String(corpo.instrucoes || '').trim();
  const pedido =
    `Escreva a resposta deste e-mail, em português do Brasil.\n\n` +
    `De: ${alvo.de} <${alvo.enderecoDe}>\n` +
    `Assunto: ${alvo.assunto}\n\n` +
    `Mensagem recebida:\n${corpoMensagem.slice(0, 6000)}\n\n` +
    (instrucoes ? `Orientação minha para você: ${instrucoes}\n\n` : '') +
    'Escreva apenas o corpo da resposta, pronto para enviar. Sem cabeçalho, ' +
    'sem assunto, sem markdown, sem aspas em volta. Tom profissional e cordial, ' +
    'direto ao ponto, no máximo 8 linhas. Assine como Hudson.';

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
      /* cliente saiu */
    }
  };

  await session.ask(
    pedido,
    {
      onToken: (token, full) => send({ type: 'token', token, full }),
      onDone: (r) => send({ type: 'done', text: r.text, stats: r.stats, alvo: resumoDoAlvo(alvo) }),
      onError: (error, meta) => send({ type: 'error', error, ...(meta || {}) }),
      onAborted: () => send({ type: 'aborted' }),
    },
    { systemPrompt: settings.systemPrompt, semBase: true }
  );
  res.end();
}

function resumoDoAlvo(m) {
  return {
    uid: m.uid,
    de: m.de,
    enderecoDe: m.enderecoDe,
    assunto: m.assunto,
    messageId: m.messageId,
    referencias: m.referencias,
  };
}

/**
 * Envio de resposta. Exige `confirmado: true` no corpo — trava deliberada,
 * para que nenhum caminho acidental mande e-mail em nome do usuário.
 */
async function handleAgendaEnviar(req, res) {
  const corpo = await readJson(req);
  if (corpo.confirmado !== true) {
    sendJson(res, 200, {
      ok: false,
      erro: 'Envio não confirmado. Revise o texto e confirme explicitamente.',
    });
    return;
  }
  const alvo = mensagemDaTriagem(corpo.uid) || {};
  const para = corpo.para || alvo.enderecoDe;
  const assunto = corpo.assunto || responderAssunto(alvo.assunto);
  const texto = String(corpo.texto || '').trim();
  if (!para || !texto) {
    sendJson(res, 200, { ok: false, erro: 'Faltam destinatário ou texto.' });
    return;
  }
  const r = await mailbox.enviar({
    para,
    assunto,
    texto,
    respostaA: corpo.respostaA || alvo.messageId,
    referencias: corpo.referencias || alvo.referencias,
  });
  if (r.ok) agenda.limparCache();
  sendJson(res, 200, r);
}

/** "Re: " sem duplicar se já houver. */
function responderAssunto(assunto) {
  const a = String(assunto || '(sem assunto)').trim();
  return /^re:/i.test(a) ? a : `Re: ${a}`;
}

/**
 * Pergunta sobre o dia, feita no chat.
 *
 * Importante: isto NÃO manda nada novo para a nuvem. Responde apenas com a
 * última triagem que o usuário já aprovou. Se ainda não houver uma, diz como
 * obter — em vez de enviar e-mail para fora sem avisar.
 */
async function handleAgendaPerguntar(req, res) {
  const settings = config.loadSettings();
  const corpo = await readJson(req);
  const pergunta = String(corpo.pergunta || '').trim();

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
      /* cliente saiu */
    }
  };

  /** Resposta curta escrita pelo código: sem modelo, sem chance de inventar. */
  const responderDireto = (texto) => {
    send({ type: 'token', token: texto, full: texto });
    send({ type: 'done', text: texto, stats: {} });
    res.end();
  };

  const conta = (credentials.google().email || '').trim();
  const caminho = mailbox.caminhoDeEmail();

  // Se a pergunta cita um endereço que NÃO é o conectado, respondemos o fato
  // em vez de deixar o modelo local improvisar. Foi exatamente assim que
  // apareceu uma resposta inventada sobre "reuniões da fábrica".
  const citado = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(pergunta);
  if (citado && conta && citado[0].toLowerCase() !== conta.toLowerCase()) {
    responderDireto(
      `Não. Estou conectado na conta ${conta}, não em ${citado[0]}. ` +
        `Se você quer a outra conta, desconecte e conecte de novo escolhendo ` +
        `o perfil certo na tela do Google.`
    );
    return;
  }

  if (!caminho) {
    responderDireto(
      'Ainda não tenho acesso a e-mail nem agenda. Vá em Ajustes e conecte ' +
        'com o Google, ou informe e-mail e senha de app.'
    );
    return;
  }

  if (!ultimaTriagem) {
    responderDireto(
      `Estou conectado na conta ${conta || '(desconhecida)'}, com acesso a ` +
        `e-mail e agenda pelo ${mailbox.mostrarCaminho(caminho)}. ` +
        'Mas ainda não olhei seu dia nesta sessão: abra a visão 🌤️ e clique em ' +
        '"Fazer o resumo do dia". Lá você vê e aprova o que sai da sua máquina. ' +
        'Depois eu respondo aqui no chat normalmente.'
    );
    return;
  }

  const idade = Date.now() - new Date(ultimaTriagem.quando).getTime();
  const minutos = Math.round(idade / 60000);

  await session.ask(
    `Conta conectada: ${conta || 'desconhecida'} (${mailbox.mostrarCaminho(caminho)}).\n\n` +
      `Fatos do meu dia, classificados pelo JEV${minutos > 0 ? ` há ${minutos} minuto(s)` : ''}:\n\n` +
      `${ultimaTriagem.resumo}\n\n` +
      `Minha pergunta: ${pergunta}\n\n` +
      'Responda só com base nos fatos acima. Se a resposta não estiver neles, ' +
      'diga que não sabe — não invente compromissos nem mensagens.',
    {
      onToken: (token, full) => send({ type: 'token', token, full }),
      onDone: (r) => send({ type: 'done', text: r.text, stats: r.stats }),
      onError: (error, meta) => send({ type: 'error', error, ...(meta || {}) }),
      onAborted: () => send({ type: 'aborted' }),
    },
    { systemPrompt: settings.agendaPrompt, semBase: true }
  );
  res.end();
}

/** Fatos do último dia triado, para a interface montar a tela. */
async function handleAgendaUltima(res) {
  if (!ultimaTriagem) {
    sendJson(res, 200, { ok: false, erro: 'Nenhuma triagem feita ainda.' });
    return;
  }
  sendJson(res, 200, { ok: true, triagem: ultimaTriagem });
}

/** Informações de fuso e limites, para a tela de ajustes. */
async function handleAgendaInfo(res) {
  const settings = config.loadSettings();
  const caminhoEmail = mailbox.caminhoDeEmail();
  const caminhoAgenda = mailbox.caminhoDeAgenda();

  // Quem decide o que falta é o servidor, que conhece os DOIS caminhos
  // (OAuth e senha de app). A interface só mostra o resultado — antes ela
  // repetia a regra e acusava falta de configuração com o OAuth funcionando.
  const pendencias = [];
  if (!caminhoEmail) {
    pendencias.push({
      campo: 'email',
      mensagem: 'O e-mail não está conectado.',
      comoResolver:
        'Conecte com o Google, ou informe seu e-mail do Gmail e uma senha de app.',
    });
  }
  if (!caminhoAgenda) {
    pendencias.push({
      campo: 'agenda',
      mensagem: 'A agenda não está conectada.',
      comoResolver:
        'Conecte com o Google, ou cole o endereço secreto do iCal da sua agenda.',
    });
  }
  if (!settings.jevEnabled) {
    pendencias.push({
      campo: 'jev',
      mensagem: 'O JEV está desligado, então eu não classifico nada.',
      comoResolver: 'Ligue a chave "Usar o JEV para triar meu e-mail e minha agenda".',
    });
  } else if (!credentials.chaveTypesafe()) {
    pendencias.push({
      campo: 'chave',
      mensagem: 'Falta a chave da TypeSafe (o JEV).',
      comoResolver: 'Crie uma em console.typesafe.ai/keys e cole em Ajustes.',
    });
  }

  sendJson(res, 200, {
    ok: true,
    pronto: pendencias.length === 0,
    pendencias,
    caminhoEmail,
    caminhoAgenda,
    rotuloEmail: caminhoEmail ? mailbox.mostrarCaminho(caminhoEmail) : '',
    rotuloAgenda:
      caminhoAgenda === 'oauth' ? 'API do Google Agenda' : caminhoAgenda === 'ical' ? 'endereço secreto do iCal' : '',
    credenciais: credentials.status(),
    fuso: process.env.NINO_FUSO || 'America/Sao_Paulo',
    estatisticas: jev.estatisticas(),
    modelosJev: jev.MODELOS_CONHECIDOS,
  });
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

      // JEV, credenciais, e-mail e agenda.
      if (p === '/api/credenciais' && method === 'GET') return await handleCredenciaisGet(res);
      if (p === '/api/credenciais' && method === 'POST') return await handleCredenciaisPost(req, res);
      if (p === '/api/credenciais' && method === 'DELETE') return await handleCredenciaisDelete(res);

      // Conexão com o Google por OAuth.
      if (p === '/api/google/status' && method === 'GET') return await handleGoogleStatus(res);
      if (p === '/api/google/conectar' && method === 'POST') return await handleGoogleConectar(req, res);
      if (p === '/api/google/cancelar' && method === 'POST') return await handleGoogleCancelar(res);
      if (p === '/api/google/desconectar' && method === 'POST') return await handleGoogleDesconectar(res);
      if (p === '/api/google/diagnostico' && method === 'POST') return await handleGoogleDiagnostico(req, res);
      if (p === '/api/jev/teste' && method === 'POST') return await handleJevTeste(res);
      if (p === '/api/agenda/info' && method === 'GET') return await handleAgendaInfo(res);
      if (p === '/api/agenda/eventos' && method === 'GET') return await handleAgendaEventos(res);
      if (p === '/api/agenda/previa' && method === 'POST') return await handleAgendaPrevia(req, res);
      if (p === '/api/agenda/triar' && method === 'POST') return await handleAgendaTriar(req, res);
      if (p === '/api/agenda/resumo' && method === 'POST') return await handleAgendaResumo(req, res);
      if (p === '/api/agenda/rascunho' && method === 'POST') return await handleAgendaRascunho(req, res);
      if (p === '/api/agenda/enviar' && method === 'POST') return await handleAgendaEnviar(req, res);
      if (p === '/api/agenda/ultima' && method === 'GET') return await handleAgendaUltima(res);
      if (p === '/api/agenda/perguntar' && method === 'POST') return await handleAgendaPerguntar(req, res);
      if (p === '/api/agenda/ajustes' && method === 'POST') {
        const { patch } = await readJson(req);
        return sendJson(res, 200, { ok: true, settings: config.saveSettings(patch || {}) });
      }
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
