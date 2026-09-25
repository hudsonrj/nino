'use strict';

/**
 * Envia uma pergunta pelo shell e observa se a fala acontece.
 *
 *   node teste-fala.js [porta]
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

  const avaliar = async (expr, aguardar = true) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: aguardar,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };

  await send('Runtime.enable');

  console.log('recarregando a página…');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4000));

  const pronto = await avaliar(`JSON.stringify({
    ponte: typeof window.nino,
    tts: (window.__ninoShell ? 'shell' : 'browser'),
    status: (document.getElementById('statusText')||{}).textContent,
  })`);
  console.log('estado:', pronto);

  await avaliar(`
    window.__log = [];
    window.nino.voice.onTtsState(s => window.__log.push('TTS ' + JSON.stringify(s)));
    window.nino.voice.onAudioState(s => window.__log.push('AUDIO ' + JSON.stringify(s)));
    window.nino.chat.onDone(d => window.__log.push('DONE ' + (d.text||'').slice(0,70)));
    window.nino.chat.onError(e => window.__log.push('ERRO ' + e.error));
    setOpen(true);
    sendMessage('Diga apenas: ola, eu falo agora.');
    'enviado'
  `);

  const limite = Date.now() + 180000;
  let ultimo = '';
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 1500));
    const log = await avaliar('JSON.stringify(window.__log)');
    if (log !== ultimo) {
      ultimo = log;
      const itens = JSON.parse(log);
      console.log('  progresso:', itens.slice(-2).join(' | ') || '(aguardando)');
    }
    if (log.includes('DONE') || log.includes('ERRO')) break;
  }

  console.log('\n--- log completo ---');
  const final = JSON.parse(await avaliar('JSON.stringify(window.__log)'));
  final.forEach((l) => console.log(' ', l));
  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
