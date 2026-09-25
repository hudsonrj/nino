'use strict';

/**
 * Lista as saídas de áudio e toca um teste em uma delas.
 *
 *   node teste-saida.js [porta] [trecho-do-nome]
 *
 * Sem o trecho, apenas lista as saídas disponíveis.
 */

const PORT = Number(process.argv[2] || 9333);
const FILTRO = (process.argv[3] || '').toLowerCase();

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

  const saidas = JSON.parse(await avaliar('(async () => JSON.stringify(await window.nino.voice.outputs()))()'));
  console.log('SAÍDAS DISPONÍVEIS:');
  saidas.forEach((s, i) => console.log(`  [${i}] ${s.label}`));
  console.log('  saída atual:', await avaliar('JSON.stringify(window.nino.voice.currentOutput())'));

  if (!FILTRO) {
    ws.close();
    return;
  }

  const alvo = saidas.find((s) => s.label.toLowerCase().includes(FILTRO));
  if (!alvo) {
    console.log(`\nnada corresponde a "${FILTRO}"`);
    ws.close();
    return;
  }

  console.log(`\nTROCANDO para: ${alvo.label}`);
  const r = await avaliar(`(async () => JSON.stringify(await window.nino.voice.setOutput(${JSON.stringify(alvo.id)})))()`);
  console.log('  resultado:', r);

  await new Promise((res) => setTimeout(res, 3000));
  console.log('  tocou um aviso curto nessa saída');

  console.log('\nTOQUE DE TESTE (5 s)…');
  await avaliar(`window.nino.voice.test(); 'ok'`);
  await new Promise((res) => setTimeout(res, 6000));
  console.log('  concluído');

  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
