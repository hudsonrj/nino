'use strict';

/**
 * OAuth 2.0 do Google, pelo fluxo de aplicativo instalado (loopback).
 *
 * Por que isso existe: a alternativa simples (senha de app + endereço secreto
 * do iCal) funciona, mas o Google empurra OAuth como o caminho oficial — e é
 * o único que permite, no futuro, escrever na agenda.
 *
 * Como o fluxo funciona, em três passos:
 *   1. abrimos um servidor local em 127.0.0.1:3099;
 *   2. mandamos o usuário para a tela de consentimento do Google;
 *   3. o Google devolve o código para o nosso servidor, que o troca por um
 *      access token (curto) e um refresh token (longo, guardado no cofre).
 *
 * Duas armadilhas que custam tempo de quem integra, e que tratamos aqui:
 *
 * - O URI de redirecionamento precisa estar CADASTRADO no projeto do Google
 *   Cloud. Se não estiver, o Google responde "redirect_uri_mismatch" antes
 *   mesmo de mostrar a tela de consentimento. Não há como contornar isso do
 *   lado do código.
 *
 * - Com o app em "Testing" e usuários "External", o Google expira o
 *   consentimento e os tokens em 7 dias. Para uso diário é preciso publicar o
 *   app ("In production"); sem isso, você reautoriza toda semana.
 */

const http = require('http');
const https = require('https');
const credentials = require('./credentials');

const AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';

const PORTA = Number(process.env.NINO_GOOGLE_PORT || 3099);
const REDIRECIONAMENTO =
  process.env.NINO_GOOGLE_REDIRECT || `http://localhost:${PORTA}/oauth2callback`;

/**
 * Escopos pedidos. `gmail.readonly` e `gmail.send` são "restricted" para o
 * Google; num app não verificado funcionam para os usuários de teste
 * cadastrados, com aviso na tela de consentimento.
 */
const ESCOPOS = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

/* ------------------------------------------------------------------ */
/* Requisições                                                         */
/* ------------------------------------------------------------------ */

function postForm(url, campos, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const dados = Buffer.from(new URLSearchParams(campos).toString(), 'utf8');
    const alvo = new URL(url);
    const req = https.request(
      {
        hostname: alvo.hostname,
        path: alvo.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': dados.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, texto });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('O Google não respondeu a tempo.')));
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
}

/** Chamada autenticada a uma API do Google. */
function apiGet(url, token, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const alvo = new URL(url);
    const req = https.request(
      {
        hostname: alvo.hostname,
        path: alvo.pathname + alvo.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, texto });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('A API do Google não respondeu a tempo.')));
    req.on('error', reject);
    req.end();
  });
}

