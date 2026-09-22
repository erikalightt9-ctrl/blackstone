import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

// The company logo, prepared once at startup into the exact streams a PDF needs.
// It is optional: without it the documents fall back to the company name as a wordmark.
export const LOGO_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/brand/logo.png');

export function prepareLogo(buffer) {
  const image = decodePng(buffer, { maxWidth: 560 });
  return {
    width: image.width,
    height: image.height,
    rgbStream: deflateSync(image.rgb, { level: 9 }),
    alphaStream: image.alpha ? deflateSync(image.alpha, { level: 9 }) : null,
  };
}

export async function loadLogo(file = LOGO_FILE) {
  let buffer;
  try {
    buffer = await readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not read the logo at ${file}: ${error.message}`);
    else console.log(`No logo found at ${file}. Documents will print the company name instead.`);
    return null;
  }
  try {
    return prepareLogo(buffer);
  } catch (error) {
    console.warn(`The logo at ${file} could not be used: ${error.message}`);
    return null;
  }
}
