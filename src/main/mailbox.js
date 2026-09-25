'use strict';

/**
 * Frente única para e-mail e agenda — decide qual caminho usar.
 *
 * Existem duas formas de falar com o Google, e as duas são suportadas:
 *
 *   OAuth        API do Gmail + API do Google Agenda. Precisa de um projeto
 *                no Google Cloud e de autorização pelo navegador. É o caminho
 *                oficial, e o único que permitirá escrever na agenda depois.
 *
 *   senha de app IMAP/SMTP + endereço secreto do iCal. Funciona em cinco
 *                minutos, sem projeto nenhum no Google Cloud.
 *
 * O resto do Nino (triagem, resumo, rascunho, envio) chama só o que está
 * aqui e não precisa saber qual dos dois está ativo. OAuth tem prioridade
 * quando os dois estão configurados.
 */

const credentials = require('./credentials');
const google = require('./google');
const imap = require('./imap');
const gmail = require('./gmail');
const gcalendar = require('./gcalendar');

/** Qual caminho de e-mail está ativo: 'oauth', 'imap' ou null. */
function caminhoDeEmail() {
  const g = credentials.google();
  if (g.refreshToken && g.clientId) return 'oauth';
  if (g.email && g.appPassword) return 'imap';
  return null;
}

/** Qual caminho de agenda está ativo: 'oauth', 'ical' ou null. */
function caminhoDeAgenda() {
  const g = credentials.google();
  if (g.refreshToken && g.clientId) return 'oauth';
  if (g.icalUrl) return 'ical';
  return null;
}

const SEM_EMAIL =
  'Nenhuma conta de e-mail configurada. Conecte com o Google ou informe ' +
  'e-mail e senha de app no painel do Nino.';

function mostrarCaminho(caminho) {
  return caminho === 'oauth' ? 'API do Google (OAuth)' : 'IMAP e SMTP (senha de app)';
}

/* ------------------------------------------------------------------ */
/* E-mail                                                              */
/* ------------------------------------------------------------------ */

async function ping() {
  const caminho = caminhoDeEmail();
  if (!caminho) return { ok: false, erro: SEM_EMAIL, codigo: 'SEM_CONTA' };
  const r = caminho === 'oauth' ? await gmail.perfil() : await imap.ping();
  return { ...r, caminho };
}

async function listar(opcoes = {}) {
  const caminho = caminhoDeEmail();
  if (!caminho) return { ok: false, erro: SEM_EMAIL, codigo: 'SEM_CONTA' };
  const r = caminho === 'oauth' ? await gmail.listar(opcoes) : await imap.listar(opcoes);
  return { ...r, caminho };
}

const ler = (uid, pasta) =>
  caminhoDeEmail() === 'oauth' ? gmail.ler(uid) : imap.ler(uid, pasta);

async function enviar(dados) {
  const caminho = caminhoDeEmail();
  if (!caminho) return { ok: false, erro: SEM_EMAIL, codigo: 'SEM_CONTA' };
  return caminho === 'oauth' ? gmail.enviar(dados) : imap.enviar(dados);
}

/** Pastas só existem no IMAP; a API do Gmail trabalha com rótulos. */
async function pastas() {
  const caminho = caminhoDeEmail();
  if (caminho === 'oauth') {
    return { ok: true, pastas: ['INBOX'], observacao: 'A API do Gmail usa rótulos, não pastas.' };
  }
  if (caminho === 'imap') return imap.pastas();
  return { ok: false, erro: SEM_EMAIL, codigo: 'SEM_CONTA' };
}

/* ------------------------------------------------------------------ */
/* Agenda                                                              */
/* ------------------------------------------------------------------ */

async function eventos({ dias = 7, max = 40 } = {}) {
  const caminho = caminhoDeAgenda();
  if (caminho === 'oauth') return gcalendar.buscar({ dias, max });
  if (caminho === 'ical') {
    const { icalUrl } = credentials.google();
    return require('./calendar').buscar({ url: icalUrl, dias, max });
  }
  return {
    ok: false,
    erro:
      'Agenda não configurada. Conecte com o Google ou cole o endereço ' +
      'secreto do iCal no painel do Nino.',
    codigo: 'SEM_AGENDA',
  };
}

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

function configurado() {
  const caminhoEmail = caminhoDeEmail();
  const caminhoAgenda = caminhoDeAgenda();
  return {
    caminhoEmail,
    caminhoAgenda,
    rotuloEmail: caminhoEmail ? mostrarCaminho(caminhoEmail) : '',
    rotuloAgenda:
      caminhoAgenda === 'oauth'
        ? 'API do Google Agenda'
        : caminhoAgenda === 'ical'
          ? 'endereço secreto do iCal'
          : '',
    email: credentials.google().email || '',
    pronto: Boolean(caminhoEmail),
    agenda: Boolean(caminhoAgenda),
  };
}

module.exports = {
  // E-mail
  ping,
  pastas,
  listar,
  ler,
  enviar,
  // Agenda
  eventos,
  // Estado
  configurado,
  caminhoDeEmail,
  caminhoDeAgenda,
  mostrarCaminho,
  // Reexportações úteis para os testes
  google,
  gmail,
  imap,
  gcalendar,
};
