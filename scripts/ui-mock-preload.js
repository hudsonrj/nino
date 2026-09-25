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
  jevEnabled: true,
  jevModel: 'jev-latest',
  jevConfiancaMinima: 0.6,
  agendaDias: 2,
  agendaMensagens: 12,
  agendaSomenteNaoLidos: true,
  agendaIncluirCorpo: true,
};

const MOCK_CREDENCIAIS = {
  arquivo: '/home/hudson/.config/nino/credenciais.json',
  typesafe: { configurado: true, dica: 'ts_a••••••9f2c' },
  google: {
    email: 'hudson@gmail.com',
    senhaApp: true,
    agenda: true,
    agendaDica: 'https://calendar.google.com/calendar/ical/hud…',
    configurado: true,
  },
};

/** Uma triagem já pronta, para a captura da visão "Meu dia". */
const MOCK_TRIAGEM = {
  ok: true,
  quando: new Date().toISOString(),
  modelo: 'jev-1.13.0',
  ms: 287,
  custoUSD: 0.00019,
  uso: { tokensEntrada: 4608, tokensSaida: 120 },
  acumulado: { chamadas: 12, tokensEntrada: 31240, tokensSaida: 480, custoUSD: 0.001312 },
  confiancaMinima: 0.6,
  eventos: [
    {
      index: 0, day: 'sex 25/09', time: '14:00-15:00', title: 'Reunião com cliente',
      location: 'Sala 3', preparo: 'preparar_material', preparoRotulo: 'preparar material',
      essencial: true, probabilidadeEssencial: 0.97, confianca: 0.91, confiavel: true,
    },
    {
      index: 1, day: 'sex 25/09', time: '17:00-17:30', title: 'Revisão semanal',
      location: '', preparo: 'nada', preparoRotulo: 'nada a preparar',
      essencial: false, probabilidadeEssencial: 0.3, confianca: 0.86, confiavel: true,
    },
    {
      index: 2, day: 'sáb 26/09', time: 'dia inteiro', title: 'Mudança de escritório',
      location: 'Av. Paulista', preparo: 'confirmar', preparoRotulo: 'confirmar presença',
      essencial: true, probabilidadeEssencial: 0.72, confianca: 0.66, confiavel: true,
    },
  ],
  mensagens: [
    {
      indice: 0, uid: '1', de: 'Ana Souza', enderecoDe: 'ana@clientex.com.br',
      assunto: 'Contrato para assinar hoje', data: 'Fri, 25 Sep 2026 09:12:00 -0300',
      naoLido: true, messageId: '<a@x>', referencias: '', anexos: ['contrato.pdf'],
      trecho: 'Preciso da sua assinatura ainda hoje, senão perdemos o prazo da licitação.',
      acao: 'responder_agora', acaoRotulo: 'responder hoje', urgencia: 3,
      urgenciaRotulo: 'urgente hoje', tipo: 'cliente', tipoRotulo: 'cliente',
      precisaEscrever: true, probabilidadeEscrever: 0.96, confianca: 0.94, confiavel: true,
    },
    {
      indice: 1, uid: '3', de: 'Marcos Lima', enderecoDe: 'marcos@parceiro.com',
      assunto: 'Proposta revisada — precisamos de um retorno', data: 'Fri, 25 Sep 2026 07:40:00 -0300',
      naoLido: true, messageId: '<b@x>', referencias: '', anexos: [],
      trecho: 'Segue a proposta com os ajustes que combinamos. Consegue avaliar?',
      acao: 'responder_agora', acaoRotulo: 'responder hoje', urgencia: 3,
      urgenciaRotulo: 'urgente hoje', tipo: 'trabalho', tipoRotulo: 'trabalho',
      precisaEscrever: true, probabilidadeEscrever: 0.88, confianca: 0.81, confiavel: true,
    },
    {
      indice: 2, uid: '4', de: 'Carlos Mendes', enderecoDe: 'carlos@empresa.com',
      assunto: 'Podemos remarcar a call?', data: 'Thu, 24 Sep 2026 18:02:00 -0300',
      naoLido: true, messageId: '<c@x>', referencias: '', anexos: [],
      trecho: 'Tive um imprevisto, alguma chance de passar para semana que vem?',
      acao: 'responder_semana', acaoRotulo: 'responder nesta semana', urgencia: 1,
      urgenciaRotulo: 'pode esperar', tipo: 'trabalho', tipoRotulo: 'trabalho',
      precisaEscrever: true, probabilidadeEscrever: 0.79, confianca: 0.88, confiavel: true,
    },
    {
      indice: 3, uid: '5', de: 'Banco Digital', enderecoDe: 'naoresponda@banco.com',
      assunto: 'Sua fatura fechou', data: 'Thu, 24 Sep 2026 06:00:00 -0300',
      naoLido: true, messageId: '<d@x>', referencias: '', anexos: [],
      trecho: 'Sua fatura de setembro já está disponível para consulta.',
      acao: 'so_ler', acaoRotulo: 'só ler, sem resposta', urgencia: 1,
      urgenciaRotulo: 'pode esperar', tipo: 'financeiro', tipoRotulo: 'financeiro',
      precisaEscrever: false, probabilidadeEscrever: 0.03, confianca: 0.93, confiavel: true,
    },
    {
      indice: 4, uid: '6', de: 'Rafael Prado', enderecoDe: 'rafael@startup.io',
      assunto: 'Sobre aquilo que conversamos', data: 'Thu, 24 Sep 2026 21:15:00 -0300',
      naoLido: true, messageId: '<e@x>', referencias: '', anexos: [],
      trecho: 'Oi! Fiquei de te mandar os números, mas antes queria entender uma coisa.',
      acao: 'so_ler', acaoRotulo: 'só ler, sem resposta', urgencia: 1,
      urgenciaRotulo: 'pode esperar', tipo: 'lead', tipoRotulo: 'cliente em potencial',
      precisaEscrever: true, probabilidadeEscrever: 0.58, confianca: 0.52, confiavel: false,
    },
    {
      indice: 5, uid: '9', de: 'Suporte Banco Digital', enderecoDe: 'seguranca@banco-alerta.com',
      assunto: 'Sua conta será bloqueada em 24 horas', data: 'Fri, 25 Sep 2026 03:22:00 -0300',
      naoLido: true, messageId: '<f@x>', referencias: '', anexos: [],
      trecho: 'Detectamos um acesso suspeito. Confirme seus dados e senha para evitar o bloqueio.',
      acao: 'descartar', acaoRotulo: 'descartar', urgencia: 2,
      urgenciaRotulo: 'importante', tipo: 'sistema', tipoRotulo: 'aviso automático',
      precisaEscrever: false, probabilidadeEscrever: 0.22, confianca: 0.85, confiavel: true,
      suspeito: true, probabilidadeSuspeito: 0.94,
    },
  ],
  ordenadas: [],
  filaDoDia: [],
  revisar: [],
  daSemana: [],
  ruido: [],
  eventosRelevantes: [],
  porDia: [],
  avisos: [],
  resumo: '',
};
MOCK_TRIAGEM.ordenadas = MOCK_TRIAGEM.mensagens;
MOCK_TRIAGEM.filaDoDia = MOCK_TRIAGEM.mensagens.filter((m) => m.acao === 'responder_agora');
MOCK_TRIAGEM.daSemana = MOCK_TRIAGEM.mensagens.filter((m) => m.acao === 'responder_semana');
MOCK_TRIAGEM.revisar = MOCK_TRIAGEM.mensagens.filter((m) => !m.confiavel);
MOCK_TRIAGEM.suspeitos = MOCK_TRIAGEM.mensagens.filter((m) => m.suspeito);
MOCK_TRIAGEM.eventosIncerto = [
  {
    index: 1, day: 'sex 25/09', time: '17:00-17:30', title: 'Revisão semanal',
    location: '', preparo: 'preparar_material', preparoRotulo: 'preparar material',
    preparoConfiavel: false, essencial: false, probabilidadeEssencial: 0.48, confianca: 0.25,
  },
];
MOCK_TRIAGEM.ruido = Array.from({ length: 6 }, (_, i) => ({
  indice: 10 + i,
  uid: `r${i}`,
  de: ['Substack', 'LinkedIn', 'Loja Online', 'Eventbrite', 'Coursera', 'Duolingo'][i],
  enderecoDe: `news${i}@exemplo.com`,
  assunto: [
    'As 5 leituras da semana',
    'Você apareceu em 12 buscas',
    '50% OFF só hoje',
    'Um evento perto de você',
    'Retome seus estudos',
    'Sua ofensiva está em risco!',
  ][i],
  data: 'Thu, 24 Sep 2026 05:00:00 -0300',
  naoLido: true,
  acao: 'descartar',
  acaoRotulo: 'descartar',
  urgencia: 0,
  urgenciaRotulo: 'ruído',
  tipo: 'propaganda',
  tipoRotulo: 'propaganda',
  precisaEscrever: false,
  confianca: 0.99,
  confiavel: true,
  anexos: [],
}));
MOCK_TRIAGEM.eventosRelevantes = MOCK_TRIAGEM.eventos.filter(
  (e) => e.essencial || e.preparo !== 'nada'
);

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
  /* "Meu dia" com dados plausíveis, para conferir o visual sem Gmail nem JEV. */
  day: {
    info: () => ({
      ok: true,
      credenciais: MOCK_CREDENCIAIS,
      fuso: 'America/Sao_Paulo',
      estatisticas: { chamadas: 12, tokensEntrada: 31240, tokensSaida: 480, custoUSD: 0.001312 },
      modelosJev: ['jev-latest', 'jev-1.13'],
    }),
    eventos: () => ({ ok: true, eventos: MOCK_TRIAGEM.eventos }),
    previa: () => ({
      ok: true,
      resumo:
        '12 mensagem(ns) da caixa de entrada\n' +
        '  • Ana Souza — "Contrato para assinar hoje" (corpo: 812 caracteres)\n' +
        '  • Carlos Mendes — "Podemos remarcar a call?" (corpo: 240 caracteres)\n' +
        '  • Banco — "Sua fatura fechou" (corpo: 1180 caracteres)\n' +
        '  • Substack — "As 5 leituras da semana" (corpo: 3200 caracteres)\n' +
        '3 compromisso(s) na agenda\n' +
        '  • sex 25/09 14:00-15:00 — Reunião com cliente\n' +
        '  • sex 25/09 17:00-17:30 — Revisão semanal\n' +
        '  • sáb 26/09 dia inteiro — Mudança de escritório\n' +
        '41 pergunta(s) tipada(s) — nenhuma resposta é texto livre',
      quantidadePerguntas: 41,
      caracteres: 18430,
      tokensAproximados: 4608,
      custoEstimadoUSD: 0.00019354,
      avisos: [],
      eventos: MOCK_TRIAGEM.eventos,
      mensagens: MOCK_TRIAGEM.mensagens.map((m) => ({
        uid: m.uid,
        de: m.de,
        assunto: m.assunto,
        data: m.data,
        naoLido: m.naoLido,
        temCorpo: true,
        caracteresCorpo: 812,
      })),
    }),
    triar: () => MOCK_TRIAGEM,
    resumo: async (opcoes, onMessage) => {
      onMessage({
        type: 'triagem',
        ms: 287,
        custoUSD: 0.00019,
        contagens: { hoje: 2, semana: 3, incerto: 1, ruido: 6 },
      });
      const texto =
        'Bom dia. Seu dia começa às catorze horas com a reunião com o cliente, ' +
        'e para essa você precisa preparar material. A Ana Souza mandou um ' +
        'contrato que precisa de assinatura hoje, então essa é a primeira coisa. ' +
        'O Carlos quer remarcar a call e pode ficar para a semana. Seis ' +
        'mensagens são propaganda e você pode apagar sem ler. Uma mensagem ' +
        'ficou incerta, então vale a pena dar uma olhada.';
      for (let i = 0; i < texto.length; i += 12) {
        onMessage({ type: 'token', token: texto.slice(i, i + 12), full: texto.slice(0, i + 12) });
        await new Promise((r) => setTimeout(r, 8));
      }
      onMessage({
        type: 'done',
        text: texto,
        stats: { tokens: 96, ms: 41000 },
        triagem: MOCK_TRIAGEM,
      });
    },
    rascunho: async (opcoes, onMessage) => {
      const texto =
        'Oi Ana, tudo bem?\n\n' +
        'Recebi o contrato e já estou revisando. Consigo devolver assinado ' +
        'até o fim da tarde de hoje, sem problema.\n\n' +
        'Qualquer coisa me avise.\n\nAbraço,\nHudson';
      for (let i = 0; i < texto.length; i += 10) {
        onMessage({ type: 'token', token: texto.slice(i, i + 10), full: texto.slice(0, i + 10) });
        await new Promise((r) => setTimeout(r, 15));
      }
      onMessage({ type: 'done', text: texto, stats: { tokens: 78 } });
    },
    enviar: () => ({ ok: true, messageId: '<novo@nino>' }),
    ultima: () => ({ ok: true, triagem: MOCK_TRIAGEM }),
    credenciais: () => ({
      ok: true,
      credenciais: MOCK_CREDENCIAIS,
      jev: { ok: true },
      estatisticas: { chamadas: 12, tokensEntrada: 31240, tokensSaida: 480, custoUSD: 0.001312 },
    }),
    salvarCredenciais: () => ({ ok: true }),
    apagarCredenciais: () => ({ ok: true }),
    googleStatus: () => ({
      ok: true,
      clienteConfigurado: true,
      conectado: false,
      email: 'hudsonrj@gmail.com',
      escopos: '',
      expiraEm: '',
      redirecionamento: 'http://localhost:3099/oauth2callback',
      porta: 3099,
      esperando: false,
      escoposPedidos: [],
      caminhoEmail: 'imap',
      caminhoAgenda: 'ical',
      dicaCliente: '5810••••••.com',
    }),
    googleConectar: () => ({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?exemplo', redirecionamento: 'http://localhost:3099/oauth2callback' }),
    googleCancelar: () => ({ ok: true }),
    googleDesconectar: () => ({ ok: true }),
    googleDiagnostico: () => ({
      ok: false,
      problemas: [
        {
          campo: 'redirecionamento',
          erro: 'O endereço de retorno ainda não está cadastrado neste projeto do Google Cloud.',
          comoResolver: 'Google Cloud Console → APIs e serviços → Credenciais → seu cliente OAuth → "URIs de redirecionamento autorizados" → adicione exatamente http://localhost:3099/oauth2callback',
        },
      ],
      itensOk: ['Cliente OAuth informado (5810••••••.com).'],
      redirecionamento: 'http://localhost:3099/oauth2callback',
      porta: 3099,
      escopos: [],
      avisoSeteDias: 'Enquanto o app estiver com status "Testing" no Google Cloud, o Google expira a autorização em 7 dias. Para não reconectar toda semana, publique o app (tela de consentimento → Publicar aplicativo).',
    }),
    testarJev: async () => ({
      ok: true,
      email: 'Oi, a gente tem uma loja de cosméticos online…',
      respostas: {
        forca_do_lead: {
          valor: 2.99,
          rotulo: 'quente: necessidade clara com orçamento, prazo ou decisor',
          confianca: 0.99,
        },
        tipo: { valor: 'lead_novo', confianca: 0.97 },
        resposta_pessoal: { probabilidade: 0.78 },
      },
      modelo: 'jev-1.13.0',
      ms: 262,
      custoUSD: 0.0000201,
      uso: { tokensEntrada: 478, tokensSaida: 40 },
    }),
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
