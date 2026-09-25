'use strict';

/**
 * Testa o fluxo de visão dentro do shell: captura (tela ou câmera),
 * envio e análise pelo modelo.
 *
 *   node teste-visao.js [porta] [screen|camera]
 */

const PORT = Number(process.argv[2] || 9333);
const MODO = process.argv[3] === 'camera' ? 'camera' : 'screen';

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      const onMsg = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === myId) {
          ws.removeEventListener('message', onMsg);
          resolve(m.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  const avaliar = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 5000));

  console.log(`=== VISÃO: ${MODO} ===`);
  const disp = await avaliar('(async () => JSON.stringify(await window.nino.vision.available()))()');
  console.log('  disponibilidade:', disp);

  console.log('  capturando e enviando…');
  const t0 = Date.now();
  await avaliar(`
    window.__v = { tokens: 0, texto: '', estados: [], erros: [] };
    window.nino.voice.onTtsState(s => window.__v.estados.push(JSON.stringify(s)));
    window.nino.chat.onToken(p => { window.__v.tokens++; window.__v.texto = p.full; });
    window.nino.chat.onDone(d => { window.__v.done = (d.text||'').slice(0,600); });
    window.nino.chat.onError(e => window.__v.erros.push(e.error));
    window.nino.vision.onState(s => window.__v.visao = JSON.stringify(s));
    window.nino.vision.capture('${MODO}');
    'iniciado'
  `);

  const limite = Date.now() + 300000;
  let ultimo = 0;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = JSON.parse(await avaliar('JSON.stringify({t:window.__v.tokens, d:!!window.__v.done, e:window.__v.erros, v:window.__v.visao||""})'));
    if (st.t !== ultimo) {
      ultimo = st.t;
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s — ${st.t} tokens ${st.v}`);
    }
    if (st.d || (st.e && st.e.length)) break;
  }

  const v = JSON.parse(await avaliar('JSON.stringify(window.__v)'));
  console.log(`\n  tempo total : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  tokens      : ${v.tokens}`);
  console.log(`  erros       : ${(v.erros || []).join(' | ') || '(nenhum)'}`);
  console.log(`  ciclos fala : ${(v.estados || []).filter((x) => x.includes('true')).length}`);
  console.log('\n  --- o que ele disse ---');
  console.log(' ', (v.done || v.texto || '(vazio)').replace(/\n/g, '\n  '));

  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
