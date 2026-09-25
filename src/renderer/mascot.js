'use strict';

/* ==================================================================
   Nino — lógica da interface
   ================================================================== */

const api = window.nino;

const el = (id) => document.getElementById(id);

const IDLE_SIZE = { width: 220, height: 220 };
const OPEN_SIZE = { width: 440, height: 660 };

const state = {
  open: false,
  view: 'chat',
  busy: false,
  recording: false,
  settings: null,
  botText: '',
  botEl: null,
  voices: [],
  models: [],
  clickThrough: false,
};

const mascot = el('mascot');

/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markdown mínimo e seguro (o texto é escapado antes). */
function renderMarkdown(text) {
  let html = escapeHtml(text);
  const blocks = [];
  html = html.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });
  html = html
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*+]\s+(.*)$/gm, '• $1')
    .replace(/^\s*#{1,6}\s+(.*)$/gm, '<strong>$1</strong>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
    );
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return html;
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(ext) {
  const map = {
    pdf: '📕', epub: '📗', docx: '📘', odt: '📄', txt: '📝', md: '📝',
    html: '🌐', htm: '🌐', rtf: '📄', csv: '📊', json: '🧾', xml: '🧾',
  };
  return map[ext] || '📄';
}

function setStatus(text, kind) {
  const dot = el('statusDot');
  dot.className = 'dot';
  if (kind) dot.classList.add(kind);
  el('statusText').textContent = text;
}

function showBubble(text, ms = 4000) {
  const bubble = el('bubble');
  bubble.textContent = text;
  bubble.classList.remove('hidden');
  clearTimeout(showBubble._t);
  showBubble._t = setTimeout(() => bubble.classList.add('hidden'), ms);
}

/* ------------------------------------------------------------------ */
/* Janela: abrir/fechar, arrastar                                      */
/* ------------------------------------------------------------------ */

function setOpen(open) {
  state.open = open;
  const panel = el('panel');
  panel.classList.toggle('hidden', !open);
  panel.setAttribute('aria-hidden', String(!open));
  const size = open ? OPEN_SIZE : IDLE_SIZE;
  api.win.resize(size.width, size.height, 'bottom-right');
  if (open) {
    setTimeout(() => el('input').focus(), 90);
  }
}

function setupDragAndClick() {
  let down = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;

  mascot.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    down = true;
    dragging = false;
    startX = event.screenX;
    startY = event.screenY;
    event.preventDefault();
  });

  window.addEventListener('mousemove', (event) => {
    if (!down) return;
    const dist = Math.hypot(event.screenX - startX, event.screenY - startY);
    if (!dragging && dist > 5) {
      dragging = true;
      api.win.dragStart(event.screenX, event.screenY);
    }
  });

  window.addEventListener('mouseup', () => {
    if (!down) return;
    down = false;
    if (dragging) {
      api.win.dragEnd();
      dragging = false;
    } else {
      // Clique simples: abre/fecha o painel.
      setOpen(!state.open);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Mensagens                                                           */
/* ------------------------------------------------------------------ */

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'bot' || role === 'error') div.innerHTML = renderMarkdown(text);
  else div.textContent = text;
  const list = el('messages');
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  return div;
}

function nearBottom() {
  const list = el('messages');
  return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
}

function setBusy(busy) {
  state.busy = busy;
  el('btnSend').textContent = busy ? '■' : '➤';
  el('btnSend').title = busy ? 'Parar' : 'Enviar';
  clearInterval(state.busyTimer);
  if (busy) {
    // Em CPU a primeira palavra pode levar um tempo; mostrar o tempo
    // decorrido deixa claro que ele está trabalhando.
    const startedAt = Date.now();
    const rotulo = () => {
      if (state.waitingOn === 'camera') return 'olhando pela câmera…';
      if (state.waitingOn === 'screen') return 'olhando sua tela…';
      if (state.waitingOn === 'kb') return 'procurando nos documentos…';
      return 'pensando…';
    };
    const tick = () => {
      if (!state.busy) return;
      const secs = Math.round((Date.now() - startedAt) / 1000);
      setStatus(`${rotulo()} ${secs}s`, 'busy');
    };
    state.busyTimer = setInterval(tick, 1000);
    el('statusText').textContent = rotulo();
    el('statusDot').className = 'dot busy';
    mascot.classList.add('thinking');
  } else {
    mascot.classList.remove('thinking');
    if (!state.recording) setStatus('pronto para ajudar');
  }
}

function sendMessage(text) {
  const clean = String(text || '').trim();
  if (!clean) return;

  if (state.busy) {
    api.chat.abort();
    return;
  }

  // Pedido escrito que só faz sentido com imagem ("olhe para mim", "veja minha
  // tela") liga a câmera ou captura a tela, mesmo sem clicar no botão.
  if (api.vision && visionDisponivel && visionDisponivel.enabled) {
    const intencao = detectVisionIntent(clean);
    const permitido =
      (intencao === 'camera' && visionDisponivel.camera) ||
      (intencao === 'screen' && visionDisponivel.screen);
    if (permitido) {
      el('input').value = '';
      autoGrow();
      sendVision(intencao, clean);
      return;
    }
  }

  if (!state.open) setOpen(true);

  // Pergunta sobre o próprio dia ("o que tenho hoje?", "tem algo urgente?").
  // Responde com a triagem que o usuário já aprovou — sem mandar nada novo
  // para a nuvem. Não usa expressões regulares frouxas de propósito: disparar
  // isso por engano custaria uma ida ao modelo local de 1 a 3 minutos.
  if (api.day && state.settings && state.settings.jevEnabled && detectarIntencaoDeDia(clean)) {
    el('input').value = '';
    autoGrow();
    addMessage('user', clean);
    el('sources').classList.add('hidden');
    state.botText = '';
    state.botEl = addMessage('bot', '');
    state.botEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    setBusy(true);
    perguntarSobreODia(clean);
    return;
  }

  addMessage('user', clean);
  el('input').value = '';
  autoGrow();
  el('sources').classList.add('hidden');

  state.botText = '';
  state.botEl = addMessage('bot', '');
  state.botEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

  // A primeira etapa é a busca na base; depois disso é a vez do modelo.
  state.waitingOn =
    state.settings && state.settings.useKnowledgeBase && state.stats && state.stats.chunks > 0
      ? 'kb'
      : 'llm';

  setBusy(true);
  api.chat.send(clean);
}

/* ------------------------------------------------------------------ */
/* Envio / entrada                                                     */
/* ------------------------------------------------------------------ */

function autoGrow() {
  const input = el('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
}

function setupComposer() {
  const input = el('input');
  const form = el('composer');

  input.addEventListener('input', autoGrow);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage(input.value);
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage(input.value);
  });
}

/* ------------------------------------------------------------------ */
/* Voz                                                                 */
/* ------------------------------------------------------------------ */

function setupVoice() {
  el('btnMic').addEventListener('click', () => {
    if (state.recording) api.voice.stopListening();
    else api.voice.listen();
  });

  el('btnSpeakToggle').addEventListener('click', async () => {
    const next = !(state.settings && state.settings.ttsEnabled);
    const res = await api.settings.set({ ttsEnabled: next });
    state.settings = res.settings;
    if (!next) api.voice.stop();
    paintVoiceToggle();
    showBubble(next ? 'Voz ligada' : 'Voz desligada', 2200);
  });

  api.voice.onAudioState((payload) => {
    const s = payload && payload.state;
    if (s === 'listening') {
      state.recording = true;
      el('btnMic').classList.add('recording');
      mascot.classList.add('listening');
      setStatus('ouvindo…', 'listen');
    } else {
      state.recording = false;
      el('btnMic').classList.remove('recording');
      mascot.classList.remove('listening');
      if (s === 'transcribing') setStatus('transcrevendo…', 'busy');
      else if (!state.busy) setStatus('pronto para ajudar');
    }
  });

  api.voice.onTranscript((payload) => {
    const text = (payload && payload.text) || '';
    if (!text) return;
    setOpen(true);
    showBubble(`“${text.slice(0, 70)}${text.length > 70 ? '…' : ''}”`, 3000);
    sendMessage(text);
  });

  api.voice.onError((payload) => {
    const msg = (payload && payload.error) || 'erro de áudio';
    addMessage('error', `🎤 ${msg}`);
    showBubble(msg, 3500);
    setStatus('pronto para ajudar');
  });

  api.voice.onTtsState((payload) => {
    const speaking = payload && payload.speaking;
    mascot.classList.toggle('speaking', !!speaking);
    if (speaking) setStatus('falando…', 'busy');
    else if (!state.busy && !state.recording) setStatus('pronto para ajudar');
  });

  // Nível do microfone ao vivo (só o modo web/navegador emite).
  if (api.voice.onLevel) {
    const BARRAS = '▁▂▃▄▅▆▇█';
    api.voice.onLevel((p) => {
      if (!state.recording) return;
      const referencia = Math.max((p.threshold || 0.01) * 2.5, 0.02);
      const nivel = Math.max(0, Math.min(1, (p.rms || 0) / referencia));
      const barra = BARRAS[Math.round(nivel * (BARRAS.length - 1))];
      setStatus(`ouvindo… ${barra}${barra}${barra}`, 'listen');
    });
  }
}

