'use strict';

/**
 * Ponte do modo web.
 *
 * Implementa exatamente a mesma API `window.nino` que o preload do Electron
 * expõe, só que falando HTTP com src/server/web.js. Assim a interface
 * (mascot.js) roda sem nenhuma alteração nos dois modos.
 *
 * Se o Electron já tiver definido window.nino, este arquivo não faz nada.
 */

(function () {
  if (window.nino) return;

  /**
   * Quando a interface é carregada dentro do shell nativo do Windows, o
   * preload dele define `__ninoShell` com os controles de janela de verdade.
   * No navegador puro esse objeto não existe.
   */
  const shell = window.__ninoShell || null;

  /* ------------------------------------------------------------------ */
  /* Eventos                                                            */
  /* ------------------------------------------------------------------ */

  const listeners = new Map();

  function on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel) && listeners.get(channel).delete(fn);
  }

  function emit(channel, payload) {
    const set = listeners.get(channel);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[ponte] erro no ouvinte de ${channel}:`, err);
      }
    }
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return res.json();
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return res.json();
  }

  /* ------------------------------------------------------------------ */
  /* Fala (Piper no servidor, reprodução no navegador)                  */
  /* ------------------------------------------------------------------ */

  const audioQueue = [];
  let currentAudio = null;
  let audioBusy = false;
  let audioUnlocked = false;
  // '' = dispositivo padrão do sistema. Um deviceId força uma saída específica
  // (útil quando o padrão é um headset Bluetooth que não está no ouvido).
  let sinkId = '';

  /**
   * Os navegadores só liberam áudio depois de uma interação do usuário.
   * Tocamos um WAV silencioso no primeiro clique para destravar a saída.
   */
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const silencio = new Audio(
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA='
      );
      silencio.volume = 0;
      silencio.play().catch(() => {});
    } catch {
      /* ignora */
    }
  }
  window.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  window.addEventListener('keydown', unlockAudio, { once: true, capture: true });

  function pumpAudio() {
    if (audioBusy || !audioQueue.length) return;
    audioBusy = true;
    emit('tts:state', { speaking: true });
    const url = audioQueue.shift();
    const audio = new Audio(url);
    currentAudio = audio;
    const finish = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      audioBusy = false;
      if (audioQueue.length) pumpAudio();
      else emit('tts:state', { speaking: false });
    };

    const tocar = () => {
      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch((err) => {
        console.error('[fala] o navegador bloqueou a reprodução:', err.message);
        emit('audio:error', {
          error:
            'O navegador bloqueou o áudio. Clique uma vez na página e pergunte de novo — ' +
            'ele só libera som depois de uma interação sua.',
        });
        finish();
      });
    };

    // Direciona para a saída escolhida, quando houver uma.
    if (sinkId && typeof audio.setSinkId === 'function') {
      audio
        .setSinkId(sinkId)
        .then(tocar)
        .catch((err) => {
          console.error('[fala] não consegui usar a saída escolhida:', err.message);
          emit('audio:error', {
            error: `Não consegui usar a saída de áudio escolhida (${err.name}). Usando a padrão.`,
          });
          sinkId = '';
          tocar();
        });
    } else {
      tocar();
    }
  }

  /** Lista as saídas de áudio disponíveis. */
  async function listOutputs() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Saída sem nome' }));
    } catch (err) {
      console.error('[áudio] não consegui listar as saídas:', err.message);
      return [];
    }
  }

  /** Troca a saída de áudio e guarda a escolha nos ajustes. */
  async function setOutput(deviceId) {
    sinkId = deviceId || '';
    try {
      await postJson('/api/settings', { patch: { audioOutput: sinkId } });
    } catch {
      /* a escolha vale só nesta sessão */
    }
    // Toca um aviso curto na saída nova.
    speak('Saída de áudio alterada.');
    return { ok: true, sinkId };
  }

  async function speak(text) {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return { ok: false };
      const blob = await res.blob();
      if (!blob.size) return { ok: false };
      audioQueue.push(URL.createObjectURL(blob));
      pumpAudio();
      return { ok: true };
    } catch (err) {
      console.error('[fala]', err.message);
      return { ok: false, error: err.message };
    }
  }

  function stopSpeaking() {
    audioQueue.length = 0;
    if (currentAudio) {
      try {
        currentAudio.pause();
      } catch {
        /* ignora */
      }
      currentAudio = null;
    }
    audioBusy = false;
    emit('tts:state', { speaking: false });
  }

  /* ---------------------- Fala em streaming ------------------------- */

  let ttsEnabled = true;

  async function refreshTtsFlag() {
    try {
      const s = await getJson('/api/settings');
      ttsEnabled = !!(s && s.ttsEnabled);
      sinkId = (s && s.audioOutput) || '';
    } catch {
      /* mantém o valor atual */
    }
  }

  /**
   * Extrai frases completas do texto que chega em streaming.
   * Mesma lógica do chat.js do lado do servidor: enquanto houver bloco de
   * código aberto, não fala nada.
   */
  function takeSpeech(buf, force) {
    const inCode = (buf.match(/```/g) || []).length % 2 === 1;
    if (inCode && !force) return { flush: '', rest: buf };
    if (force) return { flush: buf.trim(), rest: '' };
    const parts = buf.split(/(?<=[.!?…])\s+/);
    if (parts.length < 2) return { flush: '', rest: buf };
    const rest = parts.pop();
    const flush = parts.join(' ').trim();
    if (flush.length < 20) return { flush: '', rest: buf };
    return { flush, rest };
  }

  /* ------------------------------------------------------------------ */
  /* Escuta (MediaRecorder + detecção de silêncio)                      */
  /* ------------------------------------------------------------------ */

  let recording = null;

  function pickMimeType() {
    const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const type of options) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  async function startListening() {
    if (recording) return { ok: false, error: 'Já estou ouvindo' };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      const msg =
        err.name === 'NotAllowedError'
          ? 'Permissão de microfone negada. Autorize o microfone no navegador.'
          : `Não foi possível abrir o microfone: ${err.message}`;
      emit('audio:error', { error: msg });
      return { ok: false, error: msg };
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];

    // Detecção simples de fala: mede o volume e para após um silêncio.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);

    let spoke = false;
    let silenceMs = 0;
    let elapsedMs = 0;
    let noiseFloor = null;
    let maxRms = 0;
    let threshold = 0.008;

    const tick = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);
      if (rms > maxRms) maxRms = rms;

      elapsedMs += 100;
      // Piso de ruído com média móvel: acompanha ambientes barulhentos.
      noiseFloor = noiseFloor === null ? rms : noiseFloor * 0.95 + rms * 0.05;
      // Limiar generoso: microfones de headset costumam ser baixos.
      threshold = Math.max(0.006, noiseFloor * 2.2);

      if (rms > threshold) {
        spoke = true;
        silenceMs = 0;
      } else if (spoke) {
        silenceMs += 100;
        if (silenceMs > 1400) stopListening();
      }
      if (elapsedMs > 30000) stopListening();

      // Nível ao vivo: a interface mostra que o microfone está captando.
      emit('audio:level', { rms: Number(rms.toFixed(4)), max: Number(maxRms.toFixed(4)), threshold: Number(threshold.toFixed(4)) });
    }, 100);

    const cleanup = () => {
      clearInterval(tick);
      try {
        ctx.close();
      } catch {
        /* ignora */
      }
      for (const track of stream.getTracks()) track.stop();
    };

    recording = {
      recorder,
      stream,
      cleanup,
      stop: () => {
        if (recorder.state !== 'inactive') recorder.stop();
      },
    };

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };

    recorder.onstop = async () => {
      cleanup();
      recording = null;

      // Só desiste se não houve som nenhum: a detecção de fala pode falhar em
      // microfones baixos, então na dúvida mandamos para o Whisper decidir.
      const houveSom = maxRms > 0.003;
      if (!chunks.length || (!spoke && !houveSom)) {
        emit('audio:state', { state: 'idle' });
        emit('audio:error', {
          error:
            'Não captei nenhum som. Confira no Windows se o microfone certo está ' +
            'selecionado (Configurações → Sistema → Som → Entrada).',
        });
        return;
      }

      emit('audio:state', { state: 'transcribing' });
      try {
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        const ext = (mimeType || 'audio/webm').includes('ogg') ? 'ogg' : 'webm';
        const res = await fetch(`/api/stt?ext=${ext}`, { method: 'POST', body: blob });
        const data = await res.json();
        emit('audio:state', { state: 'idle' });
        if (!data.ok) {
          emit('audio:error', { error: data.error || 'falha na transcrição' });
          return;
        }
        if (!data.text) {
          emit('audio:error', { error: 'Não consegui entender o áudio.' });
          return;
        }
        emit('audio:transcript', { text: data.text, duration: data.duration });
      } catch (err) {
        emit('audio:state', { state: 'idle' });
        emit('audio:error', { error: `Transcrição: ${err.message}` });
      }
    };

    recorder.start();
    emit('audio:state', { state: 'listening' });
    return { ok: true };
  }

  function stopListening() {
    if (recording) recording.stop();
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* Janela flutuante (Document Picture-in-Picture)                      */
  /* ------------------------------------------------------------------ */

  let pipWindow = null;

  function supportsPip() {
    return 'documentPictureInPicture' in window;
  }

  function copyStyles(target) {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const css = Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join('\n');
        const style = target.document.createElement('style');
        style.textContent = css;
        target.document.head.appendChild(style);
      } catch {
        if (sheet.href) {
          const link = target.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          target.document.head.appendChild(link);
        }
      }
    }
  }

  async function floatWindow() {
    if (!supportsPip()) {
      emit('app:clickThrough', { enabled: false });
      window.alert(
        'Seu navegador não suporta janela flutuante (Document Picture-in-Picture).\n\n' +
          'Use o Chrome ou o Edge atualizado. Enquanto isso, deixe esta aba aberta ' +
          'numa janela pequena no canto da tela.'
      );
      return { ok: false };
    }
    if (pipWindow) {
      pipWindow.focus();
      return { ok: true };
    }

    const pip = await documentPictureInPicture.requestWindow({ width: 460, height: 690 });
    pipWindow = pip;

    // O PiP abre num documento novo: recria estilos e move a interface.
    pip.document.documentElement.style.height = '100%';
    pip.document.title = 'Nino';
    copyStyles(pip);
    const bg = pip.document.createElement('style');
    bg.textContent =
      'html,body{margin:0;height:100%;background:transparent !important;overflow:hidden}' +
      '.stage{padding:4px}';
    pip.document.head.appendChild(bg);

    pip.document.body.append(document.getElementById('stage'));

    pip.addEventListener('pagehide', () => {
      document.body.append(document.getElementById('stage'));
      pipWindow = null;
      emit('app:clickThrough', { enabled: false });
    });

    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* Arquivos                                                           */
  /* ------------------------------------------------------------------ */

  const ACCEPT = [
    '.pdf', '.epub', '.docx', '.odt', '.txt', '.md', '.markdown', '.html', '.htm',
    '.rtf', '.csv', '.json', '.xml', '.srt', '.vtt',
  ].join(',');

  function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = ACCEPT;
      input.style.display = 'none';
      document.body.appendChild(input);

      let settled = false;
      const done = (files) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(files);
      };

      input.addEventListener('change', () => done(Array.from(input.files || [])));
      // Cancelar o seletor não dispara "change"; o foco de volta resolve.
      window.addEventListener('focus', () => setTimeout(() => done([]), 700), { once: true });
      input.click();
    });
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return { canceled: true };
    const report = [];
    let stats = null;

    for (const file of files) {
      emit('kb:progress', { stage: 'lendo', file: file.name, done: 0, total: 1 });
      try {
        const res = await fetch(`/api/kb/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
        });
        const data = await res.json();
        if (data.report) report.push(...data.report);
        if (data.stats) stats = data.stats;
        if (!data.ok && data.error) report.push({ file: file.name, ok: false, error: data.error });
      } catch (err) {
        report.push({ file: file.name, ok: false, error: err.message });
      }
    }

    emit('kb:progress', { stage: 'fim', file: '', done: 1, total: 1 });
    emit('kb:changed', { stats });
    return { ok: true, report, stats };
  }

  // Arrastar e soltar sobre a página.
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) uploadFiles(files);
  });

  /* ------------------------------------------------------------------ */
  /* Conversa                                                           */
  /* ------------------------------------------------------------------ */

  let chatAbort = null;
  let speechBuffer = '';

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'token') {
      emit('chat:token', { token: msg.token, full: msg.full });
      // Fala conforme as frases ficam completas — sem esperar a resposta toda.
      if (ttsEnabled) {
        speechBuffer += msg.token;
        let slice;
        while ((slice = takeSpeech(speechBuffer, false)).flush) {
          speak(slice.flush);
          speechBuffer = slice.rest;
        }
      }
    } else if (msg.type === 'sources') {
      emit('chat:sources', { sources: msg.sources });
    } else if (msg.type === 'done') {
      if (ttsEnabled) {
        const tail = takeSpeech(speechBuffer, true).flush;
        if (tail) speak(tail);
      }
      speechBuffer = '';
      emit('chat:done', { text: msg.text, stats: msg.stats, sources: msg.sources || [] });
    } else if (msg.type === 'aborted') {
      speechBuffer = '';
      emit('chat:aborted', {});
    } else if (msg.type === 'error') {
      emit('chat:error', { error: msg.error, recoverable: msg.recoverable });
    }
  }

  /** Lê uma resposta NDJSON do servidor e entrega cada mensagem. */
  async function streamRequest(url, body, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      let detalhe = '';
      try {
        detalhe = (await res.json()).error || '';
      } catch {
        /* resposta sem JSON */
      }
      throw new Error(detalhe || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
  }

  async function startChat(text) {
    if (chatAbort) chatAbort.abort();
    const controller = new AbortController();
    chatAbort = controller;
    speechBuffer = '';

    try {
      await streamRequest('/api/chat', { text }, controller.signal);
    } catch (err) {
      if (err.name === 'AbortError') emit('chat:aborted', {});
      else emit('chat:error', { error: `Não consegui falar com o servidor: ${err.message}` });
    } finally {
      if (chatAbort === controller) chatAbort = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Visão: câmera e tela                                                */
  /* ------------------------------------------------------------------ */

  let cameraStream = null;

  /** Reduz a imagem para o lado máximo configurado e devolve um data URL. */
  function frameToDataUrl(source, sourceWidth, sourceHeight, maxSide) {
    const lado = Math.max(sourceWidth, sourceHeight) || 1;
    const escala = Math.min(1, (maxSide || 640) / lado);
    const w = Math.max(1, Math.round(sourceWidth * escala));
    const h = Math.max(1, Math.round(sourceHeight * escala));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  function stopCamera() {
    if (cameraStream) {
      for (const track of cameraStream.getTracks()) track.stop();
      cameraStream = null;
    }
  }

  /**
   * Tira uma foto pela câmera.
   * A câmera é ligada só durante a captura e desligada em seguida.
   */
  async function captureCamera(maxSide) {
    try {
      if (!cameraStream) {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
      }
    } catch (err) {
      const msg =
        err.name === 'NotAllowedError'
          ? 'Permissão de câmera negada. Autorize a câmera e tente de novo.'
          : `Não consegui abrir a câmera: ${err.message}`;
      throw new Error(msg);
    }

    const video = document.createElement('video');
    video.srcObject = cameraStream;
    video.muted = true;
    video.playsInline = true;

    try {
      await video.play();
      // Espera o primeiro quadro de verdade.
      if (!video.videoWidth) {
        await new Promise((resolve) => {
          const pronto = () => resolve();
          video.addEventListener('loadeddata', pronto, { once: true });
          setTimeout(pronto, 2000);
        });
      }
      if (!video.videoWidth) throw new Error('A câmera não entregou imagem');
      return frameToDataUrl(video, video.videoWidth, video.videoHeight, maxSide);
    } finally {
      video.srcObject = null;
      stopCamera();
    }
  }

  /** Tira uma foto da tela. */
  async function captureScreen(maxSide) {
    // 1. No shell do Windows o processo principal captura direto, sem pedir
    //    permissão nem mostrar seletor.
    if (shell && typeof shell.captureScreen === 'function') {
      const res = await shell.captureScreen(maxSide);
      if (!res || !res.dataUrl) throw new Error(res && res.error ? res.error : 'captura falhou');
      return res.dataUrl;
    }

    // 2. No navegador é preciso getDisplayMedia (o navegador mostra o seletor).
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      if (err.name === 'NotAllowedError') throw new Error('Captura de tela cancelada.');
      throw new Error(`Não consegui capturar a tela: ${err.message}`);
    }

    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    try {
      await video.play();
      if (!video.videoWidth) {
        await new Promise((resolve) => {
          video.addEventListener('loadeddata', resolve, { once: true });
          setTimeout(resolve, 2000);
        });
      }
      if (!video.videoWidth) throw new Error('A tela não entregou imagem');
      return frameToDataUrl(video, video.videoWidth, video.videoHeight, maxSide);
    } finally {
      video.srcObject = null;
      for (const track of stream.getTracks()) track.stop();
    }
  }

  /**
   * Captura e manda para o modelo de visão.
   * Usa os mesmos eventos da conversa (chat:token/chat:done/chat:error), então
   * a interface não precisa saber que veio de uma imagem.
   *
   * @param {'camera'|'screen'} mode
   * @param {{question?:string, keepCamera?:boolean}} [opts]
   */
  async function capture(mode, opts = {}) {
    if (chatAbort) chatAbort.abort();
    const controller = new AbortController();
    chatAbort = controller;
    speechBuffer = '';

    const settings = await getJson('/api/settings').catch(() => ({}));
    const maxSide = settings.maxImageSide || 640;

    try {
      const image = mode === 'camera' ? await captureCamera(maxSide) : await captureScreen(maxSide);
      emit('vision:state', { state: 'analisando', mode, bytes: image.length });

      await streamRequest(
        '/api/vision',
        { image, mode, question: opts.question || '' },
        controller.signal
      );
      emit('vision:state', { state: 'idle', mode });
      return { ok: true };
    } catch (err) {
      emit('vision:state', { state: 'idle', mode });
      if (err.name === 'AbortError') {
        emit('chat:aborted', {});
        return { ok: false, aborted: true };
      }
      emit('chat:error', { error: err.message });
      return { ok: false, error: err.message };
    } finally {
      if (chatAbort === controller) chatAbort = null;
    }
  }

  /** A visão está disponível neste ambiente? */
  async function available() {
    const temCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const temTelaNoShell = !!(shell && typeof shell.captureScreen === 'function');
    const temTelaNoNavegador = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    let config = {};
    try {
      config = await getJson('/api/settings');
    } catch {
      /* usa os padrões abaixo */
    }
    return {
      camera: temCamera && config.cameraEnabled !== false,
      screen: (temTelaNoShell || temTelaNoNavegador) && config.screenEnabled !== false,
      enabled: config.visionEnabled !== false,
      model: config.visionModel || config.model,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Eventos do servidor (progresso da indexação)                        */
  /* ------------------------------------------------------------------ */

  function connectEvents() {
    try {
      const source = new EventSource('/api/events');
      source.addEventListener('kb-progress', (e) => emit('kb:progress', JSON.parse(e.data)));
      source.addEventListener('kb-changed', (e) => emit('kb:changed', JSON.parse(e.data)));
      source.onerror = () => {
        // Reconecta sozinho depois de um tempo.
        source.close();
        setTimeout(connectEvents, 4000);
      };
    } catch {
      /* sem SSE: a interface continua funcionando */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Botão "Flutuar"                                                    */
  /* ------------------------------------------------------------------ */

  function injectFloatButton() {
    // Na janela nativa já estamos flutuando: o botão não faz sentido.
    if (shell) return;
    const actions = document.querySelector('.head-actions');
    if (!actions || document.getElementById('btnFloat')) return;
    const btn = document.createElement('button');
    btn.id = 'btnFloat';
    btn.className = 'icon-btn';
    btn.title = supportsPip()
      ? 'Flutuar numa janela sempre no topo'
      : 'Janela flutuante (requer Chrome ou Edge)';
    btn.textContent = '🪟';
    btn.addEventListener('click', floatWindow);
    actions.insertBefore(btn, actions.firstChild);
  }

  /* ------------------------------------------------------------------ */
  /* API exposta                                                        */
  /* ------------------------------------------------------------------ */

  window.nino = {
    isWeb: true,
    supportsPip,

    chat: {
      send: (text) => {
        startChat(text);
        return { ok: true };
      },
      abort: () => {
        if (chatAbort) chatAbort.abort();
        stopSpeaking();
        return { ok: true };
      },
      reset: () => postJson('/api/chat/reset').catch(() => ({ ok: false })),
      onToken: (fn) => on('chat:token', fn),
      onDone: (fn) => on('chat:done', fn),
      onError: (fn) => on('chat:error', fn),
      onAborted: (fn) => on('chat:aborted', fn),
    },

    voice: {
      speak,
      stop: () => {
        stopSpeaking();
        return { ok: true };
      },
      listen: () => {
        startListening();
        return { ok: true };
      },
      stopListening: () => stopListening(),
      onTtsState: (fn) => on('tts:state', fn),
      onAudioState: (fn) => on('audio:state', fn),
      onTranscript: (fn) => on('audio:transcript', fn),
      onError: (fn) => on('audio:error', fn),
      onLevel: (fn) => on('audio:level', fn),
      outputs: listOutputs,
      setOutput,
      currentOutput: () => sinkId,
      test: () => {
        speak('Teste de voz do Nino. Se você está ouvindo esta frase, a fala está funcionando.');
        return { ok: true };
      },
    },

    kb: {
      addViaDialog: async () => {
        const files = await pickFiles();
        return uploadFiles(files);
      },      addPaths: () => ({ ok: false, error: 'No navegador, use o seletor ou arraste arquivos' }),
      list: () => getJson('/api/kb'),
      remove: (id) => postJson('/api/kb/remove', { id }),
      clear: () => postJson('/api/kb/clear'),
      stats: async () => (await getJson('/api/kb')).stats,
      search: async (query) => ({ hits: [], query }),
      onProgress: (fn) => on('kb:progress', fn),
      onChanged: (fn) => on('kb:changed', fn),
    },

    vision: {
      capture,
      available,
      stopCamera,
      onState: (fn) => on('vision:state', fn),
    },

    settings: {
      get: () => getJson('/api/settings'),
      set: async (patch) => {
        const res = await postJson('/api/settings', { patch });
        if (res && res.settings) ttsEnabled = !!res.settings.ttsEnabled;
        return res;
      },
    },

    system: {
      status: () => getJson('/api/status'),
      voices: async () => (await getJson('/api/status')).voices,
      models: () => getJson('/api/models'),
      openDataFolder: () => ({ ok: false, error: 'Disponível apenas no app de desktop' }),
      quit: () => (shell ? shell.quit() : postJson('/api/quit')),
      onReady: (fn) => on('app:ready', fn),
      onClickThrough: (fn) => on('app:clickThrough', fn),
    },

    win: {
      dragStart: () => (shell ? shell.dragStart() : { ok: true }),
      dragMove: () => ({ ok: true }),
      dragEnd: () => (shell ? shell.dragEnd() : { ok: true }),
      resize: (width, height) => {
        // Janela nativa (shell do Windows): redimensiona de verdade.
        if (shell) return shell.resize(width, height);
        // Navegador: redimensiona a janela flutuante, quando aberta.
        if (pipWindow) {
          try {
            pipWindow.resizeTo(width, height);
          } catch {
            /* alguns navegadores limitam o redimensionamento */
          }
        }
        return { ok: true };
      },
      hide: () => (shell ? shell.hide() : { ok: true }),
      clickThrough: (enabled) => (shell ? shell.clickThrough(enabled) : { ok: true }),
    },
  };

  connectEvents();
  refreshTtsFlag();

  /**
   * No navegador a página precisa de um fundo próprio. No shell do Windows a
   * janela é transparente e sempre no topo: pintar o fundo criaria um
   * retângulo escuro em volta do mascote. Lá o entorno fica vazado.
   */
  function paintPageBackground() {
    if (shell) {
      document.documentElement.style.background = 'transparent';
      document.body.style.background = 'transparent';
      document.body.classList.add('shell');
      return;
    }
    document.documentElement.style.background = '#0d141c';
    document.body.style.background = 'linear-gradient(160deg,#22303d 0%,#0e161e 55%,#0b1219 100%)';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      paintPageBackground();
      injectFloatButton();
      emit('app:ready', { mode: 'web' });
    });
  } else {
    paintPageBackground();
    injectFloatButton();
    emit('app:ready', { mode: 'web' });
  }
})();
