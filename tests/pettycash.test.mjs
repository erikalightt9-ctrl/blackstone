import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, categoryId, draftPettyCash } from './helpers.mjs';
import { submitRequest, decideRequest, cancelRequest, getRequest } from '../src/requests.mjs';
import {
  setOpeningBalance, disburse, recordReturn, recordAdjustment, balance, ledger,
  createReplenishment, decideReplenishment, fundReplenishment, listReplenishments,
} from '../src/pettycash.mjs';

function openFund(store, amount = 50000) {
  return setOpeningBalance(store, actors.admin, { entryDate: '2026-09-01', amount, source: '', remarks: 'Opening petty cash fund' });
}
function approvedPettyCash(store, overrides = {}) {
  const request = draftPettyCash(store, overrides);
  submitRequest(store, actors.maker, request.id);
  return decideRequest(store, actors.approver, request.id, 'approve', {});
}

test('the fund opens once and only an administrator may open it', () => {
  const store = newStore();
  assert.throws(() => setOpeningBalance(store, actors.releaser, { entryDate: '2026-09-01', amount: 50000, source: '', remarks: '' }), /permission/);
  assert.equal(balance(store), 0);
  openFund(store);
  assert.equal(balance(store), 50000);
  assert.throws(() => openFund(store), /already open/);
  store.close();
});

test('the fund is reduced on actual disbursement, not on approval', () => {
  const store = newStore();
  openFund(store, 50000);
  const request = approvedPettyCash(store);
  assert.equal(request.total, 3500);
  assert.equal(balance(store), 50000, 'approval alone moves no cash');
  const disbursed = disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana Maker', remarks: '' });
  assert.equal(disbursed.status, 'disbursed');
  assert.equal(balance(store), 46500, '50,000.00 - 3,500.00');
  const entry = ledger(store).entries[0];
  assert.equal(entry.type, 'disbursement');
  assert.equal(entry.reference, 'PCR-2026-000001');
  assert.equal(entry.out, 3500);
  assert.equal(entry.balance, 46500);
  assert.equal(entry.actor, 'Dina Releaser');
  store.close();
});

test('replenishment raises the balance only when the funding is recorded', () => {
  const store = newStore();
  openFund(store, 10000);
  const replenishment = createReplenishment(store, actors.releaser, { entryDate: '2026-09-25', amount: 40000, source: 'BDO current account', remarks: '' });
  assert.equal(replenishment.number, 'PCF-2026-0001');
  assert.equal(replenishment.status, 'requested');
  assert.equal(balance(store), 10000);
  assert.throws(() => fundReplenishment(store, actors.releaser, replenishment.id, { entryDate: '2026-09-25', remarks: '' }), /Only an approved replenishment/);
  decideReplenishment(store, actors.approver, replenishment.id, true);
  assert.equal(balance(store), 10000, 'approval alone adds no cash');
  const funded = fundReplenishment(store, actors.releaser, replenishment.id, { entryDate: '2026-09-25', remarks: 'Cheque encashed' });
  assert.equal(funded.status, 'funded');
  assert.equal(balance(store), 50000, '10,000.00 + 40,000.00');
  assert.equal(ledger(store).entries[0].in, 40000);
  assert.deepEqual(funded.history.map(h => h.action), ['create', 'approve', 'fund']);
  store.close();
});

test('a rejected replenishment can never be funded', () => {
  const store = newStore();
  openFund(store, 10000);
  const replenishment = createReplenishment(store, actors.releaser, { entryDate: '2026-09-25', amount: 40000, source: '', remarks: '' });
  decideReplenishment(store, actors.approver, replenishment.id, false, 'Not yet needed');
  assert.equal(listReplenishments(store)[0].status, 'rejected');
  assert.throws(() => fundReplenishment(store, actors.releaser, replenishment.id, { entryDate: '2026-09-25', remarks: '' }), /Only an approved replenishment/);
  assert.throws(() => decideReplenishment(store, actors.approver, replenishment.id, true), /already rejected/);
  assert.equal(balance(store), 10000);
  store.close();
});