function paintVoiceToggle() {
  const on = !!(state.settings && state.settings.ttsEnabled);
  const chip = el('btnSpeakToggle');
  chip.textContent = on ? '🔊 voz' : '🔇 mudo';
  chip.classList.toggle('on', on);
}

/* ------------------------------------------------------------------ */
/* Visão (câmera e tela)                                               */
/* ------------------------------------------------------------------ */

/**
 * Reconhece pedidos escritos que só fazem sentido com imagem.
 * Assim "olhe para mim" liga a câmera mesmo sem clicar no botão.
 */
const PADROES_CAMERA = [
  /\bolh[ae]\s+(para\s+|pra\s+|pro\s+)?(mim|eu|meu\s+lado)\b/i,
  /\bme\s+(olh[ae]|veja|v[êe]|enxerg[ae])\b/i,
  /\bvoc[êe]\s+(me\s+)?(v[êe]|enxerga|consegue\s+me\s+ver)\b/i,
  /\bo\s+que\s+(voc[êe]\s+)?(v[êe]|est[áa]\s+vendo|enxerga)\b/i,
  /\bcomo\s+eu\s+(estou|pare[çc]o|estou\s+parecendo)\b/i,
  /\b(o\s+que|quem)\s+(tem|h[áa])\s+(atr[áa]s|em\s+volta|na\s+sala)\b/i,
  /\bdescrev[ae]\s+(o\s+ambiente|a\s+minha\s+volta|a\s+sala)\b/i,
  /\b(nessa|nesta)\s+foto\b/i,
];

// "tela" sozinho é amplo demais ("o que é uma tela OLED?"), e "a tela" também
// ("a tela do celular quebrou"). Por isso exigimos o possessivo em primeira
// pessoa ou um verbo de olhar junto.
const PADROES_TELA = [
  /\b(minha|essa|esta|nesta|nessa)\s+tela\b/i,
  /\btela\b[^.]{0,30}\b(explica|olh\w*|veja|v[êe]|analis\w*|mostra|print)\b/i,
  /\b(explica|olh\w*|veja|v[êe]|analis\w*|mostra|print)\b[^.]{0,30}\btela\b/i,
  /\bo\s+que\s+eu\s+estou\s+fazendo\b/i,
  /\bexplica\s+(o\s+que|isso|essa|esta|a\s+situa[çc][ãa]o)\b/i,
  /\bveja\s+o\s+que\s+est[áa]\s+acontecendo\b/i,
];

/** @returns {'camera'|'screen'|null} */
function detectVisionIntent(texto) {
  if (!texto) return null;
  if (PADROES_CAMERA.some((re) => re.test(texto))) return 'camera';
  if (PADROES_TELA.some((re) => re.test(texto))) return 'screen';
  return null;
}

let visionDisponivel = null;

/**
 * @param {'camera'|'screen'} mode
 * @param {string} [texto] pergunta escrita pelo usuário
 */
async function sendVision(mode, texto) {
  if (state.busy) {
    api.chat.abort();
    return;
  }
  if (!state.open) setOpen(true);

  const padrao =
    mode === 'camera' ? 'Olhe para mim e diga o que você vê' : 'Olhe minha tela e explique';
  const rotulo = texto || padrao;
  addMessage('user', `${mode === 'camera' ? '📷' : '🖥️'} ${rotulo}`);

  el('sources').classList.add('hidden');
  state.botText = '';
  state.botEl = addMessage('bot', '');
  state.botEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  state.waitingOn = mode;
  setBusy(true);
  showBubble(mode === 'camera' ? '📷 Deixa eu te ver…' : '🖥️ Deixa eu olhar sua tela…', 3500);

  // Os tokens chegam pelos mesmos eventos da conversa (chat:token/chat:done).
  const res = await api.vision.capture(mode, { question: texto || '' });
  if (res && res.ok === false && !res.aborted && state.botEl) {
    setBusy(false);
  }
}

