import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { nextNumber, formatNumber, validateFormat, peekSequence, NumberingError } from '../src/numbering.mjs';

test('payment and petty cash series are sequential and completely independent', () => {
  const store = new Store();
  const pr = () => nextNumber(store, 'PR-{YYYY}-{SEQ:6}', '2026-09-21').number;
  const pcr = () => nextNumber(store, 'PCR-{YYYY}-{SEQ:6}', '2026-09-21').number;
  assert.equal(pr(), 'PR-2026-000001');
  assert.equal(pcr(), 'PCR-2026-000001');
  assert.equal(pr(), 'PR-2026-000002');
  assert.equal(pr(), 'PR-2026-000003');
  assert.equal(pcr(), 'PCR-2026-000002');
  store.close();
});

test('a new year restarts the series without disturbing the old one', () => {
  const store = new Store();
  assert.equal(nextNumber(store, 'PR-{YYYY}-{SEQ:6}', '2026-12-31').number, 'PR-2026-000001');
  assert.equal(nextNumber(store, 'PR-{YYYY}-{SEQ:6}', '2027-01-01').number, 'PR-2027-000001');
  assert.equal(nextNumber(store, 'PR-{YYYY}-{SEQ:6}', '2026-12-31').number, 'PR-2026-000002');
  store.close();
});

test('the format is configurable, including width, month and two-digit year', () => {
  const store = new Store();
  assert.equal(nextNumber(store, 'PV/{YY}{MM}/{SEQ:4}', '2026-03-05').number, 'PV/2603/0001');
  assert.equal(nextNumber(store, 'PV/{YY}{MM}/{SEQ:4}', '2026-03-28').number, 'PV/2603/0002');
  assert.equal(nextNumber(store, 'PV/{YY}{MM}/{SEQ:4}', '2026-04-01').number, 'PV/2604/0001', 'a monthly prefix starts its own series');
  assert.equal(formatNumber('PR-{YYYY}-{SEQ:6}', '2026-09-21', 42), 'PR-2026-000042');
  store.close();
});

test('a rolled-back request never burns a reference number', () => {
  const store = new Store();
  assert.equal(nextNumber(store, 'PR-{YYYY}-{SEQ:6}', '2026-09-21').number, 'PR-2026-000001');
  assert.throws(() => store.transaction(() => {
    nextNumber(store, 'PR-{YYYY}-{SEQ:6}', '2026-09-21');
    throw new Error('validation failed');
  }), /validation failed/);
  assert.equal(nextNumber(store, 'PR-{YYYY}-{SEQ:6}', '2026-09-21').number, 'PR-2026-000002', 'no gap is left behind');
  assert.equal(peekSequence(store, 'PR-{YYYY}-{SEQ:6}', '2026-09-21'), 3);
  store.close();
});

test('invalid formats and dates are rejected before any number is issued', () => {
  const store = new Store();
  assert.throws(() => validateFormat('PR-2026-1'), NumberingError);
  assert.throws(() => validateFormat('PR-{SEQ:6}-{SEQ:6}'), /exactly one/);
  assert.throws(() => validateFormat('PR-{NOPE}-{SEQ:6}'), /Unknown placeholder/);
  assert.throws(() => validateFormat(''), /required/);
  assert.throws(() => nextNumber(store, 'PR-{YYYY}-{SEQ:6}', 'not-a-date'), /valid request date/);
  assert.equal(peekSequence(store, 'PR-{YYYY}-{SEQ:6}', '2026-09-21'), 1, 'nothing was allocated');
  store.close();
});

test('a series that outgrows its width fails loudly instead of issuing a duplicate-looking number', () => {
  const store = new Store();
  store.run("INSERT INTO sequences(prefix, year, next) VALUES('PR-2026-{SEQ}', 2026, 9)");
  assert.equal(nextNumber(store, 'PR-{YYYY}-{SEQ:1}', '2026-09-21').number, 'PR-2026-9');
  assert.throws(() => nextNumber(store, 'PR-{YYYY}-{SEQ:1}', '2026-09-21'), /series is full/);
  store.close();
});
