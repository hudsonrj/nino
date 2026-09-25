'use strict';

/**
 * Cofre de credenciais do Nino.
 *
 * Fica FORA do repositório (~/.config/nino), com permissão 600, justamente
 * para que nunca seja commitado nem enviado a lugar nenhum. A chave da
 * TypeSafe e a senha de app do Google só existem aqui.
 *
 * Regra de ouro deste módulo: `status()` devolve apenas SIM/NÃO. O valor
 * secreto nunca sai daqui para a interface, para log ou para o chat.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR =
  process.env.NINO_CONFIG_DIR || path.join(os.homedir(), '.config', 'nino');
const FILE = path.join(CONFIG_DIR, 'credenciais.json');

const VAZIO = {
  typesafe: { apiKey: '' },
  google: {
    // Caminho simples: senha de app (IMAP/SMTP) + endereço secreto do iCal.
    email: '',
    appPassword: '',
    icalUrl: '',
    // Caminho OAuth: credenciais do projeto no Google Cloud e os tokens.
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    accessToken: '',
    accessTokenExpira: '',
    escopos: '',
  },
};

function garantirDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

/** Lê o cofre do disco. Nunca lança: cofre ausente é cofre vazio. */
function ler() {
  try {
    const bruto = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      typesafe: { ...VAZIO.typesafe, ...(bruto.typesafe || {}) },
      google: { ...VAZIO.google, ...(bruto.google || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(VAZIO));
  }
}

/**
 * Grava um trecho do cofre. Campo com string vazia APAGA o valor; campo
 * ausente permanece como estava — assim dá para trocar a senha sem tocar
 * na chave da TypeSafe.
 */
function gravar(patch) {
  garantirDir();
  const atual = ler();
  for (const servico of Object.keys(VAZIO)) {
    if (!patch || !patch[servico]) continue;
    for (const campo of Object.keys(VAZIO[servico])) {
      if (Object.prototype.hasOwnProperty.call(patch[servico], campo)) {
        atual[servico][campo] = String(patch[servico][campo] ?? '').trim();
      }
    }
  }
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(atual, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {
    /* sistemas de arquivos sem permissão POSIX */
  }
  return atual;
}

/** Só o que pode ser mostrado na tela: nada de segredos. */
function status() {
  const c = ler();
  const temChave = Boolean(c.typesafe.apiKey);
  const temGoogle = Boolean(c.google.email && c.google.appPassword);
  const temAgenda = Boolean(c.google.icalUrl);
  const temCliente = Boolean(c.google.clientId && c.google.clientSecret);
  const conectado = Boolean(c.google.refreshToken);
  return {
    arquivo: FILE,
    typesafe: {
      configurado: temChave,
      // Pista visual para o usuário conferir se colou a chave certa,
      // sem revelar a chave: só os 4 primeiros e os 4 últimos caracteres.
      dica: temChave ? mascarar(c.typesafe.apiKey) : '',
    },
    google: {
      email: c.google.email || '',
      senhaApp: Boolean(c.google.appPassword),
      agenda: temAgenda,
      // O endereço secreto do iCal é longo; mostramos só o começo.
      agendaDica: temAgenda ? `${c.google.icalUrl.slice(0, 46)}…` : '',
      configurado: temGoogle,
      // OAuth
      clienteConfigurado: temCliente,
      clienteDica: temCliente ? mascarar(c.google.clientId) : '',
      conectado,
      expiraEm: c.google.accessTokenExpira || '',
      escopos: c.google.escopos || '',
    },
  };
}

function mascarar(segredo) {
  const s = String(segredo);
  if (s.length <= 10) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}${'•'.repeat(6)}${s.slice(-4)}`;
}

/** Uso interno: o valor cru, para montar requisições. */
function chaveTypesafe() {
  return ler().typesafe.apiKey;
}
function google() {
  return ler().google;
}

/** Apaga tudo. Usado quando o usuário quer desconectar de vez. */
function apagar() {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* já não existia */
  }
  return status();
}

module.exports = {
  FILE,
  CONFIG_DIR,
  ler,
  gravar,
  status,
  mascarar,
  chaveTypesafe,
  google,
  apagar,
};
