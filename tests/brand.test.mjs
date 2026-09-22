import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { decodePng, PngError } from '../src/png.mjs';
import { prepareLogo, loadLogo, LOGO_FILE } from '../src/brand.mjs';
import { requestPdf } from '../src/pdf.mjs';
import { newStore, draftPayment } from './helpers.mjs';

// A minimal valid PNG built by hand, so the decoder is tested without depending on a file.
function makePng(width, height, channels, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buffer => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) raw[y * (stride + 1) + 1 + x * channels + c] = pixel(x, y, c);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('an RGB PNG decodes to the pixels it was built from', () => {
  const png = makePng(4, 3, 3, (x, y, c) => (c === 0 ? x * 10 : c === 1 ? y * 20 : 7));
  const image = decodePng(png);
  assert.equal(image.width, 4);
  assert.equal(image.height, 3);
  assert.equal(image.alpha, null);
  assert.equal(image.rgb.length, 4 * 3 * 3);
  assert.deepEqual([...image.rgb.subarray(0, 6)], [0, 0, 7, 10, 0, 7]);
});

test('an RGBA PNG splits into colour and a soft mask, and a fully opaque one drops the mask', () => {
  const translucent = decodePng(makePng(2, 2, 4, (x, y, c) => (c === 3 ? 128 : 200)));
  assert.equal(translucent.rgb.length, 12);
  assert.deepEqual([...translucent.alpha], [128, 128, 128, 128]);
  const opaque = decodePng(makePng(2, 2, 4, (x, y, c) => (c === 3 ? 255 : 10)));
  assert.equal(opaque.alpha, null, 'a fully opaque image needs no soft mask');
});

test('a wide image is averaged down instead of being embedded at full size', () => {
  const image = decodePng(makePng(40, 20, 3, () => 100), { maxWidth: 10 });
  assert.equal(image.width, 10);
  assert.equal(image.height, 5);
  assert.ok(image.rgb.every(value => value === 100), 'a flat image stays flat after averaging');
});

test('unsupported and corrupt images are refused with a clear reason', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), PngError);
  assert.throws(() => decodePng(Buffer.alloc(0)), /not a PNG/);
  const interlaced = makePng(2, 2, 3, () => 1);
  interlaced[28] = 1; // the interlace byte inside IHDR
  assert.throws(() => decodePng(interlaced), /Interlaced/);
  const sixteenBit = makePng(2, 2, 3, () => 1);
  sixteenBit[24] = 16; // the bit-depth byte inside IHDR
  assert.throws(() => decodePng(sixteenBit), /8-bit/);
  assert.throws(() => decodePng(makePng(2, 2, 3, () => 1).subarray(0, 30)), /truncated|no header/);
});

test('a missing logo file leaves the documents working, with the company name instead', async () => {
  assert.equal(await loadLogo('does-not-exist.png'), null);
  const store = newStore();
  const request = draftPayment(store);
  const text = requestPdf(request, store.config(), { logo: null }).toString('latin1');
  assert.match(text, /BLACK STONE MINERAL RESOURCES INC/);
  assert.doesNotMatch(text, /\/XObject/);
  store.close();
});

test('the logo is embedded in both PDF copies as a valid image object', { skip: !existsSync(LOGO_FILE) && 'no logo installed' }, async () => {
  const logo = prepareLogo(readFileSync(LOGO_FILE));
  assert.ok(logo.width > 0 && logo.height > 0);
  assert.ok(logo.rgbStream.length > 0);
  const store = newStore();
  const request = draftPayment(store);
  for (const accounting of [false, true]) {
    const pdf = requestPdf(request, store.config(), { accounting, logo });
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'), 'still a PDF');
    assert.ok(text.endsWith('%%EOF'));
    assert.match(text, /\/Subtype \/Image/);
    assert.match(text, /\/XObject << \/Logo \d+ 0 R >>/);
    assert.match(text, /\/Logo Do/);
    // Every cross-reference offset must point at the object it claims, or readers reject the file.
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
    assert.ok(offsets.length > 4);
    offsets.forEach((offset, index) => {
      assert.equal(pdf.subarray(offset, offset + 12).toString('latin1').split(' ')[0], String(index + 1), `object ${index + 1} is where the xref says`);
    });
  }
  store.close();
});
