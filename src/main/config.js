'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const KB_DIR = path.join(DATA_DIR, 'kb');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const MODELS_DIR = path.join(DATA_DIR, 'models');
const PIPER_BIN = path.join(VENDOR_DIR, 'piper', 'piper');
const PIPER_LIB = path.join(VENDOR_DIR, 'piper');
const VOICES_DIR = path.join(VENDOR_DIR, 'voices');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SYSTEM_PROMPT = `Você é o Nino, um mascote-assistente simpático que flutua na tela do usuário.

Regras:
- Responda em português do Brasil, com simpatia e sem enrolação.
- Sua resposta é LIDA EM VOZ ALTA: use frases curtas; nada de markdown, listas, tabelas, emojis ou símbolos.
- Comece pela resposta, sem preâmbulos como "Claro!" ou "Ótima pergunta!".
- Seja breve: de 1 a 4 frases, a não ser que peçam detalhes.
- Ao usar a BASE DE CONHECIMENTO, diga de qual documento veio ("No arquivo X..."). Se a base não tiver a resposta, avise que não encontrou nos documentos e responda com conhecimento geral.`;

const DEFAULTS = {
  model: 'qwen3.5:2b',
  embedModel: 'bge-m3',
  voice: 'pt_BR-faber-medium',
  lengthScale: 1.0,
  volume: 1.0,
  ttsEnabled: true,
  // Saída de áudio escolhida ('' = padrão do sistema). Só usado no modo
  // web/navegador, onde o som sai pelo navegador.
  audioOutput: '',
  sttEnabled: true,
  sttModel: 'small',
  sttLanguage: 'pt',
  topK: 3,
  minScore: 0.30,
  // Cada trecho injetado no prompt é cortado aqui. Em CPU o prompt eval é o
  // gargalo (~25 tok/s), então contexto curto = primeira palavra mais rápida.
  maxSnippet: 550,
  historyLimit: 6,
  maxHistoryChars: 400,
  useKnowledgeBase: true,
  // 0 = automático. O Ollama costuma usar threads demais em VMs (WSL2) e
  // perde muito desempenho; ~metade dos núcleos foi bem melhor na prática.
  numThread: 0,
  maxTokens: 400,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

/** Número de threads de inferência sugerido para esta máquina. */
function autoThreads() {
  let cores = 4;
  try {
    cores = require('os').cpus().length || 4;
  } catch {
    cores = 4;
  }
  return Math.min(8, Math.max(2, Math.floor(cores / 2)));
}

function ensureDirs() {
  for (const d of [DATA_DIR, KB_DIR, AUDIO_DIR, MODELS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

let cache = null;

function loadSettings() {
  if (cache) return cache;
  ensureDirs();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

function saveSettings(patch) {
  const current = loadSettings();
  cache = { ...current, ...patch };
  ensureDirs();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

module.exports = {
  ROOT,
  DATA_DIR,
  KB_DIR,
  AUDIO_DIR,
  MODELS_DIR,
  VENDOR_DIR,
  PIPER_BIN,
  PIPER_LIB,
  VOICES_DIR,
  SETTINGS_FILE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULTS,
  autoThreads,
  ensureDirs,
  loadSettings,
  saveSettings,
};
