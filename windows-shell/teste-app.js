'use strict';

/**
 * Testa o fluxo do aplicativo: microfone (com nível ao vivo) e fala.
 *
 *   node teste-app.js [porta]
 */

const PORT = Number(process.argv[2] || 9333);

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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4000));

  console.log('=== 1. MICROFONE (fluxo do app) ===');
  await avaliar(`
    window.__mic = { estados: [], niveis: [], erros: [], textos: [] };
    window.nino.voice.onAudioState(s => window.__mic.estados.push(JSON.stringify(s)));
    window.nino.voice.onLevel(p => window.__mic.niveis.push(p.rms));
    window.nino.voice.onError(e => window.__mic.erros.push(e.error));
    window.nino.voice.onTranscript(t => window.__mic.textos.push(t.text));
    window.nino.voice.listen();
    'gravando'
  `);

  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = JSON.parse(await avaliar('JSON.stringify(window.__mic.estados)'));
    if (st.some((s) => s.includes('idle') || s.includes('transcribing'))) break;
  }
  await avaliar(`window.nino.voice.stopListening(); 'parado'`);
  await new Promise((r) => setTimeout(r, 3000));

  const mic = JSON.parse(await avaliar('JSON.stringify(window.__mic)'));
  console.log('  estados  :', mic.estados.join(' -> ') || '(nenhum)');
  console.log('  amostras de nível:', mic.niveis.length);
  if (mic.niveis.length) {
    console.log('  nível máximo captado:', Math.max(...mic.niveis).toFixed(4));
  }
  console.log('  erros    :', mic.erros.join(' | ') || '(nenhum)');
  console.log('  textos   :', mic.textos.join(' | ') || '(nenhum)');

  console.log('\n=== 2. FALA (fluxo do app) ===');
  await avaliar(`
    window.__fala = [];
    window.nino.voice.onTtsState(s => window.__fala.push(JSON.stringify(s)));
    window.nino.chat.onDone(d => window.__fala.push('DONE'));
    setOpen(true);
    sendMessage('Responda apenas: teste de voz concluido.');
    'enviado'
  `);

  const limite = Date.now() + 150000;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 2000));
    const f = JSON.parse(await avaliar('JSON.stringify(window.__fala)'));
    if (f.includes('DONE') && f.filter((x) => x.includes('true')).length) break;
    if (f.includes('DONE')) break;
  }
  const fala = JSON.parse(await avaliar('JSON.stringify(window.__fala)'));
  const falou = fala.filter((x) => x.includes('"speaking":true')).length;
  console.log('  ciclos de fala:', falou);
  console.log('  sequência:', fala.join(' -> '));

  console.log('\n=== RESULTADO ===');
  const micOk = mic.niveis.length > 0;
  const falaOk = falou > 0;
  console.log('  microfone captando:', micOk ? 'SIM' : 'NAO');
  console.log('  fala reproduzindo :', falaOk ? 'SIM' : 'NAO');
  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
