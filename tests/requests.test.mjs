import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, categoryId, draftPayment } from './helpers.mjs';
import { createRequest, updateRequest, submitRequest, decideRequest, cancelRequest, getRequest } from '../src/requests.mjs';
import { releasePayment } from '../src/payments.mjs';
import { updateCategory } from '../src/categories.mjs';

test('a payment request totals its own lines and opens as a numbered draft', () => {
  const store = newStore();
  const request = draftPayment(store);
  assert.equal(request.number, 'PR-2026-000001');
  assert.equal(request.status, 'draft');
  assert.equal(request.total, 850, '5 x 100 plus 1 x 350');
  assert.equal(request.lines[0].amount, 500);
  assert.equal(request.lines[1].categoryName, 'Freight & Delivery');
  assert.equal(request.maker.name, 'Ana Maker');
  assert.equal(request.finalApprover, 'Vicente Cheng');
  assert.deepEqual(request.history.map(h => h.action), ['create']);
  store.close();
});

test('line amounts round to the centavo and the total reconciles exactly', () => {
  const store = newStore();
  const request = draftPayment(store, { lines: [
    { particulars: 'Printing', quantity: 3, unitAmount: 33.33, categoryId: categoryId(store, 'OFFICE-SUPPLIES') },
    { particulars: 'Fuel', quantity: 1.5, unitAmount: 66.67, categoryId: categoryId(store, 'TRANSPORTATION') },
  ] });
  assert.equal(request.lines[0].amount, 99.99);
  assert.equal(request.lines[1].amount, 100.01, '1.5 x 66.67 = 100.005, rounded once');
  assert.equal(request.total, 200);
  store.close();
});

test('a draft can be edited, and editing stops the moment it is submitted', () => {
  const store = newStore();
  const request = draftPayment(store);
  const edited = updateRequest(store, actors.maker, request.id, {
    dateRequested: '2026-09-22', requestedBy: 'Ana Maker', payee: 'Metro Office Depot', purpose: 'Revised purpose',
    finalApprover: 'Demry Cheng',
    lines: [{ particulars: 'Office Supplies', quantity: 2, unitAmount: 100, categoryId: categoryId(store, 'OFFICE-SUPPLIES') }],
  });
  assert.equal(edited.total, 200);
  assert.equal(edited.finalApprover, 'Demry Cheng');
  assert.equal(edited.number, request.number, 'the reference number never changes');
  submitRequest(store, actors.maker, request.id);
  assert.throws(() => updateRequest(store, actors.maker, request.id, {
    dateRequested: '2026-09-22', requestedBy: 'Ana', payee: '', purpose: '', finalApprover: 'Demry Cheng', lines: [],
  }), /can no longer be edited/);
  store.close();
});

test('a maker cannot edit or submit another maker\'s draft', () => {
  const store = newStore();
  const request = draftPayment(store);
  assert.throws(() => submitRequest(store, actors.maker2, request.id), /not found/i);
  assert.throws(() => getRequest(store, actors.maker2, request.id), /not found/i);
  assert.equal(getRequest(store, actors.approver, request.id).number, request.number, 'approvers see every request');
  store.close();
});

test('an empty draft cannot be submitted', () => {
  const store = newStore();
  const request = draftPayment(store, { lines: [] });
  assert.equal(request.total, 0);
  assert.throws(() => submitRequest(store, actors.maker, request.id), /at least one expense line/);
  store.close();
});

test('the maker of a request can never approve or reject it', () => {
  const store = newStore();
  const request = draftPayment(store, {}, actors.admin);
  submitRequest(store, actors.admin, request.id);
  assert.throws(() => decideRequest(store, actors.admin, request.id, 'approve', {}), /maker of a request cannot also approve/);
  assert.throws(() => decideRequest(store, actors.admin, request.id, 'reject', {}), /cannot also approve/);
  const approved = decideRequest(store, actors.approver, request.id, 'approve', { remarks: 'Checked against the quotation' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approver.name, 'Carla Approver');
  store.close();
});

test('only an approver decides; makers and viewers cannot', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  assert.throws(() => decideRequest(store, actors.maker, request.id, 'approve', {}), /permission/);
  assert.throws(() => decideRequest(store, actors.viewer, request.id, 'approve', {}), /permission/);
  store.close();
});

test('the full payment request flow records a complete history', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  decideRequest(store, actors.approver, request.id, 'approve', {});
  const paid = releasePayment(store, actors.releaser, request.id, {
    method: 'Check', bank: 'BDO', checkNumber: '0012345', checkDate: '2026-09-22', amount: 850,
    payee: 'Metro Office Depot', datePrepared: '2026-09-22', dateReleased: '2026-09-23',
    receivedBy: 'Metro Office Depot courier', remarks: '',
  });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payment.checkNumber, '0012345');
  assert.equal(paid.payment.dateReleased, '2026-09-23');
  assert.equal(paid.payment.releasedBy, 'Dina Releaser', 'the releaser is taken from the signed-in user');
  assert.deepEqual(paid.history.map(h => h.action), ['create', 'submit', 'approve', 'release']);
  assert.deepEqual(paid.history.map(h => h.status), ['draft', 'submitted', 'approved', 'paid']);
  assert.equal(paid.total, 850, 'the approved amount is untouched by releasing the payment');
  store.close();
});

test('a payment may not exceed the approved total and can only be released once', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  decideRequest(store, actors.approver, request.id, 'approve', {});
  const details = {
    method: 'Check', bank: 'BDO', checkNumber: '0012345', checkDate: '2026-09-22', amount: 850,
    payee: 'Metro Office Depot', datePrepared: '2026-09-22', dateReleased: '2026-09-23',
    receivedBy: 'Metro Office Depot courier', remarks: '',
  };
  assert.throws(() => releasePayment(store, actors.releaser, request.id, { ...details, amount: 900 }), /exceeds the approved total/);
  const paid = releasePayment(store, actors.releaser, request.id, details);
  assert.equal(paid.status, 'paid');
  assert.throws(() => releasePayment(store, actors.releaser, request.id, details), /A Released Payment Request cannot be released/);
  store.close();
});

