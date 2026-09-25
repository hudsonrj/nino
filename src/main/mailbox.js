'use strict';

/**
 * Ponte entre o Nino e o Gmail.
 *
 * O trabalho pesado fica em python/mailbox.py, que usa imaplib/smtplib da
 * biblioteca padrão. Aqui só cuidamos de: escolher o interpretador, mandar a
 * configuração pelo stdin (nunca pela linha de comando, onde a senha
 * apareceria no `ps`) e devolver o JSON.
 *
 * Nada é gravado em disco: os e-mails ficam na memória pelo tempo da triagem.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');
const credentials = require('./credentials');

const SCRIPT = path.join(__dirname, 'python', 'mailbox.py');

/** O venv do whisper já tem um python3 pronto; fora dele, o do sistema. */
function interpretador() {
  const venv = path.join(config.ROOT, 'vendor', 'sttenv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return process.env.PYTHON || 'python3';
}

function executar(comando, parametros, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const cfg = credentials.google();
    if (!cfg.email || !cfg.appPassword) {
      resolve({
        ok: false,
        erro: 'Gmail não configurado. Informe seu e-mail e a senha de app no painel do Nino.',
        codigo: 'SEM_CONTA',
      });
      return;
    }

    // O Python chama esse campo de "senha"; o cofre o chama de "appPassword".
    // O Google mostra a senha de app em quatro blocos de quatro letras, e o
    // IMAP só aceita sem espaços — então limpamos aqui.
    const entrada = JSON.stringify({
      email: cfg.email,
      senha: String(cfg.appPassword).replace(/\s+/g, ''),
      ...parametros,
    });
    const proc = spawn(interpretador(), [SCRIPT, comando], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let saida = '';
    let erro = '';
    let terminado = false;

    const relogio = setTimeout(() => {
      if (!terminado) {
        terminado = true;
        try {
          proc.kill('SIGKILL');
        } catch {
          /* já morreu */
        }
        resolve({ ok: false, erro: `O Gmail não respondeu em ${timeoutMs / 1000}s.` });
      }
    }, timeoutMs);

    proc.stdout.on('data', (c) => {
      saida += c.toString('utf8');
    });
    proc.stderr.on('data', (c) => {
      erro += c.toString('utf8');
    });

    proc.on('error', (err) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(relogio);
      resolve({
        ok: false,
        erro: `Não consegui executar o Python (${err.message}). Instale o python3.`,
      });
    });

    proc.on('close', () => {
      if (terminado) return;
      terminado = true;
      clearTimeout(relogio);
      try {
        resolve(JSON.parse(saida.trim() || '{}'));
      } catch {
        resolve({
          ok: false,
          erro: erro.trim() || 'Resposta inesperada do leitor de e-mail.',
        });
      }
    });

    proc.stdin.on('error', () => {
      /* o processo pode morrer antes de ler; o close trata */
    });
    proc.stdin.write(entrada);
    proc.stdin.end();
  });
}

const ping = () => executar('ping', {}, 25000);
const pastas = () => executar('pastas', {}, 25000);

/** Cabeçalhos das mensagens mais recentes. Não marca nada como lido. */
const listar = (opcoes = {}) =>
  executar('listar', {
    pasta: opcoes.pasta || 'INBOX',
    limite: Math.min(60, Math.max(1, opcoes.limite || 20)),
    somenteNaoLidos: Boolean(opcoes.somenteNaoLidos),
  });

/** Corpo de uma mensagem, já sem a citação da resposta anterior. */
const ler = (uid, pasta) => executar('ler', { uid, pasta: pasta || 'INBOX' });

/** Envio de resposta. Só chamado depois da aprovação explícita do usuário. */
const enviar = (dados) =>
  executar(
    'enviar',
    {
      para: dados.para,
      assunto: dados.assunto,
      texto: dados.texto,
      respostaA: dados.respostaA || '',
      referencias: dados.referencias || '',
    },
    45000
  );

/** Fala com a agenda do Google pelo endereço secreto do iCal (sem senha). */
async function eventos({ dias = 7, max = 40 } = {}) {
  const { icalUrl } = credentials.google();
  if (!icalUrl) {
    return {
      ok: false,
      erro: 'Agenda não configurada. Cole o endereço secreto do iCal no painel do Nino.',
      codigo: 'SEM_AGENDA',
    };
  }
  return require('./calendar').buscar({ url: icalUrl, dias, max });
}

function configurado() {
  const g = credentials.google();
  return {
    email: g.email || '',
    senhaApp: Boolean(g.appPassword),
    agenda: Boolean(g.icalUrl),
    pronto: Boolean(g.email && g.appPassword),
  };
}

module.exports = {
  SCRIPT,
  interpretador,
  ping,
  pastas,
  listar,
  ler,
  enviar,
  eventos,
  configurado,
};
