'use strict';

/**
 * Preload falso, só para pré-visualizar a interface sem o processo principal.
 * Permite emitir eventos para a página através de window.__mock.emit().
 */

const { contextBridge } = require('electron');

const listeners = new Map();

function on(channel, fn) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(fn);
  return () => listeners.get(channel).delete(fn);
}

const noop = () => ({ ok: true });

contextBridge.exposeInMainWorld('__mock', {
  emit(channel, payload) {
    const set = listeners.get(channel);
    if (set) for (const fn of set) fn(payload);
  },
});

const MOCK_SETTINGS = {
  model: 'qwen3.5:2b',
  embedModel: 'bge-m3',
  voice: 'pt_BR-faber-medium',
  lengthScale: 1,
  volume: 1,
  ttsEnabled: true,
  useKnowledgeBase: true,
  topK: 5,
  minScore: 0.3,
  numThread: 0,
  maxTokens: 400,
  sttModel: 'small',
  systemPrompt: 'Você é o Nino, um mascote-assistente simpático que vive flutuando na tela.',
};

const DOCS = [
  { id: '1', name: 'Dom Casmurro — Machado de Assis.epub', ext: 'epub', bytes: 227285, chars: 396707, chunkCount: 331, pages: null, addedAt: new Date().toISOString() },
  { id: '2', name: 'notas-do-projeto.md', ext: 'md', bytes: 764, chars: 764, chunkCount: 1, addedAt: new Date().toISOString() },
  { id: '3', name: 'receita-bolo.md', ext: 'md', bytes: 502, chars: 502, chunkCount: 1, addedAt: new Date().toISOString() },
  { id: '4', name: 'manual-do-produto.pdf', ext: 'pdf', bytes: 1843200, chars: 120000, chunkCount: 96, pages: 142, addedAt: new Date().toISOString() },
];

contextBridge.exposeInMainWorld('nino', {
  chat: {
    send: () => ({ ok: true }),
    abort: noop,
    reset: noop,
    onToken: (fn) => on('chat:token', fn),
    onDone: (fn) => on('chat:done', fn),
    onError: (fn) => on('chat:error', fn),
    onAborted: (fn) => on('chat:aborted', fn),
  },
  voice: {
    speak: noop,
    stop: noop,
    listen: noop,
    stopListening: noop,
    onTtsState: (fn) => on('tts:state', fn),
    onAudioState: (fn) => on('audio:state', fn),
    onTranscript: (fn) => on('audio:transcript', fn),
    onError: (fn) => on('audio:error', fn),
  },
  kb: {
    addViaDialog: () => ({ canceled: true }),
    addPaths: noop,
    list: () => ({
      documents: DOCS,
      stats: { documents: DOCS.length, chunks: 429, chars: 518000, embedModel: 'bge-m3', dim: 1024 },
    }),
    remove: noop,
    clear: noop,
    stats: () => ({ documents: DOCS.length, chunks: 429, chars: 518000, embedModel: 'bge-m3', dim: 1024 }),
    search: () => ({ hits: [] }),
    onProgress: (fn) => on('kb:progress', fn),
    onChanged: (fn) => on('kb:changed', fn),
  },
  settings: {
    get: () => MOCK_SETTINGS,
    set: () => ({ settings: MOCK_SETTINGS }),
  },
  system: {
    status: () => ({
      ollama: true,
      ollamaHost: 'http://127.0.0.1:11434',
      autoThreads: 7,
      voices: ['pt_BR-faber-medium', 'pt_BR-edresson-low'],
      settings: MOCK_SETTINGS,
      kb: { documents: 4, chunks: 429 },
      dataDir: '/home/hudson/clone/mascote/data',
      speaking: false,
      recording: false,
    }),
    voices: () => ['pt_BR-faber-medium', 'pt_BR-edresson-low'],
    models: () => ({
      models: [
        { name: 'qwen3.5:2b', parameterSize: '2.3B' },
        { name: 'qwen3.5:0.8b', parameterSize: '873M' },
        { name: 'qwen3.5:9b', parameterSize: '9.7B' },
        { name: 'bge-m3', parameterSize: '567M' },
        { name: 'nomic-embed-text', parameterSize: '137M' },
      ],
    }),
    openDataFolder: noop,
    quit: noop,
    onReady: (fn) => on('app:ready', fn),
    onClickThrough: (fn) => on('app:clickThrough', fn),
  },
  win: {
    dragStart: noop,
    dragMove: noop,
    dragEnd: noop,
    resize: noop,
    hide: noop,
    clickThrough: noop,
  },
});
