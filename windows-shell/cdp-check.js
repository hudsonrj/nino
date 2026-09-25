'use strict';

/**
 * Inspeciona a janela do shell pelo CDP, rodando no próprio Windows.
 *
 *   node cdp-check.js [porta]
 */

const PORT = Number(process.argv[2] || 9333);

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) {
    console.log('nenhuma página encontrada');
    return;
  }
  console.log('página:', page.title, '|', page.url);

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
  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      ponte: typeof window.nino,
      shell: !!(window.__ninoShell && window.__ninoShell.isShell),
      larguraInterna: innerWidth,
      alturaInterna: innerHeight,
      painelEscondido: document.getElementById('panel').classList.contains('hidden'),
      visibilidadePainel: getComputedStyle(document.getElementById('panel')).visibility,
      opacidadePainel: getComputedStyle(document.getElementById('panel')).opacity,
      mensagens: document.querySelectorAll('.msg').length,
      status: document.getElementById('statusText').textContent,
      kb: document.getElementById('kbStats').textContent,
    }, null, 1)`,
    returnByValue: true,
  });

  console.log(res.result.value);
  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
