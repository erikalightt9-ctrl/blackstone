import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, draftPayment, draftPettyCash, demoBankAccount } from './helpers.mjs';
import { submitRequest, decideRequest, cancelRequest, addComment } from '../src/requests.mjs';
import { listBankRecords, createBankRecord, openBankAccount } from '../src/bank.mjs';
import { listBankAccounts, createBank } from '../src/accounts.mjs';
import { balance, setOpeningBalance } from '../src/pettycash.mjs';
import { dashboard, listRequests } from '../src/search.mjs';
import { reportsFor } from '../src/reports.mjs';

// A Requester is a Maker without the passbook: they file payment and petty cash requests and
// see nothing of the bank accounts or the petty cash box.

test('a requester files payment and petty cash requests, and submits them', () => {
  const store = newStore();
  const payment = draftPayment(store, {}, actors.requester);
  const petty = draftPettyCash(store, {}, actors.requester);
  assert.match(payment.number, /^PR-/);
  assert.match(petty.number, /^PCR-/);
  assert.equal(submitRequest(store, actors.requester, payment.id).status, 'submitted');
  const commented = addComment(store, actors.requester, payment.id, { text: 'Receipt to follow' });
  assert.ok(commented.history.some(entry => entry.action === 'comment' && entry.detail === 'Receipt to follow'));
  store.close();
});

test('but the approving, releasing and cancelling stay with the approver', () => {
  const store = newStore();
  const payment = draftPayment(store, {}, actors.requester);
  submitRequest(store, actors.requester, payment.id);
  for (const action of ['approve', 'reject']) {
    assert.throws(() => decideRequest(store, actors.requester, payment.id, action, { remarks: 'no' }), /permission|not available/i);
  }
  assert.throws(() => cancelRequest(store, actors.requester, payment.id, { reason: 'changed my mind' }), /permission|not available/i);
  store.close();
});

test('a requester sees only their own requests, never anyone else\'s', () => {
  const store = newStore();
  draftPayment(store, { payee: 'Theirs' }, actors.maker);
  draftPayment(store, { payee: 'Mine' }, actors.requester);
  const mine = listRequests(store, actors.requester, { kind: 'payment' });
  assert.deepEqual(mine.rows.map(row => row.payee), ['Mine']);
  assert.equal(listRequests(store, actors.admin, { kind: 'payment' }).rows.length, 2, 'while the administrator sees both');
  store.close();
});

test('a requester cannot reach the bank records at all', () => {
  const store = newStore();
  const account = demoBankAccount(store);
  openBankAccount(store, actors.maker, { accountId: account.id, entryDate: '2026-09-01', balance: 1000, remarks: '' });

  assert.throws(() => listBankRecords(store, actors.requester, {}), /permission/);
  assert.throws(() => createBankRecord(store, actors.requester, {
    accountId: account.id, entryDate: '2026-09-10', reference: '', type: 'Deposit', description: 'x', debit: 0, credit: 5, remarks: '',
  }), /permission/);
  assert.throws(() => openBankAccount(store, actors.requester, { accountId: account.id, entryDate: '2026-09-02', balance: 1, remarks: '' }), /permission/);
  assert.throws(() => listBankAccounts(store, actors.requester), /permission/);
  assert.throws(() => createBank(store, actors.requester, { name: 'Nope' }), /permission/);

  // The maker's passbook access is untouched by any of this.
  assert.equal(listBankRecords(store, actors.maker, {}).rows.length, 1);
  store.close();
});

test('and never sees what is in the petty cash box', () => {
  const store = newStore();
  setOpeningBalance(store, actors.admin, { entryDate: '2026-09-01', amount: 50000, source: 'Cheque', remarks: '' });
  // The fund itself is guarded at the route (see access.test.mjs); what matters here is that
  // the figure never reaches a requester's payload in the first place.
  const view = dashboard(store, actors.requester);
  assert.equal(view.pettyCash.seesFund, false);
  assert.equal(view.pettyCash.balance, undefined, 'the figure is absent from the payload, not merely hidden on screen');
  assert.equal(view.bank, null, 'and there is no passbook summary either');
  assert.equal(balance(store), 50000, 'though the fund itself is unaffected');
  store.close();
});

test('the fund reports are not even offered to a requester', () => {
  const store = newStore();
  const offered = reportsFor(actors.requester).map(report => report.id);
  assert.equal(offered.includes('petty-cash-ledger'), false);
  assert.equal(offered.includes('replenishments'), false);
  assert.ok(offered.includes('payment-register'), 'but their own registers are');
  store.close();
});
