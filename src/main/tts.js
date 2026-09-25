'use strict';

/**
 * Fala: Piper (neural, PT-BR) com streaming direto para o PulseAudio.
 * Se o Piper falhar, cai para o spd-say (speech-dispatcher).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { PIPER_BIN, PIPER_LIB, VOICES_DIR, AUDIO_DIR, loadSettings, ensureDirs } = require('./config');

const MAX_SPEECH_CHARS = 1500;

let queue = [];
let busy = false;
let current = null;
let stateListener = () => {};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function listVoices() {
  try {
    return fs
      .readdirSync(VOICES_DIR)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.replace(/\.onnx$/, ''));
  } catch {
    return [];
  }
}

function voicePaths(name) {
  const onnx = path.join(VOICES_DIR, `${name}.onnx`);
  if (!fs.existsSync(onnx)) {
    const available = listVoices();
    throw new Error(
      `Voz "${name}" não encontrada em vendor/voices. Disponíveis: ${available.join(', ') || 'nenhuma'}`
    );
  }
  return { onnx, cfg: `${onnx}.json` };
}

function sampleRateOf(name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(VOICES_DIR, `${name}.onnx.json`), 'utf8'));
    return (cfg.audio && cfg.audio.sample_rate) || 22050;
  } catch {
    return 22050;
  }
}

function piperEnv() {
  return {
    ...process.env,
    LD_LIBRARY_PATH: [PIPER_LIB, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  };
}

/**
 * Limpa markdown e ruído para uma fala natural.
 */
