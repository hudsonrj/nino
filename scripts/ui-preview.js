'use strict';

/**
 * Pré-visualização da interface sem precisar do Ollama.
 * Carrega a interface real com uma API simulada e salva capturas em PNG.
 *
 *   node_modules/.bin/electron --no-sandbox scripts/ui-preview.js [pasta-de-saida]
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
// O Electron mantém flags (ex.: --no-sandbox) no argv, então filtra por elas
// e pelo próprio caminho do script.
const positional = process.argv
  .slice(1)
  .filter((a) => !a.startsWith('-') && !a.endsWith('ui-preview.js'));
const OUT = positional[0] || '/tmp/nino-ui';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a página pintar de verdade.
 * `capturePage` devolve o último quadro composto, então sem isso a captura
 * sai com o estado anterior.
 */
async function settle(page, ms = 800) {
  await page.executeJavaScript(
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))'
  );
  await wait(ms);
}

async function shoot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  const size = image.getSize();
  console.log(`${name}: ${size.width}x${size.height} -> ${file}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 440,
    height: 660,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-mock-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  // A janela precisa estar visível: com a janela oculta o Chromium congela as
  // animações CSS e as capturas saem com o estado errado.
  win.showInactive();
  await wait(900);

  const page = win.webContents;

  // Fundo que imita uma área de trabalho, para a captura ficar legível.
  await page.executeJavaScript(
    `document.body.style.background = 'linear-gradient(140deg,#2b3a4a,#141c26 60%)'; true`
  );

  /* ---------------------------- 1. Ocioso ---------------------------- */
  await page.executeJavaScript(`setOpen(false); setView('chat'); true`);
  await settle(page);
  await shoot(win, '1-ocioso');

  /* --------------------------- 2. Conversa --------------------------- */
  await page.executeJavaScript(`
    setOpen(true);
    setView('chat');
    document.getElementById('messages').innerHTML = '';
    addMessage('user', 'Quem é a Capitu e o que ela faz no livro Dom Casmurro?');
    const b = addMessage('bot', '');
    b.innerHTML = renderMarkdown(
      'No romance **Dom Casmurro**, de Machado de Assis, Capitu é a vizinha por quem Bentinho se apaixona ainda menino e com quem acaba se casando.\\n\\n' +
      'Ela é descrita como **olhos de ressaca**, astuta e dissimulada. O narrador sugere, sem provar, que ela teria traído Bentinho com seu melhor amigo, Escobar — a dúvida é o coração do livro.\\n\\n' +
      '> "Capitu, que também me amava, tinha os olhos de ressaca."'
    );
    renderSources([
      { docName: 'Dom Casmurro — Machado de Assis.epub', score: 0.71, ord: 42 },
      { docName: 'Dom Casmurro — Machado de Assis.epub', score: 0.63, ord: 88 },
    ]);
    setStatus('pronto · 84 tokens em 9,4s');
    el('messages').scrollTop = 0;
    true
  `);
  await settle(page);
  await shoot(win, '2-conversa');

  /* ------------------- 3. Base de conhecimento ----------------------- */
  await page.executeJavaScript(`setView('kb'); true`);
  await settle(page);
  await shoot(win, '3-base-de-conhecimento');

  /* ------------------------ 4. Indexando ----------------------------- */
  await page.executeJavaScript(`
    setView('kb');
    const box = document.getElementById('kbProgress');
    box.classList.remove('hidden');
    document.getElementById('progressFill').style.width = '38%';
    document.getElementById('progressLabel').textContent =
      'indexando Dom Casmurro.epub — 126/331 trechos (38%)';
    true
  `);
  await settle(page);
  await shoot(win, '4-indexando');

  /* --------------------------- 5. Ajustes ---------------------------- */
  await page.executeJavaScript(`document.getElementById('kbProgress').classList.add('hidden'); setView('settings'); true`);
  await settle(page);
  await shoot(win, '5-ajustes');

  /* -------------------------- 6. Ouvindo ----------------------------- */
  await page.executeJavaScript(`
    setView('chat');
    __mock.emit('audio:state', { state: 'listening' });
    setStatus('ouvindo…', 'listen');
    showBubble('Ouvindo você…', 60000);
    true
  `);
  await settle(page);
  await shoot(win, '6-ouvindo');

  /* -------------------------- 7. Falando ----------------------------- */
  await page.executeJavaScript(`
    __mock.emit('audio:state', { state: 'idle' });
    __mock.emit('tts:state', { speaking: true });
    setStatus('falando…', 'busy');
    showBubble('Estou respondendo em voz alta 🎧', 60000);
    true
  `);
  await settle(page);
  await shoot(win, '7-falando');

  /* ------------------ 8. Ajustes: JEV e credenciais ------------------ */
  await page.executeJavaScript(`
    setView('settings');
    el('viewSettings').scrollTop = el('viewSettings').scrollHeight;
    true
  `);
  await settle(page);
  await shoot(win, '8-ajustes-jev');

  /* ----------------------- 9. Meu dia: prévia ------------------------ */
  await page.executeJavaScript(`
    el('bubble').classList.add('hidden');
    setView('day');
    diaStatus('Li 5 mensagem(ns) e 3 compromisso(s). Confira o que sairia da sua máquina e aprove.');
    true
  `);
  await page.executeJavaScript(`pedirPrevia()`);
  await settle(page, 1400);
  await shoot(win, '9-dia-previa');

  /* --------------------- 10. Meu dia: resultado ---------------------- */
  const r10 = await page.executeJavaScript(`
    (async () => {
      try {
        const t = await api.day.triar({});
        dia.triagem = t;
        el('dayPreview').classList.add('hidden');
        renderDia(t);
        diaStatus('Pronto em 0,3s — US$ 0,000190. 2 para hoje, 1 incerta(s), 6 descartável(is).', 'ok');
        return 'ok:' + (t.mensagens || []).length;
      } catch (e) {
        return 'erro:' + e.message;
      }
    })()
  `);
  console.log('  passo 10:', r10);
  await settle(page, 1200);
  await shoot(win, '10-dia-resultado');

  /* --------------------- 11. Meu dia: rascunho ----------------------- */
  const r11 = await page.executeJavaScript(`
    (async () => {
      try {
        await rascunharResposta('1');
        diaStatus('Rascunho pronto. Revise e envie quando quiser.', 'ok');
        // Rola até o cartão com o rascunho, que fica abaixo da agenda.
        const caixa = document.querySelector('.rascunho');
        if (caixa) caixa.scrollIntoView({ block: 'center' });
        return caixa ? 'ok' : 'sem caixa de rascunho';
      } catch (e) {
        return 'erro:' + e.message;
      }
    })()
  `);
  console.log('  passo 11:', r11);
  await settle(page, 700);
  await shoot(win, '11-dia-rascunho');

  /* ---------------- 12. Meu dia: pilhas de baixo --------------------- */
  await page.executeJavaScript(`
    const g = [...document.querySelectorAll('.dia-grupo')]
      .find((x) => /Suspeito/.test(x.querySelector('h4')?.textContent || ''));
    if (g) g.scrollIntoView({ block: 'end' });
    true
  `);
  await settle(page, 700);
  await shoot(win, '12-dia-suspeito');

  console.log('\ncapturas prontas em', OUT);
  app.quit();
});

setTimeout(() => {
  console.error('tempo esgotado na pré-visualização');
  app.quit();
}, 120000);
