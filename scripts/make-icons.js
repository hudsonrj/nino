'use strict';

/**
 * Gerador de ícones (PNG puro, sem dependências nativas).
 * Desenha a carinha do mascote e grava assets/icon.png e assets/tray.png.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------------------------------------------------------- */
/* Codificador PNG                                                   */
/* ---------------------------------------------------------------- */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- */
/* Desenho                                                           */
/* ---------------------------------------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function blend(px, i, r, g, b, a) {
  const inv = 1 - a;
  px[i] = Math.round(r * a + px[i] * inv);
  px[i + 1] = Math.round(g * a + px[i + 1] * inv);
  px[i + 2] = Math.round(b * a + px[i + 2] * inv);
  px[i + 3] = Math.round((a + (px[i + 3] / 255) * inv) * 255);
}

/** Cobertura suave de um círculo para antialias. */
function circleAlpha(x, y, cx, cy, r) {
  const d = Math.hypot(x - cx, y - cy);
  return clamp01(r - d + 0.5);
}

function drawMascot(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const S = size;
  const cx = S / 2;
  const cy = S * 0.52;
  const bodyR = S * 0.40;

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const i = (y * S + x) * 4;
      const fx = x + 0.5;
      const fy = y + 0.5;

      // Corpo (gradiente vertical de verde-água a azul).
      const a = circleAlpha(fx, fy, cx, cy, bodyR);
      if (a > 0) {
        const t = clamp01((fy - (cy - bodyR)) / (bodyR * 2));
        const r = Math.round(64 + 30 * (1 - t));
        const g = Math.round(196 + 40 * t);
        const b = Math.round(210 + 40 * t);
        blend(px, i, r, g, b, a);
      }

      // Brilho superior.
      const aGloss = circleAlpha(fx, fy, cx - bodyR * 0.32, cy - bodyR * 0.42, bodyR * 0.30);
      if (aGloss > 0) blend(px, i, 255, 255, 255, aGloss * 0.35);

      // Olhos.
      const eyeDx = bodyR * 0.36;
      const eyeR = bodyR * 0.17;
      for (const sx of [-1, 1]) {
        const aEye = circleAlpha(fx, fy, cx + sx * eyeDx, cy - bodyR * 0.10, eyeR);
        if (aEye > 0) blend(px, i, 24, 34, 48, aEye);
      }

      // Reflexo dos olhos.
      for (const sx of [-1, 1]) {
        const aDot = circleAlpha(fx, fy, cx + sx * eyeDx + eyeR * 0.34, cy - bodyR * 0.18, eyeR * 0.36);
        if (aDot > 0) blend(px, i, 255, 255, 255, aDot * 0.95);
      }

      // Bochechas.
      for (const sx of [-1, 1]) {
        const aCh = circleAlpha(fx, fy, cx + sx * bodyR * 0.62, cy + bodyR * 0.24, bodyR * 0.15);
        if (aCh > 0) blend(px, i, 255, 138, 158, aCh * 0.5);
      }

      // Sorriso: arco fino.
      const mx = fx - cx;
      const my = fy - (cy + bodyR * 0.16);
      const distArc = Math.abs(Math.hypot(mx, my) - bodyR * 0.42);
      if (my > 0 && distArc < S * 0.022 && Math.abs(mx) < bodyR * 0.44) {
        const edge = clamp01((S * 0.022 - distArc) / 1.2);
        blend(px, i, 24, 34, 48, edge);
      }
    }
  }
  return px;
}

/* ---------------------------------------------------------------- */

function main() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const targets = [
    ['icon.png', 256],
    ['tray.png', 32],
    ['tray@2x.png', 64],
  ];
  for (const [name, size] of targets) {
    const png = encodePNG(size, size, drawMascot(size));
    fs.writeFileSync(path.join(assetsDir, name), png);
    console.log(`${name}: ${size}x${size}, ${png.length} bytes`);
  }
}

if (require.main === module) main();
module.exports = { encodePNG, drawMascot };