function apiPost(url, token, corpo, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const dados = Buffer.from(JSON.stringify(corpo), 'utf8');
    const alvo = new URL(url);
    const req = https.request(
      {
        hostname: alvo.hostname,
        path: alvo.pathname + alvo.search,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': dados.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, texto });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('A API do Google não respondeu a tempo.')));
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */

function configurado() {
  const g = credentials.google();
  return Boolean(g.clientId && g.clientSecret);
}

const conectado = () => Boolean(credentials.google().refreshToken);

/** Traduz os erros do Google, que são crípticos, para algo acionável. */
function explicarErro(json, texto, status) {
  const erro = (json && (json.error_description || json.error)) || '';
  const bruto = String(erro || texto || '').slice(0, 300);

  if (/redirect_uri_mismatch/i.test(bruto)) {
    return (
      'O Google recusou o endereço de retorno (redirect_uri_mismatch). ' +
      `Cadastre exatamente ${REDIRECIONAMENTO} em: Google Cloud Console → ` +
      'APIs e serviços → Credenciais → seu cliente OAuth → URIs de ' +
      'redirecionamento autorizados.'
    );
  }
  if (/invalid_client|unauthorized_client/i.test(bruto)) {
    return (
      'O Google recusou o client_id ou o client_secret. Confira se copiou os ' +
      'dois do mesmo cliente OAuth em Google Cloud Console → Credenciais.'
    );
  }
  if (/access_denied/i.test(bruto)) {
    return 'Você recusou a permissão na tela do Google. Nada foi autorizado.';
  }
  if (/invalid_grant/i.test(bruto)) {
    return (
      'A autorização expirou ou foi revogada. Isso acontece a cada 7 dias ' +
      'enquanto o app estiver com status "Testing" no Google Cloud. ' +
      'Reconecte; para não repetir toda semana, publique o app ' +
      '(tela de consentimento → Publicar aplicativo).'
    );
  }
  if (/insufficient|scope/i.test(bruto)) {
    return `Faltam permissões: ${bruto}`;
  }
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(bruto)) {
    return (
      'A API do Gmail ou do Google Agenda não está ativada neste projeto. ' +
      'Ative em Google Cloud Console → APIs e serviços → Biblioteca.'
    );
  }
  return `O Google recusou (HTTP ${status}): ${bruto}`;
}

/* ------------------------------------------------------------------ */
/* Fluxo de autorização                                                */
/* ------------------------------------------------------------------ */

let pendente = null; // { servidor, resolve, reject, relogio }

function urlAutorizacao(estado) {
  const g = credentials.google();
  const p = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: REDIRECIONAMENTO,
    response_type: 'code',
    // access_type=offline + prompt=consent é o que garante o refresh token.
    // Sem o prompt, uma segunda autorização não devolve refresh token novo.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: ESCOPOS.join(' '),
    state: estado,
  });
  return `${AUTORIZACAO}?${p.toString()}`;
}

function paginaResposta(titulo, mensagem, cor) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Nino</title><style>
body{background:#101a24;color:#e8f4f8;font:16px/1.6 system-ui,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{max-width:520px;text-align:center;padding:32px}
h1{font-size:20px;color:${cor};margin:0 0 12px}
p{color:#93a9b8;margin:0}
</style></head><body><div><h1>${titulo}</h1><p>${mensagem}</p></div></body></html>`;
}

/** Abre o navegador padrão. No WSL, quem abre é o Windows. */
function abrirNavegador(url) {
  const { spawn } = require('child_process');
  const tentativas = process.env.WSL_DISTRO_NAME
    ? [['cmd.exe', ['/c', 'start', '', url.replace(/&/g, '^&')]]]
    : [
        ['xdg-open', [url]],
        ['cmd.exe', ['/c', 'start', '', url.replace(/&/g, '^&')]],
      ];
  for (const [cmd, args] of tentativas) {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
      p.on('error', () => {});
      p.unref();
      return true;
    } catch {
      /* tenta o próximo */
    }
  }
  return false;
}

/**
 * Começa o fluxo: sobe o servidor de retorno e devolve a URL para o usuário
 * abrir. Fica esperando o Google chamar de volta.
 */
function iniciar({ abrir = true } = {}) {
  if (!configurado()) {
    return {
      ok: false,
      erro:
        'Preencha o client_id e o client_secret do seu projeto no Google Cloud ' +
        'antes de conectar.',
    };
  }
  if (pendente) {
    // Já existe um fluxo esperando: reaproveita em vez de abrir outra porta.
    return { ok: true, url: pendente.url, jaEsperando: true };
  }

  const estado = require('crypto').randomBytes(16).toString('hex');
  const url = urlAutorizacao(estado);

  return new Promise((resolve) => {
    const servidor = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${PORTA}`);
      if (u.pathname !== '/oauth2callback') {
        res.writeHead(404).end('não encontrado');
        return;
      }

      const erro = u.searchParams.get('error');
      const codigo = u.searchParams.get('code');
      const recebido = u.searchParams.get('state');

      const encerrar = (html) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        setTimeout(() => {
          try {
            servidor.close();
          } catch {
            /* já fechou */
          }
          if (pendente && pendente.relogio) clearTimeout(pendente.relogio);
          pendente = null;
        }, 400);
      };

      if (erro) {
        encerrar(
          paginaResposta(
            'Autorização recusada',
            `O Google respondeu: ${erro}. Você pode fechar esta aba.`,
            '#ff6b81'
          )
        );
        return;
      }
      if (recebido !== estado) {
        // Proteção contra CSRF: o state tem que ser o que nós geramos.
        encerrar(
          paginaResposta('Falha de segurança', 'O código recebido não confere.', '#ff6b81')
        );
        return;
      }
      if (!codigo) {
        encerrar(paginaResposta('Código ausente', 'O Google não devolveu o código.', '#ff6b81'));
        return;
      }

      try {
        const tokens = await trocarCodigo(codigo);
        encerrar(
          paginaResposta(
            'Conectado!',
            `Nino agora tem acesso a ${tokens.email || 'sua conta'}. Pode fechar esta aba e voltar ao mascote.`,
            '#4ade80'
          )
        );
      } catch (err) {
        encerrar(paginaResposta('Não deu certo', err.message, '#ff6b81'));
      }
    });

    servidor.on('error', (err) => {
      pendente = null;
      resolve({
        ok: false,
        erro:
          err.code === 'EADDRINUSE'
            ? `A porta ${PORTA} está ocupada. Feche o outro programa ou defina NINO_GOOGLE_PORT.`
            : `Não consegui abrir o servidor de retorno: ${err.message}`,
      });
    });

    servidor.listen(PORTA, '127.0.0.1', () => {
      const relogio = setTimeout(() => {
        try {
          servidor.close();
        } catch {
          /* já fechou */
        }
        pendente = null;
      }, 5 * 60 * 1000);

      pendente = { servidor, relogio, url };
      if (abrir) abrirNavegador(url);
      resolve({ ok: true, url, redirecionamento: REDIRECIONAMENTO });
    });
  });
}