test('the fund cannot be overdrawn', () => {
  const store = newStore();
  openFund(store, 3000);
  const request = approvedPettyCash(store);
  assert.throws(() => disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' }), /would overdraw/);
  assert.equal(balance(store), 3000);
  assert.equal(getRequest(store, actors.releaser, request.id).status, 'approved', 'the failed disbursement rolled back the status too');
  assert.equal(ledger(store).entries.length, 1, 'no partial ledger entry was written');
  store.close();
});

test('cancelling a disbursed request does not silently restore the fund; a return does', () => {
  const store = newStore();
  openFund(store, 50000);
  const request = approvedPettyCash(store);
  disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana Maker', remarks: '' });
  const cancelled = cancelRequest(store, actors.approver, request.id, { reason: 'Trip was called off' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.previousStatus, 'disbursed');
  assert.equal(balance(store), 46500, 'the balance is untouched by cancellation alone');
  assert.match(cancelled.history.at(-1).detail, /cash already released: record a return/);
  const returned = recordReturn(store, actors.releaser, request.id, { entryDate: '2026-09-22', amount: 3500, reason: 'Unused cash returned in full' });
  assert.equal(balance(store), 50000);
  assert.equal(returned.status, 'cancelled', 'a return is a ledger movement, not a status change');
  const entries = ledger(store).entries;
  assert.equal(entries[0].type, 'return');
  assert.equal(entries[0].in, 3500);
  assert.equal(entries[1].type, 'disbursement', 'the original disbursement is still there, unaltered');
  assert.equal(entries[1].out, 3500);
  store.close();
});

test('a partial return is allowed but the fund can never be over-returned', () => {
  const store = newStore();
  openFund(store, 50000);
  const request = approvedPettyCash(store);
  disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' });
  recordReturn(store, actors.releaser, request.id, { entryDate: '2026-09-22', amount: 1200.5, reason: 'Change returned' });
  assert.equal(balance(store), 47700.5);
  assert.throws(() => recordReturn(store, actors.releaser, request.id, { entryDate: '2026-09-22', amount: 2500, reason: 'Too much' }), /Only 2,?299.50 remains outstanding/);
  recordReturn(store, actors.releaser, request.id, { entryDate: '2026-09-23', amount: 2299.5, reason: 'Balance returned' });
  assert.equal(balance(store), 50000);
  assert.throws(() => recordReturn(store, actors.releaser, request.id, { entryDate: '2026-09-24', amount: 1, reason: 'Again' }), /nothing left to return/);
  store.close();
});

test('cash cannot be returned against a request that was never disbursed', () => {
  const store = newStore();
  openFund(store, 50000);
  const request = approvedPettyCash(store);
  assert.throws(() => recordReturn(store, actors.releaser, request.id, { entryDate: '2026-09-22', amount: 100, reason: 'x' }), /cannot be reversed/);
  store.close();
});

test('the running balance survives a long mixed sequence of movements', () => {
  const store = newStore();
  openFund(store, 50000);
  let expected = 50000;
  for (let i = 0; i < 12; i++) {
    const request = approvedPettyCash(store, { lines: [{ particulars: `Fare ${i}`, quantity: 3, unitAmount: 133.33, categoryId: categoryId(store, 'TRANSPORTATION') }] });
    disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' });
    expected = Math.round((expected - 399.99) * 100) / 100;
    assert.equal(balance(store), expected, `after disbursement ${i + 1}`);
  }
  const replenishment = createReplenishment(store, actors.releaser, { entryDate: '2026-09-30', amount: 4799.88, source: '', remarks: '' });
  decideReplenishment(store, actors.approver, replenishment.id, true);
  fundReplenishment(store, actors.releaser, replenishment.id, { entryDate: '2026-09-30', remarks: '' });
  assert.equal(balance(store), 50000, 'twelve disbursements of 399.99 restored exactly');
  assert.equal(ledger(store).entries.length, 14);
  const running = ledger(store).entries.slice().reverse().reduce((acc, e) => Math.round((acc + e.in - e.out) * 100) / 100, 0);
  assert.equal(running, 50000, 'the stored running balance agrees with a replay of the ledger');
  store.close();
});

test('an administrator can record a documented fund adjustment in either direction', () => {
  const store = newStore();
  openFund(store, 50000);
  assert.throws(() => recordAdjustment(store, actors.releaser, { entryDate: '2026-09-30', amount: 50, reason: 'Count shortage', direction: 'out' }), /permission/);
  recordAdjustment(store, actors.admin, { entryDate: '2026-09-30', amount: 50, reason: 'Cash count shortage', direction: 'out' });
  assert.equal(balance(store), 49950);
  recordAdjustment(store, actors.admin, { entryDate: '2026-09-30', amount: 50, reason: 'Shortage recovered', direction: 'in' });
  assert.equal(balance(store), 50000);
  assert.equal(ledger(store, { type: 'adjustment' }).entries.length, 2);
  store.close();
});

test('only an approver disburses, and only once', () => {
  const store = newStore();
  openFund(store, 50000);
  const request = approvedPettyCash(store);
  assert.throws(() => disburse(store, actors.maker, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' }), /permission/);
  assert.throws(() => disburse(store, actors.viewer, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' }), /permission/);
  disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' });
  assert.equal(balance(store), 46500);
  assert.throws(() => disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' }), /cannot be disbursed/);
  store.close();
});

test('the ledger filters by date range and type, and reports its own total', () => {
  const store = newStore();
  openFund(store, 50000);
  const request = approvedPettyCash(store);
  disburse(store, actors.releaser, request.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' });
  assert.equal(ledger(store, { from: '2026-09-10' }).entries.length, 1);
  assert.equal(ledger(store, { to: '2026-09-10' }).entries.length, 1);
  assert.equal(ledger(store, { from: '2026-09-01', to: '2026-09-30' }).total, 2);
  assert.equal(ledger(store, { type: 'opening' }).entries[0].in, 50000);
  assert.equal(ledger(store, { limit: 1 }).entries.length, 1);
  store.close();
});
