// 16x16 트레이 아이콘 PNG 생성기 — 테라코타 사각형 + 크림 게이지 바
// 사용: node scripts/gen-tray-icon.js  →  assets/tray.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 16, H = 16;
const TERRACOTTA = [217, 119, 87, 255];
const TRACK = [168, 90, 64, 255];
const CREAM = [250, 249, 245, 255];
const CLEAR = [0, 0, 0, 0];

function pixel(x, y) {
  const inBody = x >= 1 && x <= 14 && y >= 1 && y <= 14;
  if (!inBody) return CLEAR;
  const corner =
    (x === 1 && y === 1) || (x === 14 && y === 1) ||
    (x === 1 && y === 14) || (x === 14 && y === 14);
  if (corner) return CLEAR;
  if (y >= 7 && y <= 9 && x >= 3 && x <= 12) {
    return x <= 9 ? CREAM : TRACK; // 약 68% 채워진 게이지
  }
  return TERRACOTTA;
}

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4);
  raw[row] = 0;
  for (let x = 0; x < W; x++) {
    const [r, g, b, a] = pixel(x, y);
    const o = row + 1 + x * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
}

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'assets', 'tray.png');
fs.writeFileSync(out, png);
console.log(`written: ${out} (${png.length} bytes)`);

// 256x256 앱 아이콘 (16x16 픽셀아트를 16배 니어리스트 확대)
const SCALE = 16;
const BIG = W * SCALE;
const bigRaw = Buffer.alloc(BIG * (1 + BIG * 4));
for (let y = 0; y < BIG; y++) {
  const row = y * (1 + BIG * 4);
  bigRaw[row] = 0;
  for (let x = 0; x < BIG; x++) {
    const [r, g, b, a] = pixel(Math.floor(x / SCALE), Math.floor(y / SCALE));
    const o = row + 1 + x * 4;
    bigRaw[o] = r; bigRaw[o + 1] = g; bigRaw[o + 2] = b; bigRaw[o + 3] = a;
  }
}
const bigIhdr = Buffer.alloc(13);
bigIhdr.writeUInt32BE(BIG, 0);
bigIhdr.writeUInt32BE(BIG, 4);
bigIhdr[8] = 8;
bigIhdr[9] = 6;
const bigPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', bigIhdr),
  chunk('IDAT', zlib.deflateSync(bigRaw)),
  chunk('IEND', Buffer.alloc(0))
]);
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const bigOut = path.join(buildDir, 'icon.png');
fs.writeFileSync(bigOut, bigPng);
console.log(`written: ${bigOut} (${bigPng.length} bytes)`);
