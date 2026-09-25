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

/** Prompt usado quando o mascote olha pela câmera. */
const DEFAULT_CAMERA_PROMPT = `Olhe a imagem da câmera e descreva, em português, de forma natural e calorosa (é falado em voz alta):

1. Quem está aí: quantas pessoas, o que estão fazendo, roupa, postura.
2. Como a pessoa parece se sentir, pelo rosto e pelo corpo (ex.: cansada, animada, concentrada, tensa, tranquila). Diga que é uma leitura pelo visual, sem certeza.
3. O ambiente ao redor: onde parece ser, o que há em volta, iluminação, objetos notáveis.

Seja específico e observe detalhes. Não invente: se algo não estiver visível, diga que não dá para ver. De 3 a 5 frases.`;

/** Prompt usado quando o mascote olha a tela do usuário. */
const DEFAULT_SCREEN_PROMPT = `Olhe esta captura da tela do usuário e explique, em português, o que está acontecendo (é falado em voz alta):

1. Qual programa ou site está aberto e o que está sendo mostrado.
2. O que o usuário parece estar fazendo naquele momento.
3. O que chama atenção: erros, mensagens, números, algo fora do lugar.
4. Se fizer sentido, uma sugestão prática de próximo passo.

Seja direto e útil, sem descrever pixel por pixel. Se não der para entender algum trecho, diga. De 3 a 5 frases.`;

/** Prompt usado quando o mascote resume o dia a partir do e-mail e da agenda. */
const DEFAULT_AGENDA_PROMPT = `Você está dando o resumo do dia para o usuário, em voz alta.

Abaixo vêm os fatos já classificados pelo JEV (um modelo de decisão rápido):
compromissos da agenda, mensagens que pedem resposta hoje, mensagens que
podem esperar, o que ficou incerto e o que é ruído. O JEV decidiu; você
apenas comunica.

Regras:
- Fale em português do Brasil, com frases curtas (é LIDO EM VOZ ALTA).
- Sem markdown, listas, tabelas, emojis ou símbolos.
- Comece pelo que é mais urgente hoje. Se o dia estiver tranquilo, diga isso.
- Cite nomes de pessoas e assuntos concretos; nada de generalidades.
- Diga quantas mensagens podem ser descartadas sem leitura.
- Se houver itens marcados como incertos, avise que o JEV não teve certeza e
  que vale a pena olhar.
- Não invente nada que não esteja nos fatos. De 4 a 8 frases.`;

const DEFAULTS = {  model: 'qwen3.5:2b',
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
  // Visão: câmera e captura de tela. Vazio = usa o mesmo modelo da conversa
  // (os qwen3.5 enxergam). Nada sai da máquina: a imagem vai para o Ollama local.
  visionModel: '',
  visionEnabled: true,
  cameraEnabled: true,
  screenEnabled: true,
  // Lado maior da imagem enviada ao modelo. Menor = bem mais rápido na CPU.
  maxImageSide: 640,
  // JEV (TypeSafe): modelo de decisão rápido e barato, usado para triar
  // e-mail e agenda antes de gastar o modelo local. Fica DESLIGADO por
  // padrão porque o conteúdo sai da máquina — diferente do resto do Nino.
  jevEnabled: false,
  jevModel: 'jev-latest',
  // Abaixo desta confiança o JEV não decide sozinho: o item vai para a
  // pilha "incerto" e o usuário julga.
  jevConfiancaMinima: 0.6,
  agendaDias: 2,
  agendaMensagens: 12,
  agendaSomenteNaoLidos: true,
  // Enviar o corpo dos e-mails ao JEV dá uma triagem bem melhor do que só
  // o assunto, mas manda mais conteúdo para fora. Fica a critério do usuário.
  agendaIncluirCorpo: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  cameraPrompt: DEFAULT_CAMERA_PROMPT,
  screenPrompt: DEFAULT_SCREEN_PROMPT,
  agendaPrompt: DEFAULT_AGENDA_PROMPT,
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
  DEFAULT_CAMERA_PROMPT,
  DEFAULT_SCREEN_PROMPT,
  DEFAULT_AGENDA_PROMPT,
  DEFAULTS,
  autoThreads,
  ensureDirs,
  loadSettings,
  saveSettings,
};
