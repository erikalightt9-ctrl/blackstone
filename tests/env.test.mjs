import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvFile } from '../src/env.mjs';

const workspace = () => mkdtempSync(path.join(tmpdir(), 'fr-env-'));
const write = (dir, text) => { const file = path.join(dir, '.env'); writeFileSync(file, text); return file; };

test('a .env file supplies settings, and reports only the names it set', () => {
  const dir = workspace();
  try {
    const file = write(dir, '# outgoing mail\nFR_MAIL_FROM=finance@example.com\nFR_SMTP_PASS="a quoted secret"\n\nFR_SMTP_PORT=587\n');
    const loaded = loadEnvFile(file);
    assert.deepEqual(loaded, ['FR_MAIL_FROM', 'FR_SMTP_PASS', 'FR_SMTP_PORT']);
    assert.equal(process.env.FR_MAIL_FROM, 'finance@example.com');
    assert.equal(process.env.FR_SMTP_PASS, 'a quoted secret', 'quotes are stripped, spaces inside are kept');
    // The names are returned so a log can say what was configured; the values are not.
    assert.equal(loaded.join(' ').includes('a quoted secret'), false);
  } finally {
    for (const key of ['FR_MAIL_FROM', 'FR_SMTP_PASS', 'FR_SMTP_PORT']) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real environment variable is never overridden by the file', () => {
  const dir = workspace();
  try {
    process.env.FR_ORIGIN = 'https://set-by-the-service';
    const loaded = loadEnvFile(write(dir, 'FR_ORIGIN=http://left-in-a-file\n'));
    assert.deepEqual(loaded, [], 'nothing was taken from the file');
    assert.equal(process.env.FR_ORIGIN, 'https://set-by-the-service');
  } finally {
    delete process.env.FR_ORIGIN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no file, blank lines and nonsense are all survivable', () => {
  const dir = workspace();
  try {
    assert.deepEqual(loadEnvFile(path.join(dir, 'absent')), [], 'a missing file is the normal case, not an error');
    const loaded = loadEnvFile(write(dir, '\n\n# only a comment\n=novalue\nnot a pair\n9INVALID=x\nFR_TEST_OK=yes\n'));
    assert.deepEqual(loaded, ['FR_TEST_OK'], 'malformed lines are skipped rather than throwing');
  } finally {
    delete process.env.FR_TEST_OK;
    rmSync(dir, { recursive: true, force: true });
  }
});
