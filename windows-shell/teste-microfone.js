'use strict';

/**
 * Testa o caminho real do microfone dentro do shell:
 * MediaRecorder -> upload -> Whisper.
 *
 * Grava alguns segundos e mostra exatamente o que o servidor responde,
 * inclusive erros de codec.
 *
 *   node teste-microfone.js [porta] [segundos]
 */

const PORT = Number(process.argv[2] || 9333);
const SEGUNDOS = Number(process.argv[3] || 4);

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

  await send('Runtime.enable');

  const expr = `(async () => {
    const info = {};
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch (e) {
      return 'getUserMedia falhou: ' + e.name + ' — ' + e.message;
    }

    const tipos = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    const escolhido = tipos.find(t => MediaRecorder.isTypeSupported(t)) || '';
    info.tipoEscolhido = escolhido || '(padrão do navegador)';

    const rec = new MediaRecorder(stream, escolhido ? { mimeType: escolhido } : undefined);
    const partes = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) partes.push(e.data); };

    await new Promise(r => { rec.onstop = r; rec.start(); setTimeout(() => rec.stop(), ${SEGUNDOS * 1000}); });
    stream.getTracks().forEach(t => t.stop());

    const blob = new Blob(partes, { type: escolhido || 'audio/webm' });
    info.bytes = blob.size;
    info.tipoReal = blob.type;

    if (!blob.size) return 'gravacao VAZIA — nenhum dado capturado';

    const ext = (escolhido || '').includes('ogg') ? 'ogg' : (escolhido || '').includes('mp4') ? 'mp4' : 'webm';
    const res = await fetch('/api/stt?ext=' + ext, { method: 'POST', body: blob });
    info.http = res.status;
    const corpo = await res.text();
    info.resposta = corpo.slice(0, 400);
    return JSON.stringify(info, null, 1);
  })()`;

  const res = await send('Runtime.evaluate', {
    expression: expr,
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
