import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, categoryId, draftPayment } from './helpers.mjs';
import { submitRequest, decideRequest, cancelRequest, getRequest } from '../src/requests.mjs';
import { releasePayment } from '../src/payments.mjs';
import { requestPdf, wrap } from '../src/pdf.mjs';

const read = buffer => buffer.toString('latin1');

test('a standard copy is a valid PDF that hides the accounting classifications', () => {
  const store = newStore();
  const request = draftPayment(store);
  const pdf = requestPdf(request, store.config());
  const text = read(pdf);
  assert.ok(pdf.subarray(0, 8).toString().startsWith('%PDF-1.4'));
  assert.ok(text.endsWith('%%EOF'));
  assert.match(text, /BLACK STONE MINERAL RESOURCES INC/);
  assert.match(text, /PR-2026-000001/);
  assert.match(text, /Payment Request/);
  assert.match(text, /Office Supplies/);
  assert.match(text, /PHP 850\.00/);
  assert.match(text, /VICENTE CHENG/, 'the selected approver is printed in the authorization block');
  assert.doesNotMatch(text, /Freight & Delivery/, 'no accounting category appears on the standard copy');
  assert.doesNotMatch(text, /ACCOUNTING \/ INTERNAL COPY/);
  store.close();
});

test('the accounting copy shows every classification and is marked internal', () => {
  const store = newStore();
  const request = draftPayment(store);
  const text = read(requestPdf(request, store.config(), { accounting: true }));
  assert.match(text, /Freight & Delivery/, 'the category is printed on the accounting copy');
  assert.match(text, /ACCOUNTING CATEGORY/);
  assert.match(text, /ACCOUNTING \/ INTERNAL COPY/);
  assert.match(text, /Internal use only/);
  store.close();
});

test('the selected final approver, not the default, is the one printed', () => {
  const store = newStore();
  const request = draftPayment(store, { finalApprover: 'Demry Cheng' });
  const text = read(requestPdf(request, store.config()));
  assert.match(text, /DEMRY CHENG/);
  assert.doesNotMatch(text, /VICENTE/);
  store.close();
});

test('a released request prints the check details and the releaser, never the system approver', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  decideRequest(store, actors.approver, request.id, 'approve', {});
  const withPayment = releasePayment(store, actors.releaser, request.id, {
    method: 'Check', bank: 'BDO Unibank', checkNumber: '0012345', checkDate: '2026-09-22', amount: 850,
    payee: 'Metro Office Depot', datePrepared: '2026-09-22', dateReleased: '2026-09-23', receivedBy: 'Metro courier', remarks: '',
  });
  const text = read(requestPdf(withPayment, store.config()));
  assert.match(text, /PAYMENT \/ CHECK DETAILS/);
  assert.match(text, /0012345/);
  assert.match(text, /BDO Unibank/);
  assert.match(text, /AUTHORIZATION/);
  assert.match(text, /\(DINA RELEASER\) Tj/, 'the person who released it signs the Released By line');
  assert.match(text, /\(Released By\) Tj/);
  assert.doesNotMatch(text, /Carla Approver/i, 'the system approver is never printed on the form');
  store.close();
});

test('a cancelled request is stamped CANCELLED with its reason', () => {
  const store = newStore();
  const request = draftPayment(store);
  cancelRequest(store, actors.approver, request.id, { reason: 'Duplicate of PR-2026-000004' });
  const text = read(requestPdf(getRequest(store, actors.approver, request.id), store.config()));
  assert.match(text, /CANCELLED - Duplicate of PR-2026-000004/);
  store.close();
});

test('a long request paginates and every page is numbered', () => {
  const store = newStore();
  const category = categoryId(store, 'OFFICE-SUPPLIES');
  const lines = Array.from({ length: 60 }, (_, i) => ({ particulars: `Line item ${i + 1} with a deliberately long description to force wrapping across the column`, quantity: 2, unitAmount: 125.5, categoryId: category }));
  const request = draftPayment(store, { lines });
  const text = read(requestPdf(request, store.config(), { accounting: true }));
  const pages = text.match(/\/Type \/Page[^s]/g) || [];
  assert.ok(pages.length >= 3, `expected several pages, got ${pages.length}`);
  assert.match(text, new RegExp(`Page 1 of ${pages.length}`));
  assert.match(text, new RegExp(`Page ${pages.length} of ${pages.length}`));
  const streams = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => m[1]);
  const withRows = streams.filter(body => body.includes('Line item'));
  assert.ok(withRows.length >= 3, 'the expense lines really do span several pages');
  for (const body of withRows) assert.match(body, /PARTICULARS/, 'every page carrying expense lines repeats the table heading');
  assert.match(text, /PHP 15,060\.00/, '60 x 2 x 125.50');
  store.close();
});

test('unsupported characters and unbalanced parentheses cannot corrupt the stream', () => {
  const store = newStore();
  const request = draftPayment(store, { purpose: 'Café supplies (urgent — ₱1,000) \\ 100% 中文', payee: 'José (Pepe' });
  const pdf = requestPdf(request, store.config());
  const text = read(pdf);
  assert.ok(text.endsWith('%%EOF'));
  assert.doesNotMatch(text, /中/);
  const streams = text.match(/stream\n([\s\S]*?)\nendstream/g) || [];
  for (const stream of streams) {
    const body = stream.slice(7, -10);
    let depth = 0, escaped = false;
    for (const char of body) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '(') depth++;
      if (char === ')') depth--;
      assert.ok(depth >= 0, 'a stray closing parenthesis would break the PDF');
    }
    assert.equal(depth, 0, 'every text string is balanced');
  }
  store.close();
});

test('declared stream lengths match the bytes actually written', () => {
  const store = newStore();
  const text = read(requestPdf(draftPayment(store), store.config()));
  for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
    assert.equal(Buffer.byteLength(match[2]), Number(match[1]));
  }
  store.close();
});

test('wrapping breaks long words and never loops forever', () => {
  assert.deepEqual(wrap('short', 9, 200), ['short']);
  const broken = wrap('x'.repeat(200), 9, 60);
  assert.ok(broken.length > 1);
  assert.ok(broken.every(line => line.length > 0));
  assert.deepEqual(wrap('', 9, 100), ['']);
});
