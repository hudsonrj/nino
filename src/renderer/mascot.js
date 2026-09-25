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

  if (!state.open) setOpen(true);

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

async function sendVision(mode) {
  if (state.busy) {
    api.chat.abort();
    return;
  }
  if (!state.open) setOpen(true);

  addMessage(
    'user',
    mode === 'camera' ? '📷 Olhe para mim e diga o que você vê' : '🖥️ Olhe minha tela e explique'
  );

  el('sources').classList.add('hidden');
  state.botText = '';
  state.botEl = addMessage('bot', '');
  state.botEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  state.waitingOn = mode;
  setBusy(true);
  showBubble(mode === 'camera' ? '📷 Deixa eu te ver…' : '🖥️ Deixa eu olhar sua tela…', 3500);

  // Os tokens chegam pelos mesmos eventos da conversa (chat:token/chat:done).
  const res = await api.vision.capture(mode);
  if (res && res.ok === false && !res.aborted && state.botEl) {
    // chat:error já tratou de mostrar a mensagem; só limpamos o estado.
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
    if (!disp.enabled) {
      btnCam.classList.add('hidden');
      btnScr.classList.add('hidden');
    } else {
      if (!disp.camera) btnCam.classList.add('hidden');
      if (!disp.screen) btnScr.classList.add('hidden');
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
    ['kb', el('btnKb'), 'viewKb'],
    ['settings', el('btnSettings'), 'viewSettings'],
  ]) {
    const active = name === view;
    btn.classList.toggle('active', active);
    el(viewId).classList.toggle('active', active);
  }
  if (view === 'kb') loadKb();
  if (view === 'settings') loadSettings();
}

function setupNav() {
  el('btnChat').addEventListener('click', () => setView('chat'));
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
