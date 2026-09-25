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

  console.log('\ncapturas prontas em', OUT);
  app.quit();
});

setTimeout(() => {
  console.error('tempo esgotado na pré-visualização');
  app.quit();
}, 60000);