/** Troca o código de autorização pelos tokens e guarda no cofre. */
async function trocarCodigo(codigo) {
  const g = credentials.google();
  const r = await postForm(TOKEN, {
    code: codigo,
    client_id: g.clientId,
    client_secret: g.clientSecret,
    redirect_uri: REDIRECIONAMENTO,
    grant_type: 'authorization_code',
  });

  if (r.status !== 200 || !r.json || r.json.error) {
    throw new Error(explicarErro(r.json, r.texto, r.status));
  }

  const t = r.json;
  const expira = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();

  // Nem sempre o Google manda um e-mail no token; buscamos no userinfo.
  let email = '';
  try {
    const u = await apiGet('https://www.googleapis.com/oauth2/v3/userinfo', t.access_token);
    if (u.json && u.json.email) email = u.json.email;
  } catch {
    /* opcional */
  }

  credentials.gravar({
    google: {
      refreshToken: t.refresh_token || '',
      accessToken: t.access_token || '',
      accessTokenExpira: expira,
      escopos: t.scope || ESCOPOS.join(' '),
      ...(email ? { email } : {}),
    },
  });

  return { email, expira };
}

/** Renova o access token a partir do refresh token. */
async function renovar() {
  const g = credentials.google();
  if (!g.refreshToken) throw new Error('Não há autorização salva. Conecte com o Google primeiro.');

  const r = await postForm(TOKEN, {
    refresh_token: g.refreshToken,
    client_id: g.clientId,
    client_secret: g.clientSecret,
    grant_type: 'refresh_token',
  });

  if (r.status !== 200 || !r.json || r.json.error) {
    throw new Error(explicarErro(r.json, r.texto, r.status));
  }
  const t = r.json;
  const expira = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
  credentials.gravar({
    google: {
      accessToken: t.access_token,
      accessTokenExpira: expira,
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
    },
  });
  return t.access_token;
}

/**
 * Devolve um access token válido, renovando se estiver perto de expirar.
 * A margem evita usar um token que expira no meio de uma requisição.
 */
