import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, draftPayment } from './helpers.mjs';
import { submitRequest, getRequest } from '../src/requests.mjs';
import { uploadDocument, getDocument, MAX_BYTES } from '../src/documents.mjs';

const pdf = (size = 12) => ({ name: 'receipt.pdf', mime: 'application/pdf', content: Buffer.alloc(size, 65).toString('base64') });

test('a supporting document is stored against the request and listed on it', () => {
  const store = newStore();
  const request = draftPayment(store);
  const document = uploadDocument(store, actors.maker, request.id, pdf());
  assert.equal(document.name, 'receipt.pdf');
  assert.equal(document.size, 12);
  assert.equal(document.uploadedBy, 'Ana Maker');
  const reloaded = getRequest(store, actors.maker, request.id);
  assert.equal(reloaded.documents.length, 1);
  assert.match(reloaded.history.at(-1).detail, /Supporting document attached: receipt\.pdf/);
  const fetched = getDocument(store, actors.approver, document.id);
  assert.equal(fetched.mime, 'application/pdf');
  assert.equal(Buffer.from(fetched.content).length, 12);
  assert.equal(fetched.requestNumber, 'PR-2026-000001');
  store.close();
});

test('only PDFs and images within the size limit are accepted', () => {
  const store = newStore();
  const request = draftPayment(store);
  assert.throws(() => uploadDocument(store, actors.maker, request.id, { name: 'macro.html', mime: 'text/html', content: Buffer.from('<script>').toString('base64') }), /not accepted/);
  assert.throws(() => uploadDocument(store, actors.maker, request.id, { ...pdf(), content: '' }), /empty/);
  assert.throws(() => uploadDocument(store, actors.maker, request.id, { name: 'big.pdf', mime: 'application/pdf', content: Buffer.alloc(MAX_BYTES + 10).toString('base64') }), /limited to/);
  assert.throws(() => uploadDocument(store, actors.maker, request.id, { name: 'x.pdf', mime: 'nonsense', content: 'QQ==' }), /Unsupported file type/);
  assert.ok(uploadDocument(store, actors.maker, request.id, { name: 'photo.jpg', mime: 'image/jpeg', content: 'QQ==' }));
  store.close();
});

test('a maker cannot attach after submitting, but a reviewer still can', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  assert.throws(() => uploadDocument(store, actors.maker, request.id, pdf()), /can no longer be changed by its maker/);
  const added = uploadDocument(store, actors.approver, request.id, pdf());
  assert.equal(getRequest(store, actors.approver, request.id).documents.length, 1);
  assert.equal(added.uploadedBy, 'Carla Approver');
  store.close();
});

test('documents are invisible across makers and a viewer may not attach', () => {
  const store = newStore();
  const request = draftPayment(store);
  const document = uploadDocument(store, actors.maker, request.id, pdf());
  assert.throws(() => uploadDocument(store, actors.maker2, request.id, pdf()), /not found/i);
  assert.throws(() => getDocument(store, actors.maker2, document.id), /not found/i);
  assert.throws(() => uploadDocument(store, actors.viewer, request.id, pdf()), /permission/);
  assert.throws(() => getDocument(store, actors.admin, '00000000-0000-4000-8000-000000000000'), /not found/i);
  store.close();
});