async function setupVision() {
  const btnCam = el('btnCamera');
  const btnScr = el('btnScreen');
  if (!btnCam || !btnScr) return;

  if (!api.vision) {
    btnCam.classList.add('hidden');
    btnScr.classList.add('hidden');
    return;
  }

  try {
    const disp = await api.vision.available();
    visionDisponivel = disp;
    if (!disp.enabled) {
      btnCam.classList.add('hidden');
      btnScr.classList.add('hidden');
    } else {
      if (!disp.camera) btnCam.classList.add('hidden');
      if (!disp.screen) btnScr.classList.add('hidden');
    }
    // Avisa no campo de texto que dá para pedir por escrito.
    if (disp.enabled && disp.camera) {
      el('input').placeholder = 'Pergunte algo, ou escreva "olhe para mim"…';
    }
  } catch {
    /* mantém os botões */
  }

  btnCam.addEventListener('click', () => sendVision('camera'));
  btnScr.addEventListener('click', () => sendVision('screen'));

  api.vision.onState((p) => {
    const ativo = !!(p && p.state === 'analisando');
    btnCam.classList.toggle('ativo', ativo && p.mode === 'camera');
    btnScr.classList.toggle('ativo', ativo && p.mode === 'screen');
    if (ativo) {
      setStatus(p.mode === 'camera' ? 'olhando pela câmera…' : 'olhando sua tela…', 'busy');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Conversa: eventos do processo principal                             */
/* ------------------------------------------------------------------ */

function setupChatEvents() {
  api.chat.onToken((payload) => {
    if (!state.botEl) return;
    state.waitingOn = 'llm';
    const stick = nearBottom();
    if (!state.botText) state.botEl.innerHTML = '';
    state.botText += payload.token;
    state.botEl.innerHTML = `${renderMarkdown(state.botText)}<span class="caret"></span>`;
    if (stick) el('messages').scrollTop = el('messages').scrollHeight;
  });

  api.chat.onDone((payload) => {
    if (state.botEl) {
      state.botEl.innerHTML = renderMarkdown(state.botText || payload.text || '');
    }
    renderSources(payload.sources);
    setBusy(false);
    state.botEl = null;

    const stats = payload.stats || {};
    if (stats.evalCount) {
      setStatus(`pronto · ${stats.evalCount} tokens em ${((stats.totalDurationMs || 0) / 1000).toFixed(1)}s`);
    }
  });

  api.chat.onAborted(() => {
    if (state.botEl) {
      state.botEl.innerHTML = state.botText
        ? `${renderMarkdown(state.botText)}<br><em style="color:#93a9b8">(interrompido)</em>`
        : '<em style="color:#93a9b8">(interrompido)</em>';
    }
    state.botEl = null;
    setBusy(false);
  });

  api.chat.onError((payload) => {
    const msg = (payload && payload.error) || 'erro desconhecido';
    if (state.botEl && !state.botText) {
      state.botEl.remove();
    } else if (state.botEl) {
      state.botEl.innerHTML = renderMarkdown(state.botText);
    }
    state.botEl = null;
    addMessage('error', msg.includes('fetch') || msg.includes('ECONNREFUSED')
      ? 'Não consegui falar com o Ollama. Ele está rodando? (ollama serve)'
      : msg);
    setBusy(false);
    showBubble('Tive um problema…', 3000);
  });
}

function renderSources(sources) {
  const box = el('sources');
  if (!sources || !sources.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `<b>📚 Base de conhecimento:</b> ${sources
    .map((s) => `<span class="src">${escapeHtml(s.docName)} · ${(s.score * 100).toFixed(0)}%</span>`)
    .join('')}`;
  box.classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* Base de conhecimento                                                */
/* ------------------------------------------------------------------ */

async function loadKb() {
  const data = await api.kb.list();
  const stats = data.stats;
  state.stats = stats;

  el('kbStats').textContent = stats.documents
    ? `${stats.documents} documento(s) · ${stats.chunks} trechos · ${formatBytes(stats.chars)} de texto` +
      (stats.embedModel ? ` · ${stats.embedModel}` : '')
    : 'Nenhum documento ainda. Adicione PDFs, EPUBs, apostilas, livros…';

  const list = el('kbList');
  list.innerHTML = '';

  if (!data.documents.length) {
    list.innerHTML =
      '<div class="kb-empty">Sua base está vazia.<br />Clique em <b>Adicionar documentos</b> ou arraste arquivos para cima do mascote.</div>';
    return;
  }

  for (const doc of data.documents) {
    const item = document.createElement('div');
    item.className = 'kb-item';
    item.innerHTML = `
      <span class="ico">${iconFor(doc.ext)}</span>
      <div class="meta">
        <strong title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</strong>
        <span>${doc.chunkCount} trechos · ${formatBytes(doc.bytes)}${doc.pages ? ` · ${doc.pages} pág.` : ''}${
          doc.complete === false ? ' · <b style="color:#fbbf24">incompleto</b>' : ''
        }</span>
      </div>
      <button class="del" title="Remover">🗑</button>`;
    item.querySelector('.del').addEventListener('click', async () => {
      item.style.opacity = '0.5';
      await api.kb.remove(doc.id);
      loadKb();
    });
    list.appendChild(item);
  }
}

function setupKb() {
  el('btnAdd').addEventListener('click', async () => {
    el('btnAdd').disabled = true;
    try {
      const res = await api.kb.addViaDialog();
      if (res && res.ok) reportIngest(res.report);
      loadKb();
    } finally {
      el('btnAdd').disabled = false;
      el('kbProgress').classList.add('hidden');
    }
  });

  // Limpar a base apaga TUDO: exige uma segunda confirmação.
  el('btnClearKb').addEventListener('click', async () => {
    const btn = el('btnClearKb');
    if (!state.confirmClear) {
      state.confirmClear = true;
      btn.textContent = '⚠️ Apagar tudo? Clique de novo';
      btn.classList.add('danger');
      clearTimeout(state.confirmClearTimer);
      state.confirmClearTimer = setTimeout(() => {
        state.confirmClear = false;
        btn.textContent = 'Limpar base';
        btn.classList.remove('danger');
      }, 6000);
      return;
    }
    clearTimeout(state.confirmClearTimer);
    state.confirmClear = false;
    btn.textContent = 'Limpando…';
    await api.kb.clear();
    btn.textContent = 'Limpar base';
    btn.classList.remove('danger');
    loadKb();
    showBubble('Base limpa', 2500);
  });

  api.kb.onProgress((p) => {
    if (!p || p.stage === 'fim') {
      el('kbProgress').classList.add('hidden');
      if (!state.busy && !state.recording) setStatus('pronto para ajudar');
      return;
    }

    // A importação começa na view da base; se veio de um arrastar-e-soltar
    // feito na conversa, leva o usuário até lá para ele acompanhar.
    if (state.open && state.view !== 'kb' && p.stage !== 'concluído') setView('kb');

    const box = el('kbProgress');
    box.classList.remove('hidden');
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    el('progressFill').style.width = `${pct}%`;
    if (p.stage === 'lendo') {
      el('progressLabel').textContent = `lendo ${p.file}…`;
      setStatus(`lendo ${p.file}…`, 'busy');
    } else if (p.stage === 'indexando') {
      el('progressLabel').textContent = `indexando ${p.file} — ${p.done}/${p.total} trechos (${pct}%)`;
      setStatus(`indexando ${p.file} (${pct}%)`, 'busy');
    } else if (p.stage === 'erro') {
      el('progressLabel').textContent = `erro em ${p.file}: ${p.error}`;
    } else {
      el('progressLabel').textContent = `${p.stage} ${p.file || ''}`;
    }
  });

  api.kb.onChanged(() => loadKb());
}

function reportIngest(report) {
  if (!report || !report.length) return;
  const lines = report.map((r) => {
    if (r.skipped) return `• ${r.file}: ignorado (${r.reason})`;
    if (!r.ok) return `• ${r.file}: falhou — ${r.error}`;
    return `• ${r.file}: ${r.chunks} trechos indexados`;
  });
  addMessage('system', lines.join('\n'));
  const bad = report.filter((r) => !r.ok).length;
  showBubble(
    bad ? `${report.length - bad} de ${report.length} adicionados` : `${report.length} documento(s) na base`,
    3200
  );
}

/* ------------------------------------------------------------------ */
/* Ajustes                                                            */
/* ------------------------------------------------------------------ */

/**
 * Lista as saídas de áudio. Só existe no modo web/navegador — no app de
 * desktop o som sai pelo sistema e não há o que escolher aqui.
 */
async function loadOutputDevices() {
  const campo = el('fieldOutput');
  const sel = el('setOutput');
  const botao = el('btnTestVoice');
  if (!campo || !sel) return;

  if (!api.voice || typeof api.voice.outputs !== 'function') {
    campo.classList.add('hidden');
    if (botao) botao.classList.add('hidden');
    return;
  }

  try {
    const saidas = await api.voice.outputs();
    const atual = typeof api.voice.currentOutput === 'function' ? api.voice.currentOutput() : '';
    sel.innerHTML =
      '<option value="">Padrão do sistema</option>' +
      saidas
        .map(
          (o) =>
            `<option value="${escapeHtml(o.id)}"${o.id === atual ? ' selected' : ''}>` +
            `${escapeHtml(o.label)}</option>`
        )
        .join('');
    campo.classList.remove('hidden');
    if (botao) botao.classList.remove('hidden');
  } catch {
    campo.classList.add('hidden');
    if (botao) botao.classList.add('hidden');
  }
}

async function loadSettings() {
  state.settings = await api.settings.get();
  const s = state.settings;

  const voiceSel = el('setVoice');
  voiceSel.innerHTML = state.voices
    .map((v) => `<option value="${v}"${v === s.voice ? ' selected' : ''}>${v}</option>`)
    .join('');

  const modelSel = el('setModel');
  const chatModels = state.models.filter((m) => !m.name.includes('embed'));
  modelSel.innerHTML = chatModels
    .map((m) => `<option value="${m.name}"${m.name === s.model ? ' selected' : ''}>${m.name}</option>`)
    .join('');
  if (!chatModels.some((m) => m.name === s.model)) {
    modelSel.insertAdjacentHTML('afterbegin', `<option value="${s.model}" selected>${s.model} (não instalado)</option>`);
  }

  const embedSel = el('setEmbedModel');
  const embedModels = state.models.filter(
    (m) => m.name.includes('embed') || ['bge-m3', 'nomic-embed-text'].some((n) => m.name.startsWith(n))
  );
  const embedNames = new Set([...embedModels.map((m) => m.name), s.embedModel, 'bge-m3', 'nomic-embed-text']);
  embedSel.innerHTML = [...embedNames]
    .map((n) => `<option value="${n}"${n === s.embedModel ? ' selected' : ''}>${n}</option>`)
    .join('');

  el('setSpeed').value = s.lengthScale;
  el('lblSpeed').textContent = Number(s.lengthScale).toFixed(2).replace('.', ',');
  await loadOutputDevices();
  el('setTts').checked = !!s.ttsEnabled;
  el('setKb').checked = !!s.useKnowledgeBase;
  el('setVision').checked = s.visionEnabled !== false;
  el('setCamera').checked = s.cameraEnabled !== false;
  el('setScreen').checked = s.screenEnabled !== false;
  el('setCameraPrompt').value = s.cameraPrompt || '';
  el('setScreenPrompt').value = s.screenPrompt || '';
  el('setTopK').value = s.topK;
  el('lblTopK').textContent = s.topK;
  el('setThreads').value = s.numThread;
  el('lblThreads').textContent = s.numThread > 0 ? s.numThread : `auto (${state.autoThreads || '?'})`;
  el('setMaxTok').value = s.maxTokens;
  el('lblMaxTok').textContent = s.maxTokens;
  el('setPrompt').value = s.systemPrompt;

  // --- JEV / e-mail / agenda ---
  el('setJev').checked = !!s.jevEnabled;
  const jevSel = el('setJevModel');
  const modelos = (dia.info && dia.info.modelosJev) || ['jev-latest', 'jev-1.13'];
  const alvo = s.jevModel || 'jev-latest';
  const conjunto = new Set([...modelos, alvo]);
  jevSel.innerHTML = [...conjunto]
    .map((m) => `<option value="${m}"${m === alvo ? ' selected' : ''}>${m}</option>`)
    .join('');
  el('setJevConf').value = s.jevConfiancaMinima;
  el('lblJevConf').textContent = Number(s.jevConfiancaMinima).toFixed(2).replace('.', ',');
  el('setAgendaDias').value = s.agendaDias;
  el('lblAgendaDias').textContent = s.agendaDias;
  el('setAgendaMsgs').value = s.agendaMensagens;
  el('lblAgendaMsgs').textContent = s.agendaMensagens;
  el('setAgendaNaoLidos').checked = s.agendaSomenteNaoLidos !== false;
  el('setAgendaCorpo').checked = s.agendaIncluirCorpo !== false;
  await carregarCredenciais();
  await carregarGoogle();

  paintVoiceToggle();
}

function setupSettings() {
  el('setSpeed').addEventListener('input', (e) => {
    el('lblSpeed').textContent = Number(e.target.value).toFixed(2).replace('.', ',');
  });
  el('setTopK').addEventListener('input', (e) => {
    el('lblTopK').textContent = e.target.value;
  });
  el('setThreads').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    el('lblThreads').textContent = v > 0 ? v : `auto (${state.autoThreads || '?'})`;
  });
  el('setMaxTok').addEventListener('input', (e) => {
    el('lblMaxTok').textContent = e.target.value;
  });
  el('setJevConf').addEventListener('input', (e) => {
    el('lblJevConf').textContent = Number(e.target.value).toFixed(2).replace('.', ',');
  });
  el('setAgendaDias').addEventListener('input', (e) => {
    el('lblAgendaDias').textContent = e.target.value;
  });
  el('setAgendaMsgs').addEventListener('input', (e) => {
    el('lblAgendaMsgs').textContent = e.target.value;
  });

  if (el('setOutput')) {
    el('setOutput').addEventListener('change', async (e) => {
      el('settingsMsg').style.color = '#4ade80';
      el('settingsMsg').textContent = 'Trocando a saída e tocando um teste…';
      await api.voice.setOutput(e.target.value);
      el('settingsMsg').textContent = 'Saída alterada — deve ter tocado um aviso.';
      setTimeout(() => { el('settingsMsg').textContent = ''; }, 6000);
    });
  }

  if (el('btnTestVoice')) {
    el('btnTestVoice').addEventListener('click', () => {
      if (api.voice.test) api.voice.test();
    });
  }

  el('btnSaveSettings').addEventListener('click', async () => {
    const patch = {
      model: el('setModel').value,
      embedModel: el('setEmbedModel').value,
      voice: el('setVoice').value,
      lengthScale: Number(el('setSpeed').value),
      ttsEnabled: el('setTts').checked,
      useKnowledgeBase: el('setKb').checked,
      visionEnabled: el('setVision').checked,
      cameraEnabled: el('setCamera').checked,
      screenEnabled: el('setScreen').checked,
      cameraPrompt: el('setCameraPrompt').value,
      screenPrompt: el('setScreenPrompt').value,
      topK: Number(el('setTopK').value),
      numThread: Number(el('setThreads').value),
      maxTokens: Number(el('setMaxTok').value),
      systemPrompt: el('setPrompt').value,
      jevEnabled: el('setJev').checked,
      jevModel: el('setJevModel').value,
      jevConfiancaMinima: Number(el('setJevConf').value),
      agendaDias: Number(el('setAgendaDias').value),
      agendaMensagens: Number(el('setAgendaMsgs').value),
      agendaSomenteNaoLidos: el('setAgendaNaoLidos').checked,
      agendaIncluirCorpo: el('setAgendaCorpo').checked,
    };
    const res = await api.settings.set(patch);
    state.settings = res.settings;
    paintVoiceToggle();
    el('settingsMsg').textContent = res.warning || 'Ajustes salvos. ✓';
    if (res.warning) el('settingsMsg').style.color = '#fbbf24';
    else el('settingsMsg').style.color = '#4ade80';
    setTimeout(() => { el('settingsMsg').textContent = ''; }, 6000);
  });

  el('btnOpenData').addEventListener('click', () => api.system.openDataFolder());
}

/* ------------------------------------------------------------------ */
/* Navegação                                                           */
/* ------------------------------------------------------------------ */

function setView(view) {
  state.view = view;
  for (const [name, btn, viewId] of [
    ['chat', el('btnChat'), 'viewChat'],
    ['day', el('btnDay'), 'viewDay'],
    ['kb', el('btnKb'), 'viewKb'],
    ['settings', el('btnSettings'), 'viewSettings'],
  ]) {
    const active = name === view;
    btn.classList.toggle('active', active);
    el(viewId).classList.toggle('active', active);
  }
  if (view === 'kb') loadKb();
  if (view === 'day') carregarDia();
  if (view === 'settings') loadSettings();
}

function setupNav() {
  el('btnChat').addEventListener('click', () => setView('chat'));
  el('btnDay').addEventListener('click', () => setView('day'));
  el('btnKb').addEventListener('click', () => setView('kb'));
  el('btnSettings').addEventListener('click', () => setView('settings'));
  el('btnHide').addEventListener('click', () => {
    setOpen(false);
    api.win.hide();
  });
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

async function init() {
  if (!api) {
    document.body.innerHTML =
      '<div style="color:#fff;font:14px sans-serif;padding:20px">Falha ao carregar a ponte (preload).</div>';
    return;
  }

  setupNav();
  setupComposer();
  setupDragAndClick();
  setupVoice();
  setupVision();
  setupChatEvents();
  setupKb();
  setupDay();
  setupSettings();

  const status = await api.system.status();
  state.voices = status.voices || [];
  state.settings = status.settings;
  state.autoThreads = status.autoThreads;

  const modelsRes = await api.system.models();
  state.models = modelsRes.models || [];

  await loadSettings();
  await loadKb();
  setView('chat');

  if (!status.ollama) {
    addMessage('error', 'O Ollama não respondeu. Inicie com: ollama serve');
    setStatus('Ollama offline', 'off');
  } else {
    setStatus('pronto para ajudar');
  }

  if (!state.settings.ttsEnabled) paintVoiceToggle();
  setOpen(false);

  api.system.onClickThrough((payload) => {
    state.clickThrough = !!(payload && payload.enabled);
    showBubble(
      state.clickThrough
        ? 'Modo clique-através ligado (Ctrl+Alt+T para voltar)'
        : 'Modo clique-através desligado',
      3200
    );
  });

  // Aviso inicial, simpaticamente.
  setTimeout(() => {
    if (!el('messages').children.length) {
      addMessage(
        'bot',
        'Oi! Eu sou o **Nino** 🐣\n\nClique em mim para conversar, no microfone para falar, ou no 📚 para me dar livros e documentos. Pode arrastar arquivos aqui também!'
      );
    }
  }, 350);
}

window.addEventListener('DOMContentLoaded', init);

/* ================================================================== */
/* MEU DIA — JEV decide, o modelo local escreve                        */
/* ================================================================== */

/** Apelido curto: assunto e remetente de e-mail são conteúdo alheio. */
const esc = escapeHtml;

/* ---- perguntas sobre o próprio dia, feitas no chat ---- */

/**
 * Reconhece pedidos sobre e-mail e agenda. Exige posse em primeira pessoa
 * ("minha agenda", "meus e-mails") ou uma expressão fixa ("o que tenho hoje").
 * Preferimos perder um caso a disparar à toa: um falso positivo aqui custa de
 * 1 a 3 minutos do modelo local.
 */
const PADROES_DIA = [
  /\b(minha|meu|meus|minhas)\s+(agenda|dia|e-?mails?|correio|caixa de entrada|compromissos?|reuni[õo]es?|inbox|mensagens)\b/i,
  /\b(agenda|compromissos?|reuni[õo]es?)\s+(de|da|do|para)\s+(hoje|amanh[ãa]|esta semana|essa semana)\b/i,
  /\bo que (eu )?(tenho|tem|marcado|tenho marcado)\s+(hoje|amanh[ãa]|na agenda|para hoje|marcado)\b/i,
  /\b(resumo|resuma|como (est[áa]|vai))\s+(o\s+)?(meu\s+)?dia\b/i,
  /\b(alguma coisa|algo|tem algo)\s+(urgente|importante)\b/i,
  /\bo que chegou\b/i,
  /\bpreciso responder (algum|alguma|algu[ée]m)\b/i,
];

function detectarIntencaoDeDia(texto) {
  const t = String(texto || '').trim();
  if (t.length < 4) return false;
  // Perguntas conceituais não são sobre o dia do usuário.
  if (/\b(o que (é|e|significa|quer dizer)|me explique|o que s[ãa]o)\b/i.test(t)) return false;
  return PADROES_DIA.some((re) => re.test(t));
}

/** Responde sobre o dia usando a última triagem aprovada. */
async function perguntarSobreODia(pergunta) {
  try {
    await api.day.perguntar(pergunta, (m) => {
      if (m.type === 'token') {
        state.botText += m.token;
        if (state.botEl) {
          state.botEl.innerHTML = `${renderMarkdown(state.botText)}<span class="caret"></span>`;
        }
      } else if (m.type === 'done') {
        if (state.botEl) {
          state.botEl.innerHTML = renderMarkdown(m.text || state.botText);
        }
        setBusy(false);
        state.botEl = null;
      } else if (m.type === 'error') {
        if (state.botEl && !state.botText) state.botEl.remove();
        state.botEl = null;
        addMessage('error', m.error);
        setBusy(false);
      } else if (m.type === 'aborted') {
        if (state.botEl) {
          state.botEl.innerHTML = state.botText
            ? `${renderMarkdown(state.botText)}<br><em style="color:#93a9b8">(interrompido)</em>`
            : '<em style="color:#93a9b8">(interrompido)</em>';
        }
        state.botEl = null;
        setBusy(false);
      }
    });
  } catch (err) {
    if (state.botEl && !state.botText) state.botEl.remove();
    state.botEl = null;
    addMessage('error', `Não consegui responder sobre o seu dia: ${err.message}`);
    setBusy(false);
  }
}

const dia = {
  info: null,
  triagem: null,
  previa: null,
  rascunhos: new Map(), // uid -> texto em edição
  ocupado: false,
};

function diaStatus(texto, classe) {
  const n = el('dayStatus');
  n.textContent = texto;
  n.className = `day-status${classe ? ` ${classe}` : ''}`;
}

/** Mostra o que falta configurar, com o motivo exato. */
function renderFalta(info) {
  const caixa = el('dayFalta');
  const faltas = [];
  const c = (info && info.credenciais) || {};
  if (!c.typesafe || !c.typesafe.configurado) {
    faltas.push(
      'A <b>chave da TypeSafe</b> (o JEV) não está configurada. Crie uma em ' +
        'console.typesafe.ai/keys e cole em Ajustes.'
    );
  }
  if (!c.google || !c.google.configurado) {
    faltas.push(
      'O <b>Gmail</b> não está configurado. Informe seu e-mail e uma ' +
        '<b>senha de app</b> em Ajustes.'
    );
  }
  if (!c.google || !c.google.agenda) {
    faltas.push(
      'A <b>agenda</b> não está configurada. Cole o endereço secreto do iCal ' +
        'em Ajustes.'
    );
  }
  if (!faltas.length) {
    caixa.classList.add('hidden');
    caixa.innerHTML = '';
    return;
  }
  caixa.classList.remove('hidden');
  caixa.innerHTML =
    'Falta configurar:<br>' + faltas.map((f) => `• ${f}`).join('<br>');
}

async function carregarDia() {
  if (!api.day) {
    diaStatus('A visão "Meu dia" só funciona no modo web (navegador).', 'erro');
    return;
  }
  try {
    dia.info = await api.day.info();
    renderFalta(dia.info);
    if (!dia.info.credenciais.typesafe.configurado) {
      diaStatus('Falta a chave do JEV para eu poder triar seu dia.');
    } else if (dia.triagem) {
      // já temos uma triagem: mantém o resultado na tela
    } else {
      const est = dia.info.estatisticas;
      diaStatus(
        `Pronto. Configurei ${est.chamadas} chamada(s) ao JEV até agora, ` +
          `US$ ${Number(est.custoUSD).toFixed(6)}.`
      );
    }
  } catch (err) {
    diaStatus(`Não consegui verificar a configuração: ${err.message}`, 'erro');
  }
}

/** Passo 1: buscar e-mail e agenda e MOSTRAR o que sairia da máquina. */
async function pedirPrevia() {
  if (dia.ocupado) return;
  if (!api.day) return;
  dia.ocupado = true;
  el('btnDayResumo').disabled = true;
  el('dayPreview').classList.add('hidden');
  el('dayResultado').innerHTML = '';
  diaStatus('Lendo seu e-mail e sua agenda…', 'trabalhando');
  try {
    const p = await api.day.previa({});
    if (!p.ok) {
      diaStatus(
        p.avisos && p.avisos.length ? p.avisos.join(' · ') : 'Não há nada para triar.',
        'erro'
      );
      if (p.avisos && p.avisos.length) {
        el('dayFalta').classList.remove('hidden');
        el('dayFalta').innerHTML = p.avisos.map((a) => `• ${esc(a)}`).join('<br>');
      }
      return;
    }
    dia.previa = p;
    el('dayPreviewTexto').textContent = p.resumo;
    el('dayPreviewCusto').textContent =
      `${p.quantidadePerguntas} perguntas · ~${p.tokensAproximados} tokens · ` +
      `≈ US$ ${Number(p.custoEstimadoUSD).toFixed(6)}`;
    el('dayPreview').classList.remove('hidden');
    diaStatus(
      `Li ${p.mensagens.length} mensagem(ns) e ${p.eventos.length} compromisso(s). ` +
        'Confira o que sairia da sua máquina e aprove.'
    );
  } catch (err) {
    diaStatus(`Falhou: ${err.message}`, 'erro');
  } finally {
    dia.ocupado = false;
    el('btnDayResumo').disabled = false;
  }
}

/** Passo 2 (só após aprovação): o JEV decide. */
async function aprovarETriar() {
  if (dia.ocupado) return;
  dia.ocupado = true;
  el('btnDayAprovar').disabled = true;
  el('dayPreview').classList.add('hidden');
  diaStatus('O JEV está decidindo…', 'trabalhando');
  try {
    const t = await api.day.triar({});
    if (!t.ok) {
      diaStatus(t.erro || 'A triagem falhou.', 'erro');
      return;
    }
    dia.triagem = t;
    renderDia(t);
    const suspeitos = (t.suspeitos || []).length;
    diaStatus(
      `Pronto em ${(t.ms / 1000).toFixed(1)}s — US$ ${Number(t.custoUSD).toFixed(6)}. ` +
        `${t.filaDoDia.length} para hoje, ${t.revisar.length} incerta(s), ` +
        `${suspeitos} suspeita(s), ${t.ruido.length} descartável(is).`,
      suspeitos ? 'erro' : 'ok'
    );
  } catch (err) {
    diaStatus(`Falhou: ${err.message}`, 'erro');
  } finally {
    dia.ocupado = false;
    el('btnDayAprovar').disabled = false;
  }
}

function cartaoMensagem(m, opcoes) {
  const { comRascunho = false } = opcoes || {};
  const tags = [
    `<span class="tag">${esc(m.tipoRotulo)}${m.tipoConfiavel === false ? ' ?' : ''}</span>`,
    `<span class="tag ${/urgente/.test(m.urgenciaRotulo) ? 'quente' : 'frio'}">${esc(
      m.urgenciaRotulo
    )}</span>`,
    m.suspeito ? '<span class="tag suspeito">⚠ suspeito</span>' : '',
    m.precisaEscrever ? '<span class="tag ok">pede resposta sua</span>' : '',
    m.confianca != null
      ? `<span class="tag conf">JEV ${Math.round(m.confianca * 100)}%</span>`
      : '',
    m.anexos && m.anexos.length
      ? `<span class="tag">📎 ${esc(m.anexos.join(', '))}</span>`
      : '',
  ]
    .filter(Boolean)
    .join('');

  const rascunho = dia.rascunhos.get(m.uid);
  const caixaRascunho = rascunho !== undefined
    ? `<div class="rascunho" data-uid="${esc(m.uid)}">
         <div class="ras-top"><span>Rascunho do modelo local</span><span>revise antes de enviar</span></div>
         <textarea data-ras="${esc(m.uid)}">${esc(rascunho)}</textarea>
         <div class="ras-acoes">
           <button class="ghost-btn" data-ras-copiar="${esc(m.uid)}">Copiar</button>
           <button class="primary-btn" data-ras-enviar="${esc(m.uid)}">Enviar resposta</button>
         </div>
         <div class="aviso-janela">O envio é definitivo: vai sair da sua conta
           ${esc((dia.info && dia.info.credenciais.google.email) || '')} para
           ${esc(m.enderecoDe)}.</div>
       </div>`
    : '';

  return `<div class="msg-card">
    <div class="msg-card-top">
      <span class="msg-card-de">${esc(m.de)}</span>
      <span class="msg-card-data">${esc((m.data || '').slice(0, 31))}</span>
    </div>
    <div class="msg-card-assunto">${esc(m.assunto)}</div>
    <div class="msg-card-tags">${tags}</div>
    ${
      comRascunho
        ? `<div class="msg-card-acoes">
             <button class="ghost-btn" data-rascunhar="${esc(m.uid)}">✍️ Rascunhar resposta</button>
             <button class="ghost-btn" data-abrir="${esc(m.uid)}">👁 Ver mensagem</button>
           </div>`
        : ''
    }
    ${caixaRascunho}
  </div>`;
}

function cartaoEvento(e) {
  return `<div class="evento-card">
    <div class="msg-card-top">
      <span class="ev-hora">${esc(e.day)} · ${esc(e.time)}</span>
      <span class="msg-card-data">${e.essencial ? 'não perder' : ''}</span>
    </div>
    <div class="ev-titulo">${esc(e.title)}</div>
    ${e.location ? `<div class="ev-local">📍 ${esc(e.location)}</div>` : ''}
    <div class="msg-card-tags">
      ${
        e.preparoConfiavel && e.preparo !== 'nada'
          ? `<span class="tag">${esc(e.preparoRotulo)}</span>`
          : e.preparoConfiavel
            ? '<span class="tag">nada a preparar</span>'
            : '<span class="tag duvida">preparo incerto</span>'
      }
      ${e.repeats ? '<span class="tag">repete</span>' : ''}
      ${
        e.confianca != null
          ? `<span class="tag conf">JEV ${Math.round(e.confianca * 100)}%</span>`
          : ''
      }
    </div>
  </div>`;
}

function grupo(titulo, itens, classe, vazio) {
  if (!itens.length) return vazio ? '' : '';
  return `<div class="dia-grupo ${classe || ''}">
    <h4>${esc(titulo)} <span class="conta">${itens.length}</span></h4>
    ${itens.join('')}
  </div>`;
}

function renderDia(t) {
  const partes = [];

  if (t.eventos.length) {
    partes.push(
      grupo('Agenda', t.eventos.slice(0, 12).map(cartaoEvento), '')
    );
  }
  if (t.filaDoDia.length) {
    partes.push(
      grupo(
        'Responder hoje',
        t.filaDoDia.map((m) => cartaoMensagem(m, { comRascunho: true })),
        'hoje'
      )
    );
  }
  if (t.daSemana.length) {
    partes.push(
      grupo('Responder nesta semana', t.daSemana.map((m) => cartaoMensagem(m, { comRascunho: true })))
    );
  }
  if (t.revisar.length) {
    partes.push(
      grupo(
        'O JEV não teve certeza — decida você',
        t.revisar.map((m) => cartaoMensagem(m, { comRascunho: true })),
        'incerto'
      )
    );
  }
  if (t.suspeitos && t.suspeitos.length) {
    partes.push(
      grupo(
        'Suspeito — confira antes de apagar',
        t.suspeitos.map((m) => cartaoMensagem(m, { comRascunho: false })),
        'suspeito'
      )
    );
  }
  if (t.ruido.length) {
    partes.push(
      grupo(
        'Pode descartar sem ler',
        t.ruido.map((m) => cartaoMensagem(m)),
        ''
      )
    );
  }
  if (!partes.length) {
    partes.push('<p class="vazio">Nada pendente. Caixa limpa e agenda livre.</p>');
  }

  el('dayResultado').innerHTML = partes.join('');
}

/** Escreve um rascunho de resposta com o modelo local, em streaming. */
async function rascunharResposta(uid) {
  if (dia.ocupado) return;
  dia.ocupado = true;
  dia.rascunhos.set(uid, '');
  renderDia(dia.triagem);
  diaStatus('Escrevendo o rascunho… (o modelo local leva de 1 a 3 minutos)', 'trabalhando');

  try {
    await api.day.rascunho({ uid }, (m) => {
      if (m.type === 'token') {
        dia.rascunhos.set(uid, m.full);
        const area = document.querySelector(`textarea[data-ras="${uid}"]`);
        if (area) {
          area.value = m.full;
          area.scrollTop = area.scrollHeight;
        }
      } else if (m.type === 'done') {
        dia.rascunhos.set(uid, m.text || m.full || '');
        diaStatus('Rascunho pronto. Revise e envie quando quiser.', 'ok');
      } else if (m.type === 'error') {
        diaStatus(`Ao escrever: ${m.error}`, 'erro');
        dia.rascunhos.delete(uid);
        renderDia(dia.triagem);
      }
    });
  } catch (err) {
    diaStatus(`Falhou ao escrever: ${err.message}`, 'erro');
    dia.rascunhos.delete(uid);
    renderDia(dia.triagem);
  } finally {
    dia.ocupado = false;
  }
}

/** Envio em dois toques: o segundo confirma de verdade. */
async function enviarResposta(uid, botao) {
  const area = document.querySelector(`textarea[data-ras="${uid}"]`);
  const texto = area ? area.value.trim() : (dia.rascunhos.get(uid) || '').trim();
  if (!texto) {
    diaStatus('O rascunho está vazio.', 'erro');
    return;
  }
  if (botao.dataset.confirmado !== 'sim') {
    botao.dataset.confirmado = 'sim';
    botao.textContent = 'Confirmar envio';
    setTimeout(() => {
      if (botao.dataset.confirmado === 'sim') {
        botao.dataset.confirmado = 'nao';
        botao.textContent = 'Enviar resposta';
      }
    }, 6000);
    return;
  }

  botao.disabled = true;
  diaStatus('Enviando…', 'trabalhando');
  try {
    const r = await api.day.enviar({ uid, texto, confirmado: true });
    if (r.ok) {
      diaStatus('Resposta enviada. ✓', 'ok');
      dia.rascunhos.delete(uid);
      dia.triagem.mensagens = dia.triagem.mensagens.filter((m) => String(m.uid) !== String(uid));
      dia.triagem.filaDoDia = dia.triagem.filaDoDia.filter((m) => String(m.uid) !== String(uid));
      dia.triagem.daSemana = dia.triagem.daSemana.filter((m) => String(m.uid) !== String(uid));
      dia.triagem.revisar = dia.triagem.revisar.filter((m) => String(m.uid) !== String(uid));
      renderDia(dia.triagem);
    } else {
      diaStatus(`O Gmail recusou: ${r.erro}`, 'erro');
      botao.disabled = false;
    }
  } catch (err) {
    diaStatus(`Falha no envio: ${err.message}`, 'erro');
    botao.disabled = false;
  }
}

/** Resumo falado: triagem + modelo local, com a voz de sempre. */
async function resumoFalado() {
  if (dia.ocupado) return;
  dia.ocupado = true;
  el('btnDayResumo').disabled = true;
  el('dayPreview').classList.add('hidden');
  el('dayResultado').innerHTML = '';
  diaStatus('O JEV está classificando; depois o modelo local escreve…', 'trabalhando');

  let completo = '';
  // Abre a bolha antes de escrever: o usuário acompanha o texto aparecendo,
  // igual a uma conversa normal.
  state.botEl = addMessage('bot', '');
  try {
    await api.day.resumo({}, (m) => {
      if (m.type === 'triagem') {
        diaStatus(
          `JEV decidiu em ${(m.ms / 1000).toFixed(1)}s: ` +
            `${m.contagens.hoje} hoje, ${m.contagens.semana} na semana, ` +
            `${m.contagens.incerto} incertas. Agora o Nino está escrevendo…`,
          'trabalhando'
        );
      } else if (m.type === 'token') {
        completo = m.full;
        if (state.botEl) state.botEl.innerHTML = renderMarkdown(completo);
        const lista = el('messages');
        if (lista) lista.scrollTop = lista.scrollHeight;
        diaStatus(`Escrevendo… ${completo.length} caracteres`, 'trabalhando');
      } else if (m.type === 'done') {
        completo = m.text || completo;
        if (state.botEl) state.botEl.innerHTML = renderMarkdown(completo);
        dia.triagem = m.triagem || dia.triagem;
        renderDia(dia.triagem);
        diaStatus('Resumo pronto.', 'ok');
        if (api.voice && api.voice.speak) api.voice.speak(completo);
      } else if (m.type === 'error') {
        diaStatus(`Erro: ${m.error}`, 'erro');
        if (state.botEl && !completo) state.botEl.remove();
      } else if (m.type === 'aborted') {
        diaStatus('Interrompido.', '');
      } else if (m.erro || m.ok === false) {
        // Resposta não-streamada (ex.: JEV desligado ou triagem falhou).
        diaStatus(m.erro || 'Não consegui fazer o resumo.', 'erro');
        if (state.botEl && !completo) state.botEl.remove();
      }
    });
  } catch (err) {
    diaStatus(`Falhou: ${err.message}`, 'erro');
    if (state.botEl && !completo) state.botEl.remove();
  } finally {
    dia.ocupado = false;
    el('btnDayResumo').disabled = false;
  }
}

/* ---- credenciais ---- */

async function carregarCredenciais() {
  if (!api.day) return;
  try {
    const r = await api.day.credenciais();
    const c = r.credenciais;
    el('credCaminho').textContent = c.arquivo;
    el('jevKeyDica').textContent = c.typesafe.configurado
      ? `Já configurada: ${c.typesafe.dica} (deixe em branco para manter)`
      : 'Nada configurado ainda.';
    el('setGmailUser').value = c.google.email || '';
    el('setIcalUrl').value = c.google.agenda ? '••••••• (já configurado)' : '';
    el('setIcalUrl').dataset.configurado = c.google.agenda ? 'sim' : 'nao';
    el('setGmailPass').placeholder = c.google.senhaApp
      ? '••••••••  (já configurada — deixe em branco para manter)'
      : '16 letras, sem os espaços';

    const e = el('jevEstado');
    const linhas = [
      `JEV: ${c.typesafe.configurado ? '✓ chave configurada' : '— sem chave'}`,
      `Gmail: ${c.google.configurado ? `✓ ${esc(c.google.email)}` : '— não configurado'}`,
      `Agenda: ${c.google.agenda ? '✓ endereço configurado' : '— não configurada'}`,
    ];
    e.innerHTML = linhas.map((l) => `<div class="cred-linha">${l}</div>`).join('');
  } catch (err) {
    el('credMsg').textContent = `Não consegui ler as credenciais: ${err.message}`;
  }
}

async function salvarCredenciais() {
  const patch = { typesafe: {}, google: {} };
  const chave = el('setJevKey').value.trim();
  if (chave) patch.typesafe.apiKey = chave;

  const email = el('setGmailUser').value.trim();
  if (email) patch.google.email = email;
  const senha = el('setGmailPass').value.trim();
  if (senha) patch.google.appPassword = senha;
  const ical = el('setIcalUrl').value.trim();
  if (ical && !ical.startsWith('•')) patch.google.icalUrl = ical;

  el('credMsg').style.color = '#93a9b8';
  el('credMsg').textContent = 'Salvando e testando as conexões…';

  try {
    const r = await api.day.salvarCredenciais(patch);
    const falhas = [];
    if (r.jev && !r.jev.ok && r.jev.motivo !== 'sem_chave') {
      falhas.push(`JEV: ${r.jev.erro || r.jev.motivo}`);
    }
    if (r.email && !r.email.ok) falhas.push(`Gmail: ${r.email.erro}`);
    if (r.agenda && !r.agenda.ok) falhas.push(`Agenda: ${r.agenda.erro}`);

    el('setJevKey').value = '';
    el('setGmailPass').value = '';
    await carregarCredenciais();
    await carregarDia();

    if (falhas.length) {
      el('credMsg').style.color = '#ff9fb0';
      el('credMsg').textContent = falhas.join(' · ');
    } else {
      el('credMsg').style.color = '#4ade80';
      el('credMsg').textContent = 'Credenciais salvas e conexões testadas. ✓';
    }
  } catch (err) {
    el('credMsg').style.color = '#ff9fb0';
    el('credMsg').textContent = `Falhou: ${err.message}`;
  }
}

async function apagarCredenciais(botao) {
  if (botao.dataset.confirmado !== 'sim') {
    botao.dataset.confirmado = 'sim';
    botao.textContent = 'Confirmar: apagar tudo';
    setTimeout(() => {
      if (botao.dataset.confirmado === 'sim') {
        botao.dataset.confirmado = 'nao';
        botao.textContent = 'Apagar credenciais';
      }
    }, 6000);
    return;
  }
  await api.day.apagarCredenciais();
  botao.dataset.confirmado = 'nao';
  botao.textContent = 'Apagar credenciais';
  el('credMsg').style.color = '#93a9b8';
  el('credMsg').textContent = 'Credenciais apagadas do disco.';
  await carregarCredenciais();
  await carregarDia();
}

async function testarJev() {
  const saida = el('jevTesteSaida');
  saida.style.color = '#93a9b8';
  saida.textContent = 'Fazendo uma chamada real ao JEV…';
  try {
    const r = await api.day.testarJev();
    if (!r.ok) {
      saida.style.color = '#ff9fb0';
      saida.textContent = r.erro;
      return;
    }
    const a = r.respostas;
    saida.style.color = '#4ade80';
    saida.innerHTML =
      `O JEV respondeu em <b>${(r.ms / 1000).toFixed(2)}s</b> por ` +
      `<b>US$ ${Number(r.custoUSD).toFixed(6)}</b>:<br>` +
      `• força do lead: <b>${esc(String(a.forca_do_lead.rotulo || a.forca_do_lead.valor))}</b>` +
      (a.forca_do_lead.confianca != null
        ? ` (confiança ${Math.round(a.forca_do_lead.confianca * 100)}%)`
        : '') +
      `<br>• tipo: <b>${esc(a.tipo.valor)}</b><br>` +
      `• precisa de resposta pessoal: <b>${Math.round(
        (a.resposta_pessoal.probabilidade || 0) * 100
      )}%</b> de chance`;
  } catch (err) {
    saida.style.color = '#ff9fb0';
    saida.textContent = `Falhou: ${err.message}`;
  }
}


/* ---- conexão com o Google (OAuth) ---- */

const googleUI = { status: null, relogio: null };

function googleMsg(texto, cor) {
  const n = el('googleMsg');
  if (!n) return;
  n.textContent = texto || '';
  n.style.color = cor || '#93a9b8';
}

function googleAviso(texto) {
  const n = el('googleAviso');
  if (!n) return;
  if (!texto) {
    n.classList.add('hidden');
    n.innerHTML = '';
    return;
  }
  n.classList.remove('hidden');
  n.innerHTML = texto;
}

function renderGoogle(st) {
  googleUI.status = st;
  const e = el('googleEstado');
  if (!e) return;
  const linhas = [];
  if (st.conectado) {
    linhas.push(
      `✓ Conectado${st.email ? ` como <b>${esc(st.email)}</b>` : ''}` +
        (st.funcionando === false ? ' — mas a leitura falhou' : '')
    );
  } else if (st.clienteConfigurado) {
    linhas.push('Cliente OAuth informado — falta autorizar no navegador.');
  } else {
    linhas.push('— sem cliente OAuth configurado');
  }
  if (st.dicaCliente) linhas.push(`client_id: ${esc(st.dicaCliente)}`);
  if (st.caminhoEmail) {
    linhas.push(
      `E-mail em uso: <b>${esc(st.caminhoEmail === 'oauth' ? 'API do Google' : 'IMAP e SMTP')}</b>`
    );
  }
  if (st.caminhoAgenda) {
    linhas.push(
      `Agenda em uso: <b>${esc(st.caminhoAgenda === 'oauth' ? 'API do Google Agenda' : 'endereço secreto do iCal')}</b>`
    );
  }
  e.innerHTML = linhas.map((l) => `<div class="cred-linha">${l}</div>`).join('');

  const b = el('btnGoogleConectar');
  if (b) b.textContent = st.conectado ? 'Reconectar' : 'Conectar com o Google';
  const d = el('btnGoogleDesconectar');
  if (d) d.classList.toggle('hidden', !st.conectado);
  if (st.erro) googleMsg(st.erro, '#ff9fb0');
}

async function carregarGoogle() {
  if (!api.day || !api.day.googleStatus) return;
  try {
    renderGoogle(await api.day.googleStatus());
    // Salvou o client_id sem conectar? Já avisa o que falta.
    if (googleUI.status && googleUI.status.clienteConfigurado && !googleUI.status.conectado) {
      // não dispara diagnóstico sozinho: só quando o usuário pedir
    }
  } catch (err) {
    googleMsg(`Não consegui ler o estado do Google: ${err.message}`, '#ff9fb0');
  }
}

async function conectarGoogle() {
  const patch = {};
  const cid = el('setGoogleClientId').value.trim();
  const sec = el('setGoogleSecret').value.trim();
  if (cid) patch.clientId = cid;
  if (sec) patch.clientSecret = sec;

  googleMsg('Preparando a autorização…');
  googleAviso('');
  el('googleDiag').classList.add('hidden');
  try {
    const r = await api.day.googleConectar(patch);
    if (!r.ok) {
      googleMsg(r.erro, '#ff9fb0');
      return;
    }
    el('setGoogleSecret').value = '';
    const nota = r.descoberto
      ? `<br><b>Endereço de retorno aceito:</b> ${esc(r.redirecionamento)}` +
        '<br><span style="opacity:.8">Descobri sozinho qual URI este projeto já tem cadastrada — você não precisa mexer no console.</span>'
      : `<br><b>Endereço de retorno:</b> ${esc(r.redirecionamento)}`;
    googleAviso(
      'Autorize no navegador que abriu. Se não abriu, use este endereço:<br>' +
        `<a href="${esc(r.url)}" target="_blank" rel="noopener" style="color:#48d6e8;word-break:break-all">${esc(r.url)}</a>` +
        nota
    );
    googleMsg('Esperando você autorizar no Google…');
    esperarGoogle();
  } catch (err) {
    googleMsg(`Falhou: ${err.message}`, '#ff9fb0');
  }
}

/** Enquanto o navegador está aberto, pergunta ao servidor se já voltou. */
function esperarGoogle() {
  if (googleUI.relogio) clearInterval(googleUI.relogio);
  let tentativas = 0;
  googleUI.relogio = setInterval(async () => {
    tentativas += 1;
    try {
      const st = await api.day.googleStatus();
      renderGoogle(st);
      if (st.conectado) {
        clearInterval(googleUI.relogio);
        googleUI.relogio = null;
        googleAviso('');
        googleMsg('Conectado! ✓ Já pode usar "Meu dia".', '#4ade80');
        await carregarCredenciais();
        await carregarDia();
        return;
      }
    } catch {
      /* segue tentando */
    }
    if (tentativas > 100) {
      clearInterval(googleUI.relogio);
      googleUI.relogio = null;
      googleMsg('Desisti de esperar. Clique em "Conectar" para tentar de novo.');
    }
  }, 2000);
}

async function diagnosticarGoogle() {
  const caixa = el('googleDiag');
  googleMsg('Conferindo o projeto no Google…');
  googleAviso('');
  try {
    const r = await api.day.googleDiagnostico();
    const partes = [];
    if (r.problemas && r.problemas.length) {
      for (const p of r.problemas) {
        partes.push(`<b>✗ ${esc(p.campo)}</b>: ${esc(p.erro)}`);
        if (p.comoResolver) partes.push(`&nbsp;&nbsp;↳ ${esc(p.comoResolver)}`);
      }
    }
    if (r.itensOk && r.itensOk.length) {
      for (const i of r.itensOk) partes.push(`✓ ${esc(i)}`);
    }
    if (r.descoberta && r.descoberta.tentados && r.descoberta.tentados.length > 1) {
      const tentados = r.descoberta.tentados
        .map((t) => `${t.estado === 'aceito' ? '✓' : '·'} ${esc(t.uri)}`)
        .join('<br>');
      partes.push(`<br>Endereços testados:<br>${tentados}`);
    }
    if (r.avisoSeteDias) partes.push(`<br>⚠ ${esc(r.avisoSeteDias)}`);
    caixa.classList.remove('hidden');
    caixa.innerHTML = partes.join('<br>');
    googleMsg(
      r.ok ? 'Tudo pronto para conectar.' : 'Encontrei o que está faltando (veja acima).',
      r.ok ? '#4ade80' : '#f0c674'
    );
  } catch (err) {
    googleMsg(`O diagnóstico falhou: ${err.message}`, '#ff9fb0');
  }
}

async function desconectarGoogle(botao) {
  if (botao.dataset.confirmado !== 'sim') {
    botao.dataset.confirmado = 'sim';
    botao.textContent = 'Confirmar desconexão';
    setTimeout(() => {
      if (botao.dataset.confirmado === 'sim') {
        botao.dataset.confirmado = 'nao';
        botao.textContent = 'Desconectar do Google';
      }
    }, 6000);
    return;
  }
  await api.day.googleDesconectar();
  botao.dataset.confirmado = 'nao';
  botao.textContent = 'Desconectar do Google';
  googleMsg('Autorização removida do cofre.', '#93a9b8');
  googleAviso('');
  await carregarGoogle();
  await carregarCredenciais();
}

function setupDay() {
  if (!api.day) return;

  // Os cartões são criados dinamicamente: um ouvinte só, na raiz.
  el('dayResultado').addEventListener('click', (ev) => {
    const alvo = ev.target.closest('button');
    if (!alvo) return;
    const rascunhar = alvo.getAttribute('data-rascunhar');
    if (rascunhar) return void rascunharResposta(rascunhar);
    const enviar = alvo.getAttribute('data-ras-enviar');
    if (enviar) return void enviarResposta(enviar, alvo);
    const copiar = alvo.getAttribute('data-ras-copiar');
    if (copiar) {
      const area = document.querySelector(`textarea[data-ras="${copiar}"]`);
      if (area) {
        navigator.clipboard.writeText(area.value).then(
          () => diaStatus('Rascunho copiado. ✓', 'ok'),
          () => diaStatus('Não consegui copiar.', 'erro')
        );
      }
      return;
    }
    const abrir = alvo.getAttribute('data-abrir');
    if (abrir && dia.triagem) {
      const m = dia.triagem.mensagens.find((x) => String(x.uid) === String(abrir));
      if (m) {
        const trecho = (m.trecho || '(corpo não carregado)').slice(0, 1200);
        addMessage('bot', `De ${m.de} — ${m.assunto}:\n\n${trecho}`);
        setView('chat');
      }
    }
  });

  el('btnDayResumo').addEventListener('click', pedirPrevia);
  el('btnDayRecarregar').addEventListener('click', () => {
    dia.triagem = null;
    dia.rascunhos.clear();
    el('dayResultado').innerHTML = '';
    carregarDia();
  });
  el('btnDayAprovar').addEventListener('click', aprovarETriar);
  el('btnDayCancelar').addEventListener('click', () => {
    el('dayPreview').classList.add('hidden');
    diaStatus('Envio ao JEV cancelado. Nada saiu da sua máquina.');
  });

  const salvarCred = el('btnSalvarCredenciais');
  if (salvarCred) salvarCred.addEventListener('click', salvarCredenciais);
  const apagarCred = el('btnApagarCredenciais');
  if (apagarCred) apagarCred.addEventListener('click', () => apagarCredenciais(apagarCred));
  const testar = el('btnJevTeste');
  if (testar) testar.addEventListener('click', testarJev);

  const conectar = el('btnGoogleConectar');
  if (conectar) conectar.addEventListener('click', conectarGoogle);
  const diag = el('btnGoogleDiagnostico');
  if (diag) diag.addEventListener('click', diagnosticarGoogle);
  const desc = el('btnGoogleDesconectar');
  if (desc) desc.addEventListener('click', () => desconectarGoogle(desc));
}