async function token({ margemSegundos = 120 } = {}) {
  const g = credentials.google();
  if (!g.refreshToken) throw new Error('SEM_CONEXAO');
  const expira = g.accessTokenExpira ? new Date(g.accessTokenExpira).getTime() : 0;
  if (g.accessToken && expira - Date.now() > margemSegundos * 1000) {
    return g.accessToken;
  }
  return renovar();
}

/**
 * Confere se o Google aceita o endereço de retorno deste projeto.
 *
 * Por que isso merece código próprio: quando o URI não está cadastrado, o
 * Google não mostra a tela de consentimento — redireciona para uma página de
 * erro. E o motivo vem **codificado em base64** no parâmetro `authError`, não
 * como texto legível. Procurar "redirect_uri_mismatch" na resposta crua não
 * encontra nada, e o diagnóstico conclui, errado, que está tudo bem.
 */
async function verificarRedirecionamento() {
  const url = urlAutorizacao('diagnostico');
  let r;
  try {
    r = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, campo: 'rede', erro: `Não consegui falar com o Google: ${err.message}` };
  }

  const pistas = [String(r.url)];
  try {
    const corpo = await r.text();
    pistas.push(corpo.slice(0, 6000));
  } catch {
    /* sem corpo: as pistas da URL bastam */
  }

  // Decodifica o authError, que é um protobuf em base64.
  try {
    const m = /authError=([^&]+)/.exec(String(r.url));
    if (m) pistas.push(Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8'));
  } catch {
    /* não era base64 válido */
  }

  const texto = pistas.join(' ');

  if (/redirect_uri_mismatch/.test(texto)) {
    return {
      ok: false,
      campo: 'redirecionamento',
      erro: 'O endereço de retorno ainda não está cadastrado neste projeto do Google Cloud.',
      comoResolver:
        'Google Cloud Console → APIs e serviços → Credenciais → seu cliente ' +
        `OAuth → "URIs de redirecionamento autorizados" → adicione exatamente ${REDIRECIONAMENTO}`,
    };
  }
  if (/invalid_client|OAuth client was not found|deleted_client/.test(texto)) {
    return {
      ok: false,
      campo: 'client_id',
      erro: 'O Google não reconhece este client_id. Confira se copiou o cliente certo.',
    };
  }
  if (/invalid_scope|admin_policy_enforced/.test(texto)) {
    return {
      ok: false,
      campo: 'escopo',
      erro: 'O Google recusou os escopos pedidos para este projeto.',
    };
  }
  return { ok: true, detalhe: 'O Google aceitou o endereço de retorno.' };
}

/** Encerra o fluxo que estiver esperando, se houver. */
function cancelar() {
  if (!pendente) return { ok: true };
  try {
    pendente.servidor.close();
  } catch {
    /* já fechou */
  }
  clearTimeout(pendente.relogio);
  pendente = null;
  return { ok: true };
}

const esperando = () => Boolean(pendente);

/** Esquece a autorização (mantém client_id e client_secret). */
function desconectar() {
  cancelar();
  credentials.gravar({
    google: {
      refreshToken: '',
      accessToken: '',
      accessTokenExpira: '',
      escopos: '',
    },
  });
  return { ok: true };
}

/** Estado para a interface. */
function status() {
  const g = credentials.google();
  return {
    clienteConfigurado: configurado(),
    conectado: Boolean(g.refreshToken),
    email: g.email || '',
    escopos: g.escopos || '',
    expiraEm: g.accessTokenExpira || '',
    redirecionamento: REDIRECIONAMENTO,
    porta: PORTA,
    esperando: esperando(),
    escoposPedidos: ESCOPOS,
  };
}

module.exports = {
  ESCOPOS,
  REDIRECIONAMENTO,
  PORTA,
  configurado,
  conectado,
  status,
  explicarErro,
  iniciar,
  cancelar,
  esperando,
  desconectar,
  token,
  renovar,
  apiGet,
  apiPost,
  abrirNavegador,
  urlAutorizacao,
  verificarRedirecionamento,
};
