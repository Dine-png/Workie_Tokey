// 트레이 아이콘 PNG를 잔량에 맞춰 동적으로 생성
// 16x16 픽셀아트: 몸체(테라코타/경고시 레드) + 가운데 게이지(잔량만큼 크림색 채움)
const zlib = require('zlib');

const W = 16, H = 16;

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

function makeTrayPng(remaining, warn) {
  const BODY = warn ? [226, 75, 74, 255] : [217, 119, 87, 255];
  const TRACK = warn ? [150, 45, 45, 255] : [168, 90, 64, 255];
  const CREAM = [250, 249, 245, 255];
  const CLEAR = [0, 0, 0, 0];
  const filled = Math.round(Math.max(0, Math.min(100, remaining)) / 100 * 10); // 게이지 0~10칸

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      let px;
      const inBody = x >= 1 && x <= 14 && y >= 1 && y <= 14;
      const corner =
        (x === 1 && y === 1) || (x === 14 && y === 1) ||
        (x === 1 && y === 14) || (x === 14 && y === 14);
      if (!inBody || corner) px = CLEAR;
      else if (y >= 7 && y <= 9 && x >= 3 && x <= 12) px = (x - 3 < filled) ? CREAM : TRACK;
      else px = BODY;
      const o = row + 1 + x * 4;
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2]; raw[o + 3] = px[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { makeTrayPng };
