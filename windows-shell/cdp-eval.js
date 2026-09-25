'use strict';

/**
 * Executa JavaScript dentro da janela do shell (para testes).
 *
 *   node cdp-eval.js 9333 "setOpen(false); 'ok'"
 */

const PORT = Number(process.argv[2] || 9333);
const EXPRESSAO = process.argv[3] || '1';

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('nenhuma página');

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
    expression: `(async () => {
      let erro = null;
      try { await (${EXPRESSAO}); } catch (e) { erro = String(e); }
      await new Promise(r => setTimeout(r, 300));
      return JSON.stringify({
        erro,
        largura: innerWidth, altura: innerHeight,
        tipoSetOpen: typeof setOpen,
        classePainel: document.getElementById('panel').className,
        escondido: document.getElementById('panel').classList.contains('hidden'),
        corpoClasse: document.body.className,
        ponte: typeof window.nino, ponteWeb: window.nino && window.nino.isWeb,
        shell: !!(window.__ninoShell && window.__ninoShell.isShell),
      });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (res.exceptionDetails) {
    console.error('erro na página:', res.exceptionDetails.exception && res.exceptionDetails.exception.description);
    process.exit(1);
  }
  console.log('resultado:', res.result.value);
  ws.close();
})().catch((err) => {
  console.error('falhou:', err.message);
  process.exit(1);
});
