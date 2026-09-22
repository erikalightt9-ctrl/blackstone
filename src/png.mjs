import { inflateSync } from 'node:zlib';

// Just enough PNG to put a company logo on a PDF: 8-bit, non-interlaced, RGB or RGBA.
// Anything else is rejected rather than rendered wrongly. The decoded pixels are downsampled
// before they reach the PDF, so a large source logo does not bloat every generated document.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {}

function chunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new PngError('That file is not a PNG image.');
  const found = { idat: [] };
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8, end = start + length;
    if (end > buffer.length) throw new PngError('The PNG image is truncated.');
    if (type === 'IHDR') found.ihdr = buffer.subarray(start, end);
    else if (type === 'IDAT') found.idat.push(buffer.subarray(start, end));
    else if (type === 'IEND') break;
    offset = end + 4;
  }
  if (!found.ihdr || !found.idat.length) throw new PngError('The PNG image has no header or no image data.');
  return found;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Reverses the five PNG scanline filters in place, returning raw pixel rows.
function unfilter(data, width, height, channels) {
  const stride = width * channels, out = Buffer.alloc(stride * height);
  let position = 0;
  for (let row = 0; row < height; row++) {
    const filter = data[position++];
    const line = data.subarray(position, position + stride);
    position += stride;
    const target = row * stride, previous = target - stride;
    for (let index = 0; index < stride; index++) {
      const raw = line[index];
      const left = index >= channels ? out[target + index - channels] : 0;
      const up = row ? out[previous + index] : 0;
      const upLeft = row && index >= channels ? out[previous + index - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else throw new PngError(`Unsupported PNG scanline filter ${filter}.`);
      out[target + index] = value & 0xff;
    }
  }
  return out;
}

// Box-average downsampling to at most maxWidth. Averaging rather than dropping pixels keeps
// fine detail, such as a logo's lettering, readable at print size.
function downsample(pixels, width, height, channels, maxWidth) {
  if (width <= maxWidth) return { pixels, width, height };
  const factor = Math.ceil(width / maxWidth);
  const outWidth = Math.ceil(width / factor), outHeight = Math.ceil(height / factor);
  const out = Buffer.alloc(outWidth * outHeight * channels);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      for (let channel = 0; channel < channels; channel++) {
        let total = 0, count = 0;
        for (let dy = 0; dy < factor; dy++) {
          const sourceY = y * factor + dy;
          if (sourceY >= height) break;
          for (let dx = 0; dx < factor; dx++) {
            const sourceX = x * factor + dx;
            if (sourceX >= width) break;
            total += pixels[(sourceY * width + sourceX) * channels + channel];
            count++;
          }
        }
        out[(y * outWidth + x) * channels + channel] = Math.round(total / count);
      }
    }
  }
  return { pixels: out, width: outWidth, height: outHeight };
}

export function decodePng(buffer, { maxWidth = 900 } = {}) {
  const { ihdr, idat } = chunks(buffer);
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const [bitDepth, colorType, , , interlace] = [ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]];
  if (bitDepth !== 8) throw new PngError(`Only 8-bit PNG images are supported (this one is ${bitDepth}-bit).`);
  if (interlace !== 0) throw new PngError('Interlaced PNG images are not supported. Save the logo without interlacing.');
  if (colorType !== 2 && colorType !== 6) throw new PngError('Save the logo as an RGB or RGBA PNG (not greyscale or palette based).');
  if (!width || !height || width > 20000 || height > 20000) throw new PngError('The PNG image has an unusable size.');

  const channels = colorType === 6 ? 4 : 3;
  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  const scaled = downsample(raw, width, height, channels, maxWidth);

  if (channels === 3) return { width: scaled.width, height: scaled.height, rgb: scaled.pixels, alpha: null };
  const count = scaled.width * scaled.height;
  const rgb = Buffer.alloc(count * 3), alpha = Buffer.alloc(count);
  for (let index = 0; index < count; index++) {
    rgb[index * 3] = scaled.pixels[index * 4];
    rgb[index * 3 + 1] = scaled.pixels[index * 4 + 1];
    rgb[index * 3 + 2] = scaled.pixels[index * 4 + 2];
    alpha[index] = scaled.pixels[index * 4 + 3];
  }
  return { width: scaled.width, height: scaled.height, rgb, alpha: alpha.includes(255) && alpha.every(value => value === 255) ? null : alpha };
}
