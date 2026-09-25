'use strict';

/**
 * Base de conhecimento local.
 *
 * Pipeline: arquivo -> texto -> chunks -> embeddings (Ollama) -> índice JSON.
 * Busca: similaridade de cosseno (produto escalar com vetores normalizados).
 *
 * Os vetores são guardados como base64 de Float32Array para manter o índice
 * compacto e o carregamento rápido.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { KB_DIR, loadSettings } = require('./config');
const { embed } = require('./ollama');
const { extractText } = require('./ingest/extract');

const INDEX_FILE = path.join(KB_DIR, 'index.json');
const EMBED_BATCH = 8;
// Trechos menores: recuperação mais precisa e prompts bem mais curtos.
// Em CPU, o custo dominante é o prompt eval (~25 tok/s), então contexto
// enxuto é o que mais reduz a espera até a primeira palavra.
const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 150;

let state = { version: 1, embedModel: null, dim: 0, documents: [], chunks: [] };
let loaded = false;

/* ------------------------------------------------------------------ */
/* Vetores                                                             */
/* ------------------------------------------------------------------ */

function vecToB64(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function b64ToVec(b64) {
  const buf = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

function normalizeInPlace(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i += 1) sum += f32[i] * f32[i];
  const norm = Math.sqrt(sum);
  if (norm > 1e-9) {
    for (let i = 0; i < f32.length; i += 1) f32[i] /= norm;
  }
  return f32;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

function splitSentences(paragraph) {
  return paragraph
    .split(/(?<=[.!?…])\s+(?=[A-ZÀ-Þ0-9"«(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Divide o texto em blocos de ~size caracteres, com sobreposição.
 * @param {string} text
 * @param {{size?:number, overlap?:number}} [opts]
 * @returns {string[]}
 */
function chunkText(text, opts = {}) {
  const size = opts.size || CHUNK_SIZE;
  const overlap = opts.overlap != null ? opts.overlap : CHUNK_OVERLAP;

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  // 1. Quebra em unidades que caibam em `size`.
  const units = [];
  for (const p of paragraphs) {
    if (p.length <= size) {
      units.push(p);
      continue;
    }
    let buf = '';
    for (const s of splitSentences(p)) {
      if (s.length > size) {
        if (buf) {
          units.push(buf);
          buf = '';
        }
        for (let i = 0; i < s.length; i += size) units.push(s.slice(i, i + size));
        continue;
      }
      const candidate = buf ? `${buf} ${s}` : s;
      if (candidate.length > size) {
        units.push(buf);
        buf = s;
      } else {
        buf = candidate;
      }
    }
    if (buf) units.push(buf);
  }

  // 2. Empacota as unidades em chunks com sobreposição.
  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (!cur) {
      cur = u;
      continue;
    }
    if (`${cur}\n\n${u}`.length <= size) {
      cur = `${cur}\n\n${u}`;
    } else {
      chunks.push(cur);
      const tail = overlap > 0 ? cur.slice(-overlap) : '';
      cur = tail ? `${tail}\n\n${u}` : u;
    }
  }
  if (cur.trim()) chunks.push(cur);

  return chunks.map((c) => c.trim()).filter((c) => c.length >= 20);
}

/* ------------------------------------------------------------------ */
/* Persistência                                                        */
/* ------------------------------------------------------------------ */

function load() {
  if (loaded) return state;
  fs.mkdirSync(KB_DIR, { recursive: true });
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      state = {
        version: raw.version || 1,
        embedModel: raw.embedModel || null,
        dim: raw.dim || 0,
        documents: raw.documents || [],
        chunks: (raw.chunks || []).map((c) => ({ ...c, vec: b64ToVec(c.vec) })),
      };
    } catch (err) {
      // Índice corrompido: começa do zero em vez de derrubar o app.
      const backup = `${INDEX_FILE}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(INDEX_FILE, backup);
      } catch {
        /* ignora */
      }
      state = { version: 1, embedModel: null, dim: 0, documents: [], chunks: [] };
      console.error(`[kb] índice corrompido, movido para ${backup}:`, err.message);
    }
  }
  loaded = true;
  return state;
}

async function save() {
  fs.mkdirSync(KB_DIR, { recursive: true });
  const out = {
    version: state.version,
    embedModel: state.embedModel,
    dim: state.dim,
    documents: state.documents,
    chunks: state.chunks.map((c) => ({
      id: c.id,
      docId: c.docId,
      docName: c.docName,
      ord: c.ord,
      text: c.text,
      vec: vecToB64(c.vec),
    })),
  };
  const tmp = `${INDEX_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(out), 'utf8');
  await fsp.rename(tmp, INDEX_FILE);
}

/* ------------------------------------------------------------------ */
/* Ingestão                                                            */
/* ------------------------------------------------------------------ */

function assertModelCompatible(model) {
  if (state.embedModel && state.embedModel !== model && state.chunks.length > 0) {
    throw new Error(
      `A base já foi indexada com "${state.embedModel}" e você está usando "${model}". ` +
        `Use o mesmo modelo ou limpe a base de conhecimento.`
    );
  }
}

/**
 * @param {string[]} filePaths
 * @param {(p:object)=>void} [onProgress]
 * @returns {Promise<Array<object>>} relatório por arquivo
 */
async function addPaths(filePaths, onProgress = () => {}) {
  load();
  const settings = loadSettings();
  const model = settings.embedModel;
  assertModelCompatible(model);

  const report = [];

  for (const filePath of filePaths) {
    const name = path.basename(filePath);
    try {
      onProgress({ stage: 'lendo', file: name, done: 0, total: 1 });

      const { text, meta, ext, bytes } = await extractText(filePath);
      const hash = crypto.createHash('sha256').update(text).digest('hex');

      // Um documento que ficou pela metade numa queda anterior não conta como
      // duplicata: refazer a indexação é o comportamento desejado.
      const duplicate = state.documents.find((d) => d.hash === hash && d.complete !== false);
      if (duplicate) {
        report.push({ file: name, ok: true, skipped: true, reason: `já está na base como "${duplicate.name}"` });
        continue;
      }

      const chunks = chunkText(text);
      if (!chunks.length) throw new Error('Não foi possível dividir o texto em trechos úteis');

      const docId = crypto.randomUUID();
      onProgress({ stage: 'indexando', file: name, done: 0, total: chunks.length });

      // Remove versão anterior com o mesmo nome (re-upload do mesmo arquivo).
      const previous = state.documents.filter((d) => d.name === name);
      for (const prev of previous) removeDocumentSync(prev.id);

      const doc = {
        id: docId,
        name,
        ext,
        bytes,
        chars: text.length,
        chunkCount: 0,
        addedAt: new Date().toISOString(),
        hash,
        title: meta.title || null,
        author: meta.author || null,
        pages: meta.pages || null,
        sourcePath: filePath,
        // Enquanto for false, a indexação está em andamento. Se o processo cair
        // no meio, o documento fica marcado como incompleto e pode ser refeito.
        complete: false,
      };
      state.documents.push(doc);

      let inseridos = 0;
      let desdeUltimoSave = 0;

      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const embedded = await embed(batch, model);

        embedded.forEach((vec, k) => {
          state.chunks.push({
            id: `${docId}:${i + k}`,
            docId,
            docName: name,
            ord: i + k,
            text: batch[k],
            vec: normalizeInPlace(Float32Array.from(vec)),
          });
        });
        inseridos += batch.length;
        doc.chunkCount = inseridos;

        if (!state.embedModel) state.embedModel = model;
        state.dim = embedded[0] ? embedded[0].length : state.dim;

        onProgress({
          stage: 'indexando',
          file: name,
          done: inseridos,
          total: chunks.length,
        });

        // Um livro leva dezenas de minutos para indexar. Salvar no caminho
        // evita perder tudo se o processo for interrompido.
        desdeUltimoSave += batch.length;
        if (desdeUltimoSave >= 64) {
          await save();
          desdeUltimoSave = 0;
        }
      }

      doc.chunkCount = chunks.length;
      doc.complete = true;
      await save();
      report.push({ file: name, ok: true, chunks: chunks.length, chars: text.length, docId });
      onProgress({ stage: 'concluído', file: name, done: chunks.length, total: chunks.length });
    } catch (err) {
      report.push({ file: name, ok: false, error: err.message });
      onProgress({ stage: 'erro', file: name, error: err.message, done: 0, total: 1 });
    }
  }

  return report;
}

/* ------------------------------------------------------------------ */
/* Consulta                                                            */
/* ------------------------------------------------------------------ */

function searchWithVector(queryVec, { topK = 5, minScore = 0.3 } = {}) {
  load();
  const q = normalizeInPlace(Float32Array.from(queryVec));
  const scored = [];
  for (const c of state.chunks) {
    scored.push({ score: dot(q, c.vec), chunk: c });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.max(topK * 3, topK));

  const good = top.filter((s) => s.score >= minScore).slice(0, topK);
  // Se nada passou do corte, só devolve o melhor trecho se ele ainda tiver
  // alguma semelhança real — caso contrário é melhor não injetar nada.
  const HARD_FLOOR = 0.15;
  const chosen = good.length ? good : top.filter((s) => s.score >= HARD_FLOOR).slice(0, 1);

  return chosen.map((s) => ({
    score: Number(s.score.toFixed(4)),
    text: s.chunk.text,
    docName: s.chunk.docName,
    docId: s.chunk.docId,
    ord: s.chunk.ord,
  }));
}

/**
 * Busca semântica.
 * @param {string} query
 * @param {{topK?:number, minScore?:number}} [opts]
 */
async function search(query, opts = {}) {
  load();
  if (!state.chunks.length) return [];
  const settings = loadSettings();
  const model = settings.embedModel;
  assertModelCompatible(model);
  const [queryVec] = await embed([query], model);
  return searchWithVector(queryVec, opts);
}

/**
 * Monta o bloco de contexto para injetar no prompt.
 * @returns {Promise<{context:string, sources:Array<object>}>}
 */
async function buildContext(query, opts = {}) {
  const maxSnippet = opts.maxSnippet || 550;
  const hits = await search(query, opts);
  if (!hits.length) return { context: '', sources: [] };

  const context = hits
    .map((h, i) => {
      let snippet = h.text;
      if (snippet.length > maxSnippet) snippet = `${snippet.slice(0, maxSnippet).trim()}…`;
      return `[Trecho ${i + 1} — ${h.docName}]\n${snippet}`;
    })
    .join('\n\n');

  const sources = hits.map((h) => ({ docName: h.docName, score: h.score, ord: h.ord }));
  return { context, sources };
}

/* ------------------------------------------------------------------ */
/* Administração                                                       */
/* ------------------------------------------------------------------ */

function removeDocumentSync(docId) {
  state.documents = state.documents.filter((d) => d.id !== docId);
  state.chunks = state.chunks.filter((c) => c.docId !== docId);
  if (!state.chunks.length) {
    state.embedModel = null;
    state.dim = 0;
  }
}

async function removeDocument(docId) {
  load();
  const before = state.documents.length;
  removeDocumentSync(docId);
  await save();
  return before !== state.documents.length;
}

async function clear() {
  load();
  state.documents = [];
  state.chunks = [];
  state.embedModel = null;
  state.dim = 0;
  await save();
}

function listDocuments() {
  load();
  return state.documents.map((d) => ({ ...d }));
}

function stats() {
  load();
  return {
    documents: state.documents.length,
    chunks: state.chunks.length,
    chars: state.documents.reduce((s, d) => s + (d.chars || 0), 0),
    embedModel: state.embedModel,
    dim: state.dim,
  };
}

module.exports = {
  load,
  save,
  addPaths,
  search,
  buildContext,
  listDocuments,
  removeDocument,
  clear,
  stats,
  chunkText,
};
