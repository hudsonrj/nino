'use strict';

/**
 * Orquestração da conversa: base de conhecimento + histórico + Ollama.
 *
 * Fica separado do Electron porque é usado por dois "frontends":
 *   - o processo principal do app de desktop (main.js)
 *   - o servidor web (src/server/web.js)
 * Nenhum dos dois precisa saber como o prompt é montado.
 */

const config = require('./config');
const ollama = require('./ollama');
const kb = require('./kb');

const MAX_HISTORY = 14;

/**
 * Extrai frases completas de um buffer acumulado, para falar em streaming.
 * Enquanto houver bloco de código aberto, não fala nada.
 */
function takeSpeech(buf, force) {
  const inCode = (buf.match(/```/g) || []).length % 2 === 1;
  if (inCode && !force) return { flush: '', rest: buf };
  if (force) return { flush: buf.trim(), rest: '' };
  const parts = buf.split(/(?<=[.!?…])\s+/);
  if (parts.length < 2) return { flush: '', rest: buf };
  const rest = parts.pop();
  const flush = parts.join(' ').trim();
  if (flush.length < 20) return { flush: '', rest: buf };
  return { flush, rest };
}

/**
 * Monta as mensagens enviadas ao modelo.
 * O contexto recuperado entra no prompt do sistema; o histórico vai enxuto
 * porque em CPU cada token de prompt custa ~40 ms.
 */
function buildMessages(settings, question, context, history) {
  const stats = kb.stats();
  let system = settings.systemPrompt;

  if (context) {
    system +=
      '\n\n--- BASE DE CONHECIMENTO (trechos dos documentos do usuário) ---\n' +
      `${context}\n--- FIM DA BASE ---\n\n` +
      'Use esses trechos para responder. Se eles não contiverem a resposta, ' +
      'diga que não encontrou nos documentos.';
  } else if (settings.useKnowledgeBase && stats.chunks > 0) {
    system += '\n\nA base de conhecimento não retornou trechos relevantes para esta pergunta.';
  }

  const limit = settings.historyLimit || 6;
  const maxChars = settings.maxHistoryChars || 400;
  const recent = history.slice(-limit).map((m) => ({
    role: m.role,
    content: m.content.length > maxChars ? `${m.content.slice(0, maxChars)}…` : m.content,
  }));

  return [
    { role: 'system', content: system },
    ...recent,
    { role: 'user', content: question },
  ];
}

/**
 * Uma sessão de conversa (com memória própria).
 * @returns {{ask:Function, abort:Function, reset:Function, history:Array}}
 */
function createChatSession() {
  let history = [];
  let aborter = null;

  /**
   * @param {string} question
   * @param {object} handlers
   * @param {(token:string, full:string)=>void} [handlers.onToken]
   * @param {(sources:Array)=>void} [handlers.onSources]
   * @param {(result:object)=>void} [handlers.onDone]
   * @param {(error:string, meta?:object)=>void} [handlers.onError]
   * @param {()=>void} [handlers.onAborted]
   */
  async function ask(question, handlers = {}) {
    const settings = config.loadSettings();
    const clean = String(question || '').trim();
    if (!clean) {
      if (handlers.onError) handlers.onError('Mensagem vazia');
      return { ok: false, error: 'Mensagem vazia' };
    }

    // Uma resposta por vez: cancela a anterior.
    if (aborter) {
      try {
        aborter.abort();
      } catch {
        /* ignora */
      }
      aborter = null;
    }

    // 1. Busca na base de conhecimento.
    let context = '';
    let sources = [];
    const stats = kb.stats();
    if (settings.useKnowledgeBase && stats.chunks > 0) {
      try {
        const built = await kb.buildContext(clean, {
          topK: settings.topK,
          minScore: settings.minScore,
          maxSnippet: settings.maxSnippet,
        });
        context = built.context;
        sources = built.sources;
        if (handlers.onSources) handlers.onSources(sources);
      } catch (err) {
        if (handlers.onError) handlers.onError(`Base de conhecimento: ${err.message}`, { recoverable: true });
      }
    }

    // 2. Conversa.
    const messages = buildMessages(settings, clean, context, history);
    const threads = settings.numThread > 0 ? settings.numThread : config.autoThreads();

    aborter = new AbortController();
    const signal = aborter.signal;

    try {
      const { text, stats: runStats } = await ollama.chatStream({
        model: settings.model,
        messages,
        signal,
        options: {
          num_predict: settings.maxTokens || 400,
          temperature: 0.6,
          num_thread: threads,
        },
        onToken: (token, full) => {
          if (handlers.onToken) handlers.onToken(token, full);
        },
      });

      history.push({ role: 'user', content: clean });
      history.push({ role: 'assistant', content: text });
      if (history.length > MAX_HISTORY * 2) history = history.slice(-MAX_HISTORY * 2);

      if (handlers.onDone) handlers.onDone({ text, stats: runStats, sources });
      return { ok: true, text, sources, stats: runStats };
    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) {
        if (handlers.onAborted) handlers.onAborted();
        return { ok: false, aborted: true };
      }
      if (handlers.onError) handlers.onError(err.message);
      return { ok: false, error: err.message };
    } finally {
      if (aborter && aborter.signal === signal) aborter = null;
    }
  }

  function abort() {
    if (aborter) {
      try {
        aborter.abort();
      } catch {
        /* ignora */
      }
      aborter = null;
    }
  }

  function reset() {
    abort();
    history = [];
  }

  return {
    ask,
    abort,
    reset,
    get history() {
      return history;
    },
  };
}

module.exports = { createChatSession, takeSpeech, buildMessages };
