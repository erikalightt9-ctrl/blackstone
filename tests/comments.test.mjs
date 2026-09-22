import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, categoryId, draftPayment } from './helpers.mjs';
import { updateRequest, submitRequest, decideRequest, addComment, getRequest } from '../src/requests.mjs';
import { listRequests } from '../src/search.mjs';

const edit = (store, actor, id, overrides = {}) => updateRequest(store, actor, id, {
  dateRequested: '2026-09-21', requestedBy: 'Angela Din', payee: 'Metro Office Depot', purpose: 'Rewritten',
  finalApprover: 'Demry Cheng',
  lines: [{ particulars: 'Something else', quantity: 1, unitAmount: 1, categoryId: categoryId(store, 'MEALS') }],
  ...overrides,
});

test('nobody but the maker may rewrite a request, administrators included', () => {
  const store = newStore();
  const request = draftPayment(store);
  assert.throws(() => edit(store, actors.admin, request.id), /Only the maker who prepared this request may edit it/);
  assert.throws(() => edit(store, actors.approver, request.id), /permission/);
  assert.throws(() => edit(store, actors.maker2, request.id), /not found/i);
  assert.throws(() => submitRequest(store, actors.admin, request.id), /Only the maker who prepared this request may submit it/);
  assert.equal(getRequest(store, actors.admin, request.id).total, 850, 'the maker\'s figures are untouched');
  const edited = edit(store, actors.maker, request.id);
  assert.equal(edited.purpose, 'Rewritten', 'the maker can still edit their own draft');
  store.close();
});

test('an administrator sees everything and can comment, but the request never changes', () => {
  const store = newStore();
  const request = draftPayment(store);
  const before = getRequest(store, actors.admin, request.id);
  const commented = addComment(store, actors.admin, request.id, { text: 'The delivery fee needs the supplier quotation attached before I release this.' });
  assert.equal(commented.comments.length, 1);
  assert.equal(commented.comments[0].actor, 'System Administrator');
  assert.match(commented.comments[0].text, /supplier quotation/);
  assert.equal(commented.total, before.total, 'commenting changes no figure');
  assert.equal(commented.status, before.status, 'commenting changes no status');
  assert.deepEqual(commented.lines.map(l => l.particulars), before.lines.map(l => l.particulars));
  store.close();
});

test('the maker sees the feedback on their own request and can answer it', () => {
  const store = newStore();
  const request = draftPayment(store);
  addComment(store, actors.admin, request.id, { text: 'Please attach the quotation.' });
  const asMaker = getRequest(store, actors.maker, request.id);
  assert.equal(asMaker.comments.length, 1);
  addComment(store, actors.maker, request.id, { text: 'Quotation attached, thank you.' });
  const thread = getRequest(store, actors.maker, request.id).comments;
  assert.deepEqual(thread.map(c => c.actor), ['System Administrator', 'Ana Maker']);
  assert.equal(listRequests(store, actors.maker, {}).rows[0].comments, 2, 'the list flags the feedback');
  store.close();
});

test('comments are permanent and survive into the history', () => {
  const store = newStore();
  const request = draftPayment(store);
  addComment(store, actors.approver, request.id, { text: 'Checked against the budget.' });
  submitRequest(store, actors.maker, request.id);
  decideRequest(store, actors.approver, request.id, 'approve', {});
  const final = getRequest(store, actors.admin, request.id);
  assert.deepEqual(final.history.map(h => h.action), ['create', 'comment', 'submit', 'approve']);
  assert.equal(final.comments.length, 1, 'the comment stays with the request after approval');
  assert.throws(() => store.run("UPDATE audit SET detail = 'tampered' WHERE action = 'comment'"), /cannot be edited/);
  assert.throws(() => store.run("DELETE FROM audit WHERE action = 'comment'"), /cannot be deleted/);
  store.close();
});

test('the buttons a reviewer is offered never include editing a maker\'s request', () => {
  const store = newStore();
  const request = draftPayment(store);
  const forAdmin = getRequest(store, actors.admin, request.id);
  assert.equal(forAdmin.canEdit, false, 'an administrator is not offered the draft editor');
  assert.ok(!forAdmin.actions.includes('submit'), 'only the maker submits their own request');
  const forMaker = getRequest(store, actors.maker, request.id);
  assert.equal(forMaker.canEdit, true);
  assert.deepEqual(forMaker.actions, ['submit']);
  submitRequest(store, actors.maker, request.id);
  assert.equal(getRequest(store, actors.maker, request.id).canEdit, false, 'a submitted request is closed to its maker too');
  store.close();
});

test('a maker is never offered the decision on their own request', () => {
  const store = newStore();
  const request = draftPayment(store, {}, actors.admin);
  submitRequest(store, actors.admin, request.id);
  const own = getRequest(store, actors.admin, request.id);
  assert.ok(!own.actions.includes('approve'), 'the preparer is not offered approval, whatever their role');
  assert.ok(!own.actions.includes('reject'));
  assert.ok(getRequest(store, actors.approver, request.id).actions.includes('approve'), 'another approver is');
  store.close();
});

test('a comment must say something, and a stranger cannot leave one', () => {
  const store = newStore();
  const request = draftPayment(store);
  assert.throws(() => addComment(store, actors.admin, request.id, { text: '' }), /text/);
  assert.throws(() => addComment(store, actors.admin, request.id, { text: 'no' }), /at least three characters/);
  assert.throws(() => addComment(store, actors.viewer, request.id, { text: 'Just looking.' }), /permission/);
  assert.throws(() => addComment(store, actors.maker2, request.id, { text: 'Not my request.' }), /not found/i);
  store.close();
});