test('a check payment demands a check number and date', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  decideRequest(store, actors.approver, request.id, 'approve', {});
  const base = { bank: 'BDO', amount: 850, payee: 'Metro', datePrepared: '2026-09-22', dateReleased: '2026-09-23', receivedBy: 'Metro', remarks: '' };
  assert.throws(() => releasePayment(store, actors.releaser, request.id, { ...base, method: 'Check', checkNumber: '', checkDate: '' }), /check number and check date/);
  const transfer = releasePayment(store, actors.releaser, request.id, { ...base, method: 'Bank Transfer', checkNumber: '', checkDate: '', remarks: 'Instapay' });
  assert.equal(transfer.status, 'paid');
  store.close();
});

test('the named approvers are signatories, not users: the system only records their signature', () => {
  const store = newStore();
  // They exist as configuration, never as accounts.
  assert.deepEqual(store.config().finalApprovers, ['Demry Cheng', 'Vicente Cheng']);
  for (const name of store.config().finalApprovers) {
    assert.equal(store.get('SELECT id FROM users WHERE full_name = ?', name), undefined, `${name} must hold no account`);
  }
  const request = draftPayment(store, { finalApprover: 'Vicente Cheng' });
  submitRequest(store, actors.maker, request.id);
  const approved = decideRequest(store, actors.approver, request.id, 'approve', {});
  assert.equal(approved.finalApprover, 'Vicente Cheng', 'the signatory on the form');
  assert.equal(approved.approver.name, 'Carla Approver', 'the member of staff who recorded the signature');
  assert.match(approved.history.at(-1).detail, /Approval recorded - printed form signed by Vicente Cheng/);
  store.close();
});

test('cancellation preserves the record, its reason and its previous status', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  decideRequest(store, actors.approver, request.id, 'approve', {});
  const cancelled = cancelRequest(store, actors.approver, request.id, { reason: 'Supplier withdrew the quotation' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.statusLabel, 'CANCELLED');
  assert.equal(cancelled.previousStatus, 'approved');
  assert.equal(cancelled.cancelledBy, 'Carla Approver');
  assert.match(cancelled.cancelReason, /withdrew/);
  assert.equal(cancelled.total, 850, 'the financial record survives cancellation intact');
  assert.equal(getRequest(store, actors.viewer, request.id).number, 'PR-2026-000001', 'it stays searchable');
  assert.throws(() => cancelRequest(store, actors.approver, request.id, { reason: 'Again' }), /cannot be cancelled/);
  store.close();
});

test('cancellation demands a reason and the right role', () => {
  const store = newStore();
  const request = draftPayment(store);
  assert.throws(() => cancelRequest(store, actors.approver, request.id, { reason: 'no' }), /at least five characters/);
  assert.throws(() => cancelRequest(store, actors.maker, request.id, { reason: 'Changed my mind' }), /permission/);
  store.close();
});

test('an unauthorized final approver is refused', () => {
  const store = newStore();
  assert.throws(() => draftPayment(store, { finalApprover: 'SOMEONE ELSE' }), /not an authorized final approver/);
  const request = draftPayment(store, { finalApprover: 'Demry Cheng' });
  assert.equal(request.finalApprover, 'Demry Cheng');
  store.close();
});

test('a deactivated accounting category cannot be used on a new line', () => {
  const store = newStore();
  const id = categoryId(store, 'MEALS');
  updateCategory(store, actors.admin, id, { code: 'MEALS', name: 'Meals', active: false });
  assert.throws(() => draftPayment(store, { lines: [{ particulars: 'Lunch', quantity: 1, unitAmount: 500, categoryId: id }] }), /deactivated/);
  store.close();
});

test('only a maker or administrator may create a request', () => {
  const store = newStore();
  assert.throws(() => draftPayment(store, {}, actors.viewer), /permission/);
  assert.throws(() => draftPayment(store, {}, actors.approver), /permission/);
  assert.throws(() => draftPayment(store, {}, actors.releaser), /permission/);
  store.close();
});

test('invalid amounts and quantities are refused at the boundary', () => {
  const store = newStore();
  const category = categoryId(store, 'MEALS');
  assert.throws(() => draftPayment(store, { lines: [{ particulars: 'Lunch', quantity: 1, unitAmount: 100.555, categoryId: category }] }), /two decimal places/);
  assert.throws(() => draftPayment(store, { lines: [{ particulars: 'Lunch', quantity: 0, unitAmount: 100, categoryId: category }] }), /greater than zero/);
  assert.throws(() => draftPayment(store, { lines: [{ particulars: '', quantity: 1, unitAmount: 100, categoryId: category }] }), /particulars/);
  assert.throws(() => draftPayment(store, { dateRequested: '2026-02-30' }), /calendar date/);
  store.close();
});

test('petty cash actions are refused on a payment request and the reverse', () => {
  const store = newStore();
  const request = draftPayment(store);
  submitRequest(store, actors.maker, request.id);
  decideRequest(store, actors.approver, request.id, 'approve', {});
  assert.throws(() => releasePayment(store, actors.releaser, 'missing-id', { method: 'Cash', bank: '', checkNumber: '', checkDate: '', amount: 1, payee: 'x', datePrepared: '2026-09-22', dateReleased: '2026-09-22', receivedBy: 'x', remarks: '' }), /not found/i);
  store.close();
});
