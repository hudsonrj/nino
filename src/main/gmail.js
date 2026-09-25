'use strict';

/**
 * E-mail pela API REST do Gmail (OAuth), no lugar de IMAP/SMTP.
 *
 * Devolve exatamente o mesmo formato que o caminho IMAP, para que o resto do
 * Nino — triagem, resumo, rascunho, envio — não precise saber qual dos dois
 * está em uso.
 *
 * Comparado ao IMAP, a API ganha em robustez (o Gmail cuida do MIME para nós)
 * e permite, no futuro, marcar lido, arquivar e rotular.
 */

const google = require('./google');

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const LIMITE_CORPO = 12000;

/* ------------------------------------------------------------------ */
/* Decodificação                                                       */
/* ------------------------------------------------------------------ */

/** O Gmail usa base64url, sem os caracteres que quebrariam uma URL. */
function deBase64Url(dados) {
  if (!dados) return '';
  const b64 = String(dados).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function paraBase64Url(texto) {
  return Buffer.from(texto, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function htmlParaTexto(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Percorre as partes MIME e devolve o texto. Prefere text/plain; só usa HTML
 * se não houver alternativa.
 */
function extrairTexto(payload) {
  if (!payload) return '';
  let html = '';

  const visitar = (parte) => {
    if (!parte) return '';
    const tipo = parte.mimeType || '';
    const disposicao = String(
      (parte.headers || []).find((h) => /^content-disposition$/i.test(h.name))?.value || ''
    );
    if (/attachment/i.test(disposicao)) return '';

    if (tipo === 'text/plain' && parte.body && parte.body.data) {
      return deBase64Url(parte.body.data);
    }
    if (tipo === 'text/html' && parte.body && parte.body.data && !html) {
      html = deBase64Url(parte.body.data);
    }
    for (const filha of parte.parts || []) {
      const achado = visitar(filha);
      if (achado) return achado;
    }
    return '';
  };

  const texto = visitar(payload);
  if (texto) return texto;
  return html ? htmlParaTexto(html) : '';
}

function cabecalho(payload, nome) {
  const h = (payload && payload.headers) || [];
  const achado = h.find((x) => String(x.name).toLowerCase() === nome.toLowerCase());
  return achado ? achado.value : '';
}

/** Separa "Fulano <fulano@x.com>" em nome e endereço. */
function separarEndereco(valor) {
  const v = String(valor || '').trim();
  const m = v.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) return { nome: m[1].replace(/^"|"$/g, '').trim(), endereco: m[2].trim() };
  return { nome: '', endereco: v };
}

/** Tira a citação da resposta anterior, como no caminho IMAP. */
function limparCitacao(texto) {
  const linhas = [];
  for (const linha of String(texto || '').split('\n')) {
    const crua = linha.trim();
    if (crua.startsWith('>')) continue;
    if (/^Em .{5,80}escreveu:/i.test(crua)) break;
    if (/^On .{5,80}wrote:/i.test(crua)) break;
    if (/^-{2,}\s*(Mensagem original|Original Message)/i.test(crua)) break;
    if (/^(De|From|Enviado|Sent):\s/i.test(crua) && linhas.length > 3) break;
    linhas.push(linha);
  }
  return linhas.join('\n').trim();
}

/* ------------------------------------------------------------------ */
/* Operações                                                           */
/* ------------------------------------------------------------------ */

async function buscar(url) {
  const token = await google.token();
  const r = await google.apiGet(url, token);
  if (r.status === 401) {
    // Token renovado no meio do caminho: tenta uma vez com um novo.
    const novo = await google.renovar();
    return google.apiGet(url, novo);
  }
  return r;
}

/** Confere a conexão e devolve o endereço da conta. */
async function perfil() {
  try {
    const r = await buscar(`${BASE}/profile`);
    if (r.status !== 200 || !r.json) {
      return { ok: false, erro: google.explicarErro(r.json, r.texto, r.status) };
    }
    return { ok: true, email: r.json.emailAddress, total: r.json.messagesTotal };
  } catch (err) {
    return {
      ok: false,
      erro: err.message === 'SEM_CONEXAO'
        ? 'Ainda não há autorização do Google. Clique em "Conectar com o Google".'
        : err.message,
    };
  }
}

/**
 * Cabeçalhos das mensagens mais recentes.
 *
 * A API devolve só os IDs na listagem, então buscamos os metadados de cada
 * uma. Fazemos isso em paralelo, em blocos, para não estourar o limite de
 * requisições simultâneas.
 */
async function listar({ limite = 20, somenteNaoLidos = false } = {}) {
  try {
    const q = somenteNaoLidos ? 'is:unread' : '';
    const url =
      `${BASE}/messages?maxResults=${Math.min(60, Math.max(1, limite))}` +
      (q ? `&q=${encodeURIComponent(q)}` : '');

    const lista = await buscar(url);
    if (lista.status !== 200 || !lista.json) {
      return { ok: false, erro: google.explicarErro(lista.json, lista.texto, lista.status) };
    }
    const ids = (lista.json.messages || []).map((m) => m.id);
    if (!ids.length) return { ok: true, pasta: 'INBOX', mensagens: [] };

    const cabecalhos = 'From,Subject,Date,Message-ID';
    const mensagens = [];
    const TAMANHO = 8;
    for (let i = 0; i < ids.length; i += TAMANHO) {
      const bloco = ids.slice(i, i + TAMANHO);
      const resultados = await Promise.all(
        bloco.map((id) =>
          buscar(
            `${BASE}/messages/${id}?format=metadata&metadataHeaders=${encodeURIComponent(cabecalhos)}`
          ).catch(() => null)
        )
      );
      for (const r of resultados) {
        if (!r || r.status !== 200 || !r.json) continue;
        const m = r.json;
        const { nome, endereco } = separarEndereco(cabecalho(m.payload, 'From'));
        mensagens.push({
          uid: m.id,
          de: endereco,
          nomeDe: nome || endereco,
          assunto: cabecalho(m.payload, 'Subject') || '(sem assunto)',
          data: cabecalho(m.payload, 'Date'),
          messageId: cabecalho(m.payload, 'Message-ID'),
          threadId: m.threadId,
          naoLido: (m.labelIds || []).includes('UNREAD'),
        });
      }
    }
    return { ok: true, pasta: 'INBOX', mensagens };
  } catch (err) {
    return {
      ok: false,
      erro: err.message === 'SEM_CONEXAO'
        ? 'Ainda não há autorização do Google. Clique em "Conectar com o Google".'
        : err.message,
    };
  }
}

/** Corpo de uma mensagem, já sem a citação da resposta anterior. */
async function ler(uid) {
  try {
    const r = await buscar(`${BASE}/messages/${uid}?format=full`);
    if (r.status !== 200 || !r.json) {
      return { ok: false, erro: google.explicarErro(r.json, r.texto, r.status) };
    }
    const m = r.json;
    const payload = m.payload || {};
    const { nome, endereco } = separarEndereco(cabecalho(payload, 'From'));

    const anexos = [];
    const procurarAnexos = (parte) => {
      if (!parte) return;
      const disposicao = String(
        (parte.headers || []).find((h) => /^content-disposition$/i.test(h.name))?.value || ''
      );
      const nomeArquivo = (parte.headers || []).find((h) =>
        /^content-disposition$/i.test(h.name)
      );
      if (/attachment/i.test(disposicao)) {
        const achado = nomeArquivo && /filename="([^"]+)"/.exec(nomeArquivo.value);
        anexos.push(achado ? achado[1] : 'anexo');
      }
      for (const filha of parte.parts || []) procurarAnexos(filha);
    };
    procurarAnexos(payload);

    return {
      ok: true,
      mensagem: {
        uid: m.id,
        threadId: m.threadId,
        de: endereco,
        nomeDe: nome || endereco,
        para: cabecalho(payload, 'To'),
        assunto: cabecalho(payload, 'Subject') || '(sem assunto)',
        data: cabecalho(payload, 'Date'),
        messageId: cabecalho(payload, 'Message-ID'),
        referencias: cabecalho(payload, 'References'),
        texto: limparCitacao(extrairTexto(payload)).slice(0, LIMITE_CORPO),
        anexos,
      },
    };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

/** Monta a mensagem no formato RFC 2822 que a API espera. */
function montarRfc822({ de, para, assunto, texto, respostaA, referencias }) {
  const cabecalhos = [
    `From: ${de}`,
    `To: ${para}`,
    `Subject: ${assunto}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  // Amarrar na conversa original faz a resposta aparecer encadeada.
  if (respostaA) cabecalhos.push(`In-Reply-To: ${respostaA}`);
  if (referencias) cabecalhos.push(`References: ${referencias}`);
  else if (respostaA) cabecalhos.push(`References: ${respostaA}`);

  // O corpo em base64 evita qualquer problema de acentuação no caminho.
  const corpo = Buffer.from(String(texto), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${cabecalhos.join('\r\n')}\r\n\r\n${corpo}`;
}

/** Envia uma resposta. Só é chamado depois da aprovação do usuário. */
async function enviar({ para, assunto, texto, respostaA, referencias, threadId }) {
  try {
    const conta = (await perfil()).email || 'me';
    const raw = montarRfc822({
      de: conta,
      para,
      assunto,
      texto,
      respostaA,
      referencias,
    });
    const corpo = { raw: paraBase64Url(raw) };
    if (threadId) corpo.threadId = threadId;

    const token = await google.token();
    const r = await google.apiPost(`${BASE}/messages/send`, token, corpo);
    if (r.status !== 200 || !r.json) {
      return { ok: false, erro: google.explicarErro(r.json, r.texto, r.status) };
    }
    return { ok: true, messageId: r.json.id, threadId: r.json.threadId, para };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}

module.exports = {
  perfil,
  listar,
  ler,
  enviar,
  extrairTexto,
  limparCitacao,
  montarRfc822,
  deBase64Url,
  paraBase64Url,
};
