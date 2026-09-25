'use strict';

/**
 * Voz de entrada: gravação pelo microfone (parec/PulseAudio) com detecção
 * simples de fala, e transcrição por um worker Python persistente
 * (faster-whisper) mantido em memória entre as chamadas.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { ROOT, AUDIO_DIR, MODELS_DIR, loadSettings, ensureDirs } = require('./config');

const VENV_PYTHON = path.join(ROOT, 'vendor', 'sttenv', 'bin', 'python');
const WORKER = path.join(__dirname, 'python', 'transcribe.py');

const SAMPLE_RATE = 16000;
const MAX_RECORD_MS = 30000;
const SILENCE_STOP_MS = 1400;
const MIN_SPEECH_MS = 300;

/* ------------------------------------------------------------------ */
/* WAV                                                                 */
/* ------------------------------------------------------------------ */

function pcmToWav(pcm, rate = SAMPLE_RATE) {
  const dataSize = pcm.length;
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
  pcm.copy(buf, 44);
  return buf;
}

function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/* ------------------------------------------------------------------ */
/* Gravador                                                            */
/* ------------------------------------------------------------------ */

let activeRecorder = null;

class Recorder {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.startedAt = 0;
    this.proc = null;
    this.done = null;
    this.noiseFloor = null;
    this.calibrating = true;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(
        'parec',
        ['--format=s16le', `--rate=${SAMPLE_RATE}`, '--channels=1', '--latency-msec=20'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      this.startedAt = Date.now();

      this.proc.on('error', (err) => reject(new Error(`parec indisponível: ${err.message}`)));
      this.proc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) console.error('[parec]', msg.slice(0, 200));
      });

      this.proc.stdout.on('data', (buf) => this.onData(buf));
      this.proc.on('exit', () => {
        if (this.done) this.done(this.finish());
      });

      // Pequeno atraso para confirmar que o parec subiu.
      setTimeout(() => {
        if (this.proc && !this.proc.killed) resolve();
        else reject(new Error('Não foi possível abrir o microfone'));
      }, 150);
    });
  }

  onData(buf) {
    this.chunks.push(buf);
    this.bytes += buf.length;
    const elapsed = Date.now() - this.startedAt;

    const level = rms(buf);
    const chunkMs = (buf.length / 2 / SAMPLE_RATE) * 1000;

    // Primeiros 400 ms: mede o ruído de fundo.
    if (this.calibrating) {
      this.noiseFloor = this.noiseFloor === null ? level : Math.max(this.noiseFloor, level);
      if (elapsed < 400) return;
      this.calibrating = false;
      this.threshold = Math.max((this.noiseFloor || 0) * 2.5, 260);
    }

    if (level > this.threshold) {
      this.voicedMs += chunkMs;
      this.silenceMs = 0;
    } else if (this.voicedMs >= MIN_SPEECH_MS) {
      this.silenceMs += chunkMs;
      if (this.silenceMs >= SILENCE_STOP_MS) this.stop();
    }

    if (elapsed >= MAX_RECORD_MS) this.stop();
  }

  finish() {
    const pcm = Buffer.concat(this.chunks);
    const durationMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
    const wav = pcmToWav(pcm);
    ensureDirs();
    const file = path.join(AUDIO_DIR, `gravacao-${Date.now()}.wav`);
    fs.writeFileSync(file, wav);
    return {
      path: file,
      durationMs: Math.round(durationMs),
      voicedMs: Math.round(this.voicedMs),
      peak: this.noiseFloor,
      tooShort: this.voicedMs < MIN_SPEECH_MS || durationMs < 250,
    };
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignora */ }
    }
    this.proc = null;
  }
}

/**
 * Começa a gravar. Resolve quando o usuário para (silêncio) ou `stop()` é chamado.
 * @returns {Promise<{path:string,durationMs:number,tooShort:boolean}>}
 */
function record() {
  if (activeRecorder) throw new Error('Já existe uma gravação em andamento');
  const rec = new Recorder();
  activeRecorder = rec;
  return new Promise((resolve, reject) => {
    rec.done = (result) => {
      activeRecorder = null;
      resolve(result);
    };
    rec.start().catch((err) => {
      activeRecorder = null;
      reject(err);
    });
  });
}

function stopRecording() {
  if (activeRecorder) activeRecorder.stop();
}

function isRecording() {
  return !!activeRecorder;
}

/* ------------------------------------------------------------------ */
/* Worker de transcrição                                               */
/* ------------------------------------------------------------------ */

class WhisperWorker {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.readyPromise = null;
    this.fatal = null;
  }

  ensure() {
    if (this.fatal) return Promise.reject(new Error(this.fatal));
    if (this.readyPromise) return this.readyPromise;
    if (!fs.existsSync(VENV_PYTHON)) {
      return Promise.reject(
        new Error(`Ambiente de transcrição ausente (${VENV_PYTHON}). Rode: scripts/setup-stt.sh`)
      );
    }

    const settings = loadSettings();
    this.readyPromise = new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        WHISPER_MODEL: settings.sttModel,
        WHISPER_LANG: settings.sttLanguage,
        WHISPER_CACHE: path.join(MODELS_DIR, 'whisper'),
      };
      fs.mkdirSync(env.WHISPER_CACHE, { recursive: true });

      this.proc = spawn(VENV_PYTHON, ['-u', WORKER], { env, stdio: ['pipe', 'pipe', 'pipe'] });

      const timer = setTimeout(() => reject(new Error('Tempo esgotado carregando o modelo de voz')), 300000);
      let settled = false;

      this.proc.stdout.on('data', (buf) => {
        this.buffer += buf.toString('utf8');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }

          if (msg.fatal) {
            this.fatal = msg.fatal;
            if (!settled) { settled = true; clearTimeout(timer); reject(new Error(msg.fatal)); }
            continue;
          }
          if (msg.ready && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
            continue;
          }
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error));
            else res(msg);
          }
        }
      });

      this.proc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg && !/^\s*$/.test(msg)) console.error('[whisper]', msg.slice(0, 300));
      });

      this.proc.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });

      this.proc.on('exit', (code) => {
        this.proc = null;
        this.readyPromise = null;
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error(`Worker de transcrição encerrou (código ${code})`));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Worker de transcrição falhou ao iniciar (código ${code})`));
        }
      });
    });

    this.readyPromise.catch(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  async transcribe(wavPath, language) {
    await this.ensure();
    const id = this.nextId += 1;
    const settings = loadSettings();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Tempo esgotado na transcrição'));
      }, 300000);
      this.pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      const payload = JSON.stringify({
        id,
        path: wavPath,
        language: language === undefined ? settings.sttLanguage : language,
      });
      try {
        this.proc.stdin.write(`${payload}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Pré-carrega o modelo sem transcrever nada. */
  async warm() {
    await this.ensure();
  }

  stop() {
    if (this.proc) {
      try { this.proc.stdin.write('{"cmd":"exit"}\n'); } catch { /* ignora */ }
      const proc = this.proc;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignora */ } }, 1500);
    }
  }
}

const worker = new WhisperWorker();

module.exports = {
  record,
  stopRecording,
  isRecording,
  transcribe: (wavPath, language) => worker.transcribe(wavPath, language),
  warmWhisper: () => worker.warm(),
  stopWhisper: () => worker.stop(),
  SAMPLE_RATE,
};
