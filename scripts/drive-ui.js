'use strict';

/**
 * Dirige a interface real do mascote via CDP (Chrome DevTools Protocol),
 * para validar o fluxo completo sem cliques manuais.
 *
 *   node scripts/drive-ui.js "sua pergunta aqui"
 *
 * Exige o app rodando com --remote-debugging-port=9222.
 */

const HOST = 'http://127.0.0.1:9222';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  const res = await fetch(`${HOST}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('Nenhuma página encontrada no CDP');
  return page;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('falha no WebSocket CDP')), { once: true });
    });
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`tempo esgotado em ${method}`));
        }
      }, 300000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `erro na página: ${res.exceptionDetails.exception && res.exceptionDetails.exception.description}`
      );
    }
    return res.result.value;
  }
}

async function main() {
  const question =
    process.argv.slice(2).filter((a) => !a.startsWith('-'))[0] ||
    'Segundo a base, que formatos de arquivo o mascote aceita?';

  const page = await findPage();
  console.log(`página: ${page.title} (${page.url.split('/').pop()})`);

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  console.log('\n--- estado da interface ---');
  const before = await cdp.eval(`JSON.stringify({
    status: document.getElementById('statusText').textContent,
    kb: document.getElementById('kbStats').textContent,
    orfaos: document.querySelectorAll('.msg').length,
  })`);
  console.log(before);

  console.log(`\n--- enviando: "${question}" ---`);
  const t0 = Date.now();
  await cdp.eval(`
    (() => {
      setOpen(true);
      const input = document.getElementById('input');
      input.value = ${JSON.stringify(question)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()
  `);

  // Acompanha o streaming lendo o DOM.
  let last = '';
  let firstTokenAt = null;
  let done = false;
  const deadline = Date.now() + 240000;

  while (Date.now() < deadline) {
    const state = await cdp.eval(`
      (() => {
        const bots = document.querySelectorAll('.msg.bot');
        const el = bots[bots.length - 1];
        const send = document.getElementById('btnSend').textContent;
        const src = document.getElementById('sources');
        return JSON.stringify({
          text: el ? el.textContent : '',
          typing: el ? el.innerHTML.includes('typing') : false,
          sendLabel: send,
          sources: src.classList.contains('hidden') ? '' : src.textContent.trim(),
          status: document.getElementById('statusText').textContent,
        });
      })()
    `);
    const parsed = JSON.parse(state);

    if (parsed.text && firstTokenAt === null && !parsed.typing) {
      firstTokenAt = Date.now() - t0;
      console.log(`(primeiro token em ${(firstTokenAt / 1000).toFixed(1)}s)`);
    }
    if (parsed.text !== last && parsed.text) {
      process.stdout.write(`\r  ${parsed.text.slice(-90).replace(/\s+/g, ' ')}`);
      last = parsed.text;
    }
    if (parsed.sendLabel.trim() === '➤' && parsed.text && !parsed.typing) {
      done = true;
      console.log('\n');
      console.log(`--- resposta final (${((Date.now() - t0) / 1000).toFixed(1)}s) ---`);
      console.log(parsed.text);
      console.log('\n--- fontes citadas ---');
      console.log(parsed.sources || '(nenhuma)');
      console.log('\n--- status ---');
      console.log(parsed.status);
      break;
    }
    await wait(700);
  }

  if (!done) console.log('\n(a resposta não terminou dentro do prazo)');

  // Deixa a voz terminar antes de sair.
  await wait(6000);
  const speaking = await cdp.eval(`document.getElementById('mascot').classList.contains('speaking')`);
  console.log(`\nmascote falando no fim: ${speaking}`);
  process.exit(done ? 0 : 1);
}

main().catch((err) => {
  console.error('FALHOU:', err.message);
  process.exit(1);
});
