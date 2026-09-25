'use strict';

/**
 * Cliente fino para a API local do Ollama.
 *
 * Usa `node:http` em vez de `fetch` de propósito: o undici embutido no Node
 * impõe um `headersTimeout` de 300 s, o que quebra respostas longas quando a
 * inferência roda na CPU. Aqui não há timeout de socket — quem cancela é o
 * AbortSignal da conversa.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');

/** Cria a AbortError que o resto do app espera. */
function abortError() {
  const err = new Error('Requisição cancelada');
  err.name = 'AbortError';
  return err;
}

/**
 * Faz uma requisição à API e entrega a resposta linha a linha (NDJSON).
 * @param {string} apiPath
 * @param {object} payload
 * @param {{signal?:AbortSignal, onLine?:(obj:object)=>void}} [opts]
 * @returns {Promise<void>} resolve quando o corpo termina
 */
function streamJson(apiPath, payload, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }

    const url = new URL(apiPath, HOST);
    const transport = url.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Accept: 'application/x-ndjson, application/json',
        },
        // Sem timeout de socket: inferência em CPU pode demorar minutos.
        timeout: 0,
      },
      (res) => {
        if (res.statusCode !== 200) {
          let detail = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (detail.length < 400) detail += chunk;
          });
          res.on('end', () => {
            reject(new Error(`HTTP ${res.statusCode} em ${apiPath}: ${detail.trim().slice(0, 300)}`));
          });
          return;
        }

        let buffer = '';
        res.setEncoding('utf8');

        const flush = (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let obj;
          try {
            obj = JSON.parse(trimmed);
          } catch {
            return;
          }
          if (obj.error) {
            reject(new Error(`Ollama: ${obj.error}`));
            req.destroy();
            return;
          }
          if (onLine) onLine(obj);
        };

        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            flush(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
          }
        });

        res.on('end', () => {
          if (buffer.trim()) flush(buffer);
          resolve();
        });

        res.on('error', reject);
      }
    );

    const onAbort = () => {
      req.destroy();
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) => {
      if (signal && signal.aborted) reject(abortError());
      else reject(err);
    });

    req.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    });

    req.write(body);
    req.end();
  });
}

/** Requisição simples que devolve o JSON completo. */
async function requestJson(apiPath, payload, { signal, timeoutMs = 600000 } = {}) {
  const url = new URL(apiPath, HOST);
  const transport = url.protocol === 'https:' ? https : http;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} em ${apiPath}: ${raw.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Resposta inválida de ${apiPath}: ${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Tempo esgotado (${timeoutMs} ms) em ${apiPath}`)));
    req.on('error', reject);
    if (signal) {
      signal.addEventListener('abort', () => { req.destroy(); reject(abortError()); }, { once: true });
    }
    req.write(body);
    req.end();
  });
}

/** GET simples (para /api/tags). */
function getJson(apiPath, { timeoutMs = 8000 } = {}) {
  const url = new URL(apiPath, HOST);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} em ${apiPath}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Resposta inválida de ${apiPath}: ${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Tempo esgotado em ${apiPath}`)));
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* API pública                                                         */
/* ------------------------------------------------------------------ */

async function ping() {
  try {
    await getJson('/api/tags', { timeoutMs: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function listModels() {
  const data = await getJson('/api/tags', { timeoutMs: 10000 });
  return (data.models || []).map((m) => ({
    name: m.name,
    size: m.size,
    parameterSize: m.details && m.details.parameter_size,
    capabilities: m.capabilities || [],
  }));
}

/**
 * Gera embeddings em lote.
 * @param {string[]} texts
 * @param {string} model
 * @returns {Promise<number[][]>}
 */
async function embed(texts, model) {
  if (!texts.length) return [];
  const data = await requestJson(
    '/api/embed',
    { model, input: texts, truncate: true },
    { timeoutMs: 1800000 }
  );
  const embeddings = data.embeddings || (data.embedding ? [data.embedding] : []);
  if (embeddings.length !== texts.length) {
    throw new Error(`Esperava ${texts.length} embeddings, recebi ${embeddings.length}`);
  }
  return embeddings;
}

/**
 * Conversa com streaming de tokens.
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {(token:string, full:string)=>void} [opts.onToken]
 * @param {(info:object)=>void} [opts.onStatus]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.options]
 * @param {boolean} [opts.think]
 * @returns {Promise<{text:string, stats:object}>}
 */
async function chatStream({
  model,
  messages,
  onToken,
  onStatus,
  signal,
  options = {},
  think = false,
  // -1 = manter o modelo na memória para sempre. Recarregar custa ~30 s em CPU,
  // então num assistente de uso contínuo isso é obrigatório.
  keepAlive = -1,
}) {
  const payload = {
    model,
    messages,
    stream: true,
    // Mantém o modelo na memória entre as perguntas: recarregar custa ~30 s.
    keep_alive: keepAlive,
    options: { temperature: 0.6, top_p: 0.9, num_ctx: 8192, ...options },
  };
  // Modelos "thinking" (qwen3.x) gastam muito tempo pensando na CPU.
  if (think === false) payload.think = false;

  let full = '';
  let stats = {};

  const run = (body) =>
    streamJson('/api/chat', body, {
      signal,
      onLine: (obj) => {
        const piece = obj.message && obj.message.content ? obj.message.content : '';
        if (piece) {
          full += piece;
          if (onToken) onToken(piece, full);
        }
        if (obj.done) {
          stats = {
            evalCount: obj.eval_count,
            promptEvalCount: obj.prompt_eval_count,
            totalDurationMs: obj.total_duration ? Math.round(obj.total_duration / 1e6) : undefined,
            loadDurationMs: obj.load_duration ? Math.round(obj.load_duration / 1e6) : undefined,
            promptEvalDurationMs: obj.prompt_eval_duration
              ? Math.round(obj.prompt_eval_duration / 1e6)
              : undefined,
            evalDurationMs: obj.eval_duration ? Math.round(obj.eval_duration / 1e6) : undefined,
          };
          if (onStatus) onStatus(stats);
        }
      },
    });

  try {
    await run(payload);
  } catch (err) {
    // Este Ollama pode não conhecer o campo `think`; tenta de novo sem ele.
    if (payload.think !== undefined && /think/i.test(err.message)) {
      delete payload.think;
      full = '';
      await run(payload);
    } else {
      throw err;
    }
  }

  return { text: full, stats };
}

module.exports = { HOST, ping, listModels, embed, chatStream };
