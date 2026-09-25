'use strict';

/**
 * Diagnóstico de áudio e microfone dentro da janela do shell.
 *
 *   node diag-av.js [porta]
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

  const expressao = `(async () => {
    const out = {};

    // ---------- 1. Dispositivos de áudio ----------
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      out.dispositivos = devs.map(d => d.kind + ':' + (d.label || '(sem rótulo)'));
      out.temMicrofone = devs.some(d => d.kind === 'audioinput');
      out.temSaida = devs.some(d => d.kind === 'audiooutput');
    } catch (e) { out.erroDispositivos = String(e); }

    // ---------- 2. Microfone ----------
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const faixas = stream.getAudioTracks().map(t => t.label + ' | ativo=' + t.enabled + ' | estado=' + t.readyState);
      out.microfone = 'OK: ' + JSON.stringify(faixas);
      stream.getTracks().forEach(t => t.stop());
    } catch (e) {
      out.microfone = 'FALHOU: ' + e.name + ' — ' + e.message;
    }

    // ---------- 3. Fala (Piper no servidor) ----------
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Teste de audio dentro do shell.' }),
      });
      out.ttsHttp = res.status;
      const blob = await res.blob();
      out.ttsBytes = blob.size;
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.volume = 1;
      out.ttsPronto = a.readyState;
      try {
        await a.play();
        out.ttsPlay = 'OK — tocando (paused=' + a.paused + ')';
        await new Promise(r => setTimeout(r, 1200));
        out.ttsDepois = 'currentTime=' + a.currentTime.toFixed(2) + ' paused=' + a.paused;
        a.pause();
      } catch (e) {
        out.ttsPlay = 'BLOQUEADO: ' + e.name + ' — ' + e.message;
      }
      URL.revokeObjectURL(url);
    } catch (e) { out.ttsErro = String(e); }

    // ---------- 4. Contexto de áudio ----------
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      out.contexto = 'estado=' + ctx.state + ' taxa=' + ctx.sampleRate + ' destino=' + (ctx.destination ? 'sim' : 'nao');
      await ctx.close();
    } catch (e) { out.contexto = 'FALHOU: ' + String(e); }

    out.audioSaida = typeof HTMLMediaElement.prototype.setSinkId === 'function' ? 'setSinkId disponivel' : 'sem setSinkId';

    return JSON.stringify(out, null, 1);
  })()`;

  const res = await send('Runtime.evaluate', {
    expression: expressao,
    returnByValue: true,
    awaitPromise: true,
  });

  if (res.exceptionDetails) {
    console.error('erro na página:', JSON.stringify(res.exceptionDetails).slice(0, 500));
  } else {
    console.log(res.result.value);
  }
  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