function prepareForSpeech(raw) {
  let text = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' … bloco de código omitido … ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s*[-*+•]\s+/gm, ' ')
    .replace(/^\s*\d+[.)]\s+/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/[|<>#~^*_]/g, ' ')
    .replace(/\.{3,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > MAX_SPEECH_CHARS) {
    const cut = text.slice(0, MAX_SPEECH_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = lastStop > 200 ? cut.slice(0, lastStop + 1) : cut;
    text += ' … o resto está escrito na tela.';
  }
  return text;
}

function emitState(state) {
  try {
    stateListener(state);
  } catch {
    /* ignora */
  }
}

/* ------------------------------------------------------------------ */
/* Reprodução                                                          */
/* ------------------------------------------------------------------ */

/** Piper: sintetiza em streaming e reproduz. */
function speakWithPiper(text, { voice, lengthScale }) {
  return new Promise((resolve) => {
    let onnx;
    let cfg;
    try {
      ({ onnx, cfg } = voicePaths(voice));
    } catch (err) {
      console.error('[tts]', err.message);
      resolve(false);
      return;
    }

    const rate = sampleRateOf(voice);
    const args = [
      '--model', onnx,
      '--config', cfg,
      '--output_raw',
      '--length_scale', String(lengthScale),
      '--sentence_silence', '0.15',
      '-q',
    ];

    let piper;
    try {
      piper = spawn(PIPER_BIN, args, { env: piperEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      console.error('[tts] falha ao iniciar piper:', err.message);
      resolve(false);
      return;
    }

    let player;
    try {
      player = spawn('paplay', ['--raw', '--format=s16le', `--rate=${rate}`, '--channels=1'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      try { piper.kill('SIGKILL'); } catch { /* ignora */ }
      resolve(false);
      return;
    }

    current = {
      kill: () => {
        try { piper.kill('SIGKILL'); } catch { /* ignora */ }
        try { player.kill('SIGKILL'); } catch { /* ignora */ }
      },
    };

    let piperError = null;
    piper.on('error', (err) => { piperError = err; });
    piper.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[piper]', msg.slice(0, 200));
    });
    player.on('error', () => { piperError = piperError || new Error('paplay indisponível'); });

    piper.stdout.pipe(player.stdin);
    piper.stdout.on('error', () => { /* ignora EPIPE */ });
    player.stdin.on('error', () => { /* ignora EPIPE */ });

    let playerExit = null;
    player.on('exit', (code) => { playerExit = code; });

    piper.on('exit', (code) => {
      if (piperError || (code !== 0 && code !== null)) {
        console.error(`[tts] piper saiu com código ${code}`);
      }
    });

    // Espera o player terminar (ou erro).
    const finish = () => {
      current = null;
      if (piperError) {
        resolve(false);
        return;
      }
      resolve(playerExit === 0 || playerExit === null);
    };
    player.on('exit', finish);
    player.on('error', () => setTimeout(finish, 50));

    // Alimenta o texto e fecha o stdin do Piper.
    try {
      piper.stdin.end(`${text}\n`, 'utf8');
    } catch {
      /* ignora */
    }
  });
}

/** Fallback: speech-dispatcher. */
function speakWithSpdSay(text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('spd-say', ['-w', '-l', 'pt', '-r', '-10', text.slice(0, 800)], {
        stdio: 'ignore',
      });
    } catch {
      resolve(false);
      return;
    }
    current = { kill: () => { try { child.kill('SIGKILL'); } catch { /* ignora */ } } };
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      current = null;
      resolve(code === 0);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Fila                                                                */
/* ------------------------------------------------------------------ */

async function runItem(item) {
  const settings = loadSettings();
  const voice = item.opts.voice || settings.voice;
  const lengthScale = item.opts.lengthScale != null ? item.opts.lengthScale : settings.lengthScale;

  emitState({ speaking: true });
  let ok = false;
  try {
    ok = await speakWithPiper(item.text, { voice, lengthScale });
    if (!ok) {
      console.error('[tts] piper falhou; usando spd-say');
      ok = await speakWithSpdSay(item.text);
    }
  } catch (err) {
    console.error('[tts] erro:', err.message);
    ok = await speakWithSpdSay(item.text);
  } finally {
    current = null;
    emitState({ speaking: false, lastOk: ok });
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      try {
        await runItem(item);
      } finally {
        item.resolve();
      }
    }
  } finally {
    busy = false;
    emitState({ speaking: false, idle: true });
  }
}

/**
 * Enfileira uma fala.
 * @param {string} text
 * @param {{voice?:string, lengthScale?:number}} [opts]
 */
function speak(text, opts = {}) {
  const clean = prepareForSpeech(text);
  if (!clean) return Promise.resolve();
  return new Promise((resolve) => {
    queue.push({ text: clean, opts, resolve });
    pump();
  });
}

function stop() {
  queue.forEach((item) => item.resolve());
  queue = [];
  if (current) {
    try { current.kill(); } catch { /* ignora */ }
    current = null;
  }
  emitState({ speaking: false, stopped: true });
}

function isSpeaking() {
  return busy;
}

function onState(fn) {
  stateListener = fn;
}

/**
 * Aquece o sink do PulseAudio (no WSLg o primeiro play pode levar ~20 s).
 * Toca 300 ms de silêncio em volume baixo.
 */
function warmup() {
  return new Promise((resolve) => {
    ensureDirs();
    const rate = 22050;
    const frames = Math.floor(rate * 0.3);
    const dataSize = frames * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    const file = path.join(AUDIO_DIR, 'warmup.wav');
    try {
      fs.writeFileSync(file, buf);
    } catch {
      resolve(false);
      return;
    }
    const child = spawn('paplay', ['--volume=2000', file], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', () => resolve(true));
  });
}

/* ------------------------------------------------------------------ */
/* Síntese para o navegador                                            */
/* ------------------------------------------------------------------ */

/**
 * Sintetiza e devolve um WAV completo (usado pelo modo web, onde quem toca
 * o áudio é o navegador).
 * @param {string} text
 * @param {{voice?:string, lengthScale?:number}} [opts]
 * @returns {Promise<Buffer|null>}
 */
function synthesize(text, opts = {}) {
  const settings = loadSettings();
  const voice = opts.voice || settings.voice;
  const lengthScale = opts.lengthScale != null ? opts.lengthScale : settings.lengthScale;
  const clean = prepareForSpeech(text);
  if (!clean) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    let onnx;
    let cfg;
    try {
      ({ onnx, cfg } = voicePaths(voice));
    } catch (err) {
      reject(err);
      return;
    }

    const args = [
      '--model', onnx,
      '--config', cfg,
      '--output_file', '-',
      '--length_scale', String(lengthScale),
      '--sentence_silence', '0.1',
      '-q',
    ];

    let piper;
    try {
      piper = spawn(PIPER_BIN, args, { env: piperEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = [];
    let errText = '';
    piper.stdout.on('data', (c) => chunks.push(c));
    piper.stderr.on('data', (d) => {
      errText += d.toString();
    });
    piper.on('error', reject);
    piper.on('exit', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`piper saiu com código ${code}: ${errText.slice(0, 200)}`));
    });
    piper.stdin.end(`${clean}\n`, 'utf8');
  });
}

module.exports = {
  speak,
  stop,
  isSpeaking,
  warmup,
  onState,
  listVoices,
  prepareForSpeech,
  synthesize,
};
