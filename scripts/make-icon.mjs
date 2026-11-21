// Generates src-tauri/icons/source.png — a 1024px navy tile with an amber
// "roof" band, so the bundler has a real icon without binary assets in git.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const S = 1024;
const px = Buffer.alloc(S * S * 4);

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const inset = x > S * 0.1 && x < S * 0.9 && y > S * 0.1 && y < S * 0.9;
    const roof = inset && y > S * 0.34 && y < S * 0.46 && Math.abs(x - S / 2) < S * 0.34;
    const body = inset && y >= S * 0.46 && y < S * 0.74 && Math.abs(x - S / 2) < S * 0.26;
    if (roof) {
      px[i] = 245; px[i + 1] = 158; px[i + 2] = 11;
    } else if (body) {
      px[i] = 226; px[i + 1] = 232; px[i + 2] = 240;
    } else {
      px[i] = 15; px[i + 1] = 23; px[i + 2] = 42;
    }
    px[i + 3] = 255;
  }
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('src-tauri/icons', { recursive: true });
writeFileSync('src-tauri/icons/source.png', png);
console.log(`icon written: ${png.length} bytes`);
