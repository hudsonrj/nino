'use strict';

/**
 * Teste ponta a ponta sem interface gráfica:
 * extração -> chunking -> embeddings -> busca -> conversa com RAG -> voz -> transcrição.
 *
 * Uso:
 *   node scripts/smoke-test.js                 # corpus pequeno (rápido)
 *   node scripts/smoke-test.js --book <arq>    # inclui um livro inteiro
 *   node scripts/smoke-test.js --clear         # esvazia a base antes
 */

const path = require('path');
const fs = require('fs');

const kb = require('../src/main/kb');
const ollama = require('../src/main/ollama');
const config = require('../src/main/config');
const { extractText } = require('../src/main/ingest/extract');
const tts = require('../src/main/tts');
const stt = require('../src/main/stt');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const log = (...a) => console.log(...a);
const rule = (t) => log(`\n${'='.repeat(66)}\n${t}\n${'='.repeat(66)}`);

async function main() {
  config.ensureDirs();

  rule('1. Ambiente');
  const alive = await ollama.ping();
  log('Ollama:', alive ? 'online' : 'OFFLINE');
  if (!alive) {
    log('Inicie o Ollama antes de rodar o teste.');
    process.exit(1);
  }
  const settings = config.loadSettings();
  log('modelo de conversa :', settings.model);
  log('modelo de embedding:', settings.embedModel);
  log('voz                :', settings.voice);
  log('pasta de dados     :', config.DATA_DIR);

  if (flag('--clear')) {
    await kb.clear();
    log('base esvaziada');
  }

  /* ---------------------------------------------------------------- */
  rule('2. Preparando corpus de teste');

  const tmp = '/tmp/nino-corpus';
  fs.mkdirSync(tmp, { recursive: true });

  const files = [];

  // Trecho real de um livro em português, vindo do EPUB do Gutenberg.
  const epubPath = value('--book') || '/tmp/nino-docs/livro-55752.epub';
  if (fs.existsSync(epubPath)) {
    const { text } = await extractText(epubPath);
    const slice = flag('--full') ? text : text.slice(0, 24000);
    const out = path.join(tmp, 'dom-casmurro-trecho.txt');
    fs.writeFileSync(out, slice, 'utf8');
    files.push(out);
    log(`livro: ${path.basename(epubPath)} -> ${slice.length} chars`);
  } else {
    log(`aviso: ${epubPath} não encontrado; seguindo sem o livro`);
  }

  const notas = path.join(tmp, 'notas-do-projeto.md');
  fs.writeFileSync(
    notas,
    `# Notas do projeto Nino

## Visão geral
O Nino é um mascote flutuante que fica sempre no topo das janelas do sistema.
Ele responde por texto e por voz, usando o motor Piper para sintetizar
fala em português do Brasil.

## Base de conhecimento
A base aceita PDF, EPUB, DOCX, ODT, TXT, Markdown e HTML. Os documentos são
divididos em trechos, convertidos em vetores pelo modelo bge-m3 e guardados
localmente na pasta de dados. Nada sai da máquina do usuário.

## Voz
O microfone grava pelo PulseAudio e a transcrição é feita com o Whisper
rodando localmente. A tecla de atalho Control+Alt+N mostra ou esconde o mascote.

## Limitação conhecida
Em computadores sem placa de vídeo, indexar um livro inteiro pode levar
vários minutos, porque os embeddings rodam na CPU.
`,
    'utf8'
  );
  files.push(notas);

  const receita = path.join(tmp, 'receita-bolo.md');
  fs.writeFileSync(
    receita,
    `# Bolo de fubá simples

Ingredientes: 3 ovos, 2 xícaras de açúcar, 1 xícara de óleo, 2 xícaras de
fubá, 1 xícara de farinha de trigo, 1 colher de sopa de fermento e 1 copo
de leite.

Modo de preparo: bata os ovos, o açúcar e o óleo no liquidificador. Acrescente
o leite e bata mais. Despeje numa tigela, adicione o fubá, a farinha e o
fermento. Mexa com colher. Asse em forno preaquecido a 180 graus por cerca
de quarenta minutos, até dourar.

Dica: polvilhe açúcar com canela por cima antes de servir.
`,
    'utf8'
  );
  files.push(receita);

  log('arquivos:', files.map((f) => path.basename(f)).join(', '));

  /* ---------------------------------------------------------------- */
  rule('3. Ingestão (extração -> chunks -> embeddings)');

  const t0 = Date.now();
  const report = await kb.addPaths(files, (p) => {
    if (p.stage === 'indexando') {
      process.stdout.write(`\r  ${p.file}: ${p.done}/${p.total} trechos   `);
    }
  });
  process.stdout.write('\r');
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  for (const r of report) {
    if (r.skipped) log(`  ignorado: ${r.file} (${r.reason})`);
    else if (!r.ok) log(`  FALHOU: ${r.file} -> ${r.error}`);
    else log(`  ${r.file}: ${r.chunks} trechos, ${r.chars} chars`);
  }
  const stats = kb.stats();
  log(`  total: ${stats.documents} documentos, ${stats.chunks} trechos em ${elapsed}s`);

  /* ---------------------------------------------------------------- */
  rule('4. Busca semântica');

  const queries = [
    'Quem é o Bentinho e com quem ele se casou?',
    'Como faço para instalar e abrir o mascote?',
    'Qual é o tempo de forno do bolo de fubá?',
    'Que formatos de arquivo a base de conhecimento aceita?',
  ];

  for (const q of queries) {
    const hits = await kb.search(q, { topK: 3, minScore: 0 });
    log(`\n  pergunta: ${q}`);
    if (!hits.length) {
      log('    (nenhum trecho)');
      continue;
    }
    for (const h of hits) {
      const preview = h.text.replace(/\s+/g, ' ').slice(0, 110);
      log(`    ${(h.score * 100).toFixed(1)}%  ${h.docName}  "${preview}…"`);
    }
  }

  /* ---------------------------------------------------------------- */
  rule('5. Conversa com RAG');

  const question = value('--ask') || 'O que a base diz sobre a base de conhecimento do Nino?';
  const { context, sources } = await kb.buildContext(question, { topK: 4, minScore: 0.3 });
  log(`  pergunta: ${question}`);
  log(`  trechos recuperados: ${sources.length}`);

  const system =
    config.loadSettings().systemPrompt +
    (context
      ? `\n\n--- BASE DE CONHECIMENTO ---\n${context}\n--- FIM ---`
      : '\n\n(A base não retornou trechos.)');

  const t1 = Date.now();
  let firstTokenAt = null;
  const threads = config.loadSettings().numThread > 0
    ? config.loadSettings().numThread
    : config.autoThreads();
  log(`  threads de inferência: ${threads}`);
  const { text, stats: runStats } = await ollama.chatStream({
    model: config.loadSettings().model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ],
    options: { num_predict: 300, num_thread: threads },
    onToken: (tok) => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      process.stdout.write(tok);
    },
  });
  log('');
  log(
    `\n  primeiro token: ${firstTokenAt ? ((firstTokenAt - t1) / 1000).toFixed(1) : '?'}s` +
      ` | total: ${((Date.now() - t1) / 1000).toFixed(1)}s` +
      ` | ${runStats.evalCount || '?'} tokens` +
      ` (${runStats.evalCount ? (runStats.evalCount / ((runStats.evalDurationMs || 1) / 1000)).toFixed(1) : '?'} tok/s)`
  );

  /* ---------------------------------------------------------------- */
  rule('6. Voz (Piper -> PulseAudio)');

  const speech = text.replace(/\s+/g, ' ').slice(0, 220);
  log(`  falando: "${speech}…"`);
  const t2 = Date.now();
  await tts.speak(speech);
  log(`  reprodução concluída em ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  /* ---------------------------------------------------------------- */
  rule('7. Transcrição (Whisper local)');

  const wav = path.join(config.AUDIO_DIR, 'teste-transcricao.wav');
  if (fs.existsSync(wav)) {
    const t3 = Date.now();
    try {
      const res = await stt.transcribe(wav);
      log(`  áudio: ${path.basename(wav)}`);
      log(`  texto: "${res.text}"`);
      log(`  idioma: ${res.language} | duração: ${res.duration}s | ${((Date.now() - t3) / 1000).toFixed(1)}s`);
    } catch (err) {
      log('  falhou:', err.message);
    }
  } else {
    log(`  (sem áudio de teste em ${wav}; use o microfone no app)`);
  }
  stt.stopWhisper();

  rule('Concluído');
  log(`  base final: ${JSON.stringify(kb.stats())}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFALHOU:', err);
  process.exit(1);
});
