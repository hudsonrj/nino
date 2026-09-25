'use strict';

/**
 * Testa a reprodução de áudio em cada dispositivo de saída e o caminho
 * completo do microfone (gravacao -> upload -> transcricao).
 *
 *   node diag-audio2.js [porta]
 */

const PORT = Number(process.argv[2] || 9333);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('nenhuma página no CDP');

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

  await send('Runtime.enable');

  const expr = `(async () => {
    const linhas = [];

    // Pega um WAV do servidor uma única vez.
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Um, dois, tres, testando a saida de audio.' }),
    });
    const blob = await res.blob();
    linhas.push('WAV recebido: ' + blob.size + ' bytes');

    const saidas = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audiooutput');

    // Tenta tocar em cada saida, medindo se o tempo avanca de verdade.
    for (const dev of saidas) {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      let erro = null;
      a.addEventListener('error', () => { erro = 'evento error'; });
      if (a.setSinkId) {
        try { await a.setSinkId(dev.deviceId); }
        catch (e) { erro = 'setSinkId: ' + e.name; }
      }
      if (erro) { linhas.push('  ' + dev.label + ' -> ' + erro); URL.revokeObjectURL(url); continue; }
      try {
        await a.play();
        await new Promise(r => setTimeout(r, 1500));
        const avancou = a.currentTime;
        a.pause();
        linhas.push('  ' + dev.label + ' -> currentTime apos 1,5s = ' + avancou.toFixed(2) + 's' +
                    (avancou > 0.5 ? '  AVANCOU' : '  TRAVADO'));
      } catch (e) {
        linhas.push('  ' + dev.label + ' -> play falhou: ' + e.name);
      }
      URL.revokeObjectURL(url);
    }

    // Contexto de audio: mede se o relogio anda.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime;
    await new Promise(r => setTimeout(r, 1000));
    linhas.push('AudioContext: estado=' + ctx.state + ' relogio avancou ' + (ctx.currentTime - t0).toFixed(2) + 's');
    await ctx.close();

    return linhas.join('\\n');
  })()`;

  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });

  if (res.exceptionDetails) {
    console.error('erro:', JSON.stringify(res.exceptionDetails).slice(0, 400));
  } else {
    console.log(res.result.value);
  }
  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
