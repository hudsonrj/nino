'use strict';

/**
 * Extração de texto de documentos.
 * Suporta: PDF, EPUB, DOCX, ODT, TXT, MD, HTML, RTF, CSV, JSON e código-fonte.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const AdmZip = require('adm-zip');
const cheerio = require('cheerio');

const SUPPORTED_EXTENSIONS = [
  'pdf', 'epub', 'docx', 'odt', 'txt', 'md', 'markdown', 'rst',
  'html', 'htm', 'xhtml', 'rtf', 'csv', 'tsv', 'json', 'xml',
  'yaml', 'yml', 'log', 'ini', 'conf', 'tex', 'srt', 'vtt',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'go', 'rs', 'sh', 'sql',
];

const PLAIN_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
  'log', 'ini', 'conf', 'tex', 'srt', 'vtt', 'js', 'ts', 'py', 'java', 'c',
  'cpp', 'h', 'cs', 'rb', 'go', 'rs', 'sh', 'sql',
]);

/* ------------------------------------------------------------------ */
/* Normalização                                                        */
/* ------------------------------------------------------------------ */

function normalizeText(raw) {
  if (!raw) return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u00ad/g, '')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function htmlToText(html) {
  const $ = cheerio.load(html, null, false);
  $('script, style, noscript, svg, head, nav, footer, iframe').remove();
  const blockSelector =
    'p, div, br, li, tr, h1, h2, h3, h4, h5, h6, section, article, blockquote, pre, figure, figcaption, dd, dt';
  $(blockSelector).each((_, el) => {
    $(el).append('\n');
  });
  const text = $.root().text();
  return normalizeText(text);
}

function stripRtf(rtf) {
  const decoded = rtf
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, code) => String.fromCharCode(((parseInt(code, 10) % 65536) + 65536) % 65536));
  return normalizeText(
    decoded
      .replace(/\{\\\*[^{}]*\}/g, ' ')
      .replace(/\\par[d]?\b/g, '\n')
      .replace(/\\line\b/g, '\n')
      .replace(/\\[a-zA-Z]+-?\d*\s?/g, ' ')
      .replace(/[{}]/g, ' ')
  );
}

/* ------------------------------------------------------------------ */
/* Formatos específicos                                                */
/* ------------------------------------------------------------------ */

async function extractPdf(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fsp.readFile(filePath));

  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  const pages = [];
  for (let i = 1; i <= numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY = null;
    let out = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) out += '\n';
      out += item.str;
      if (item.hasEOL) out += '\n';
      lastY = y;
    }
    pages.push(normalizeText(out));
    page.cleanup();
  }
  const info = await doc.getMetadata().catch(() => null);
  const title = info && info.info ? info.info.Title : undefined;

  // A API de limpeza mudou entre versões do pdfjs.
  if (typeof loadingTask.destroy === 'function') await loadingTask.destroy();
  else if (typeof doc.destroy === 'function') await doc.destroy();

  return { text: pages.filter(Boolean).join('\n\n'), meta: { pages: numPages, title } };
}

async function extractEpub(filePath) {
  const zip = new AdmZip(filePath);
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) throw new Error('EPUB inválido: META-INF/container.xml ausente');
  const container = cheerio.load(containerEntry.getData().toString('utf8'), { xmlMode: true });
  const opfPath = container('rootfile').attr('full-path');
  if (!opfPath) throw new Error('EPUB inválido: rootfile ausente');

  const opfDir = path.posix.dirname(opfPath);
  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB inválido: ${opfPath} ausente`);
  const opf = cheerio.load(opfEntry.getData().toString('utf8'), { xmlMode: true });

  const manifest = {};
  opf('manifest > item').each((_, el) => {
    const $el = opf(el);
    manifest[$el.attr('id')] = $el.attr('href');
  });

  const title = opf('metadata title').first().text().trim() || undefined;
  const author = opf('metadata creator').first().text().trim() || undefined;

  const spine = [];
  opf('spine > itemref').each((_, el) => {
    const idref = opf(el).attr('idref');
    if (idref && manifest[idref]) spine.push(manifest[idref]);
  });

  const parts = [];
  for (const href of spine) {
    const clean = decodeURIComponent(href.split('#')[0]);
    const full = opfDir === '.' ? clean : path.posix.join(opfDir, clean);
    const entry = zip.getEntry(full) || zip.getEntry(clean);
    if (!entry) continue;
    const chapter = htmlToText(entry.getData().toString('utf8'));
    if (chapter) parts.push(chapter);
  }

  return { text: parts.join('\n\n'), meta: { title, author, chapters: parts.length } };
}

async function extractDocx(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return { text: normalizeText(result.value), meta: { messages: result.messages.length } };
}

async function extractOdt(filePath) {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry('content.xml');
  if (!entry) throw new Error('ODT inválido: content.xml ausente');
  // O parser HTML não conhece as tags namespaced do ODF; normaliza antes.
  const xml = entry
    .getData()
    .toString('utf8')
    .replace(/<(text:p|text:h|text:list-item)\b[^>]*>/gi, '<p>')
    .replace(/<\/(text:p|text:h|text:list-item)>/gi, '</p>')
    .replace(/<text:s\b[^>]*\/?>/gi, ' ')
    .replace(/<text:line-break\b[^>]*\/?>/gi, '<br>');
  return { text: htmlToText(xml), meta: {} };
}

/* ------------------------------------------------------------------ */
/* API principal                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {string} filePath
 * @returns {Promise<{text:string, meta:object, ext:string, bytes:number}>}
 */
async function extractText(filePath) {
  const stat = await fsp.stat(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  let out;

  if (ext === 'pdf') out = await extractPdf(filePath);
  else if (ext === 'epub') out = await extractEpub(filePath);
  else if (ext === 'docx') out = await extractDocx(filePath);
  else if (ext === 'odt') out = await extractOdt(filePath);
  else if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    out = { text: htmlToText(await fsp.readFile(filePath, 'utf8')), meta: {} };
  } else if (ext === 'rtf') {
    out = { text: stripRtf(await fsp.readFile(filePath, 'utf8')), meta: {} };
  } else if (PLAIN_TEXT_EXTENSIONS.has(ext) || !ext) {
    const raw = await fsp.readFile(filePath, 'utf8');
    // Heurística: arquivo binário disfarçado de texto.
    const suspicious = (raw.match(/\u0000/g) || []).length;
    if (suspicious > 4) throw new Error('Arquivo binário não suportado');
    out = { text: normalizeText(raw), meta: {} };
  } else {
    throw new Error(
      `Formato ".${ext}" não suportado. Suportados: ${SUPPORTED_EXTENSIONS.join(', ')}`
    );
  }

  const text = normalizeText(out.text || '');
  if (!text) throw new Error('Nenhum texto extraído (documento vazio ou digitalizado sem OCR)');

  return { text, meta: out.meta || {}, ext, bytes: stat.size };
}

module.exports = { extractText, normalizeText, htmlToText, SUPPORTED_EXTENSIONS };
