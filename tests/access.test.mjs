import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, draftPettyCash } from './helpers.mjs';
import { dashboard } from '../src/search.mjs';
import { setOpeningBalance, ledger, createReplenishment, balance } from '../src/pettycash.mjs';
import { submitRequest } from '../src/requests.mjs';
import { runReport, reportsFor, REPORT_LIST } from '../src/reports.mjs';
import { createApp } from '../src/server.mjs';
import { addUser } from '../src/auth.mjs';
import { Store } from '../src/store.mjs';

const ORIGIN = 'http://127.0.0.1:3403';
const PASSWORD = 'a-strong-test-password';

test('the petty cash fund balance never reaches a maker', () => {
  const store = newStore();
  setOpeningBalance(store, actors.admin, { entryDate: '2026-09-01', amount: 50000, source: '', remarks: '' });
  const request = draftPettyCash(store);
  submitRequest(store, actors.maker, request.id);

  const forMaker = dashboard(store, actors.maker);
  assert.equal(forMaker.pettyCash.seesFund, false);
  assert.equal(forMaker.pettyCash.balance, undefined, 'the balance is left out of the payload entirely');
  assert.equal(forMaker.pettyCash.replenishments, undefined);
  assert.equal(forMaker.pettyCash.replenishedTotal, undefined);
  assert.equal(forMaker.pettyCash.fundOpened, undefined);
  assert.equal(forMaker.pettyCash.count.submitted, 1, 'but the maker still sees their own requests');

  for (const actor of [actors.admin, actors.approver, actors.viewer]) {
    const view = dashboard(store, actor);
    assert.equal(view.pettyCash.seesFund, true, actor.role);
    assert.equal(view.pettyCash.balance, 50000, actor.role);
  }
  store.close();
});

test('Reports cannot be used to read the fund balance a maker is not allowed to see', () => {
  const store = newStore();
  setOpeningBalance(store, actors.admin, { entryDate: '2026-09-01', amount: 50000, source: '', remarks: '' });

  // The two fund reports are refused outright, not merely filtered.
  for (const id of ['petty-cash-ledger', 'replenishments']) {
    assert.throws(() => runReport(store, actors.maker, id, {}), /permission/, id);
    assert.ok(runReport(store, actors.admin, id, {}), `${id} still runs for an administrator`);
  }
  // And they are not even offered to a maker.
  const offered = reportsFor(actors.maker).map(report => report.id);
  assert.ok(!offered.includes('petty-cash-ledger'));
  assert.ok(!offered.includes('replenishments'));
  assert.ok(offered.includes('petty-cash-register'), 'their own petty cash requests remain reportable');
  assert.equal(reportsFor(actors.admin).length, REPORT_LIST.length, 'an administrator keeps every report');
  assert.equal(reportsFor(actors.viewer).length, REPORT_LIST.length);
  store.close();
});

test('fund work is closed to a maker at the service layer too', () => {
  const store = newStore();
  setOpeningBalance(store, actors.admin, { entryDate: '2026-09-01', amount: 50000, source: '', remarks: '' });
  assert.throws(() => createReplenishment(store, actors.maker, { entryDate: '2026-09-02', amount: 100, source: '', remarks: '' }), /permission/);
  assert.throws(() => setOpeningBalance(store, actors.maker, { entryDate: '2026-09-01', amount: 1, source: '', remarks: '' }), /permission/);
  assert.equal(balance(store), 50000);
  assert.equal(ledger(store).entries.length, 1);
  store.close();
});

test('every fund route is refused to a maker over HTTP, and the bank routes are not', async t => {
  const store = new Store();
  const app = createApp({ store, origin: ORIGIN, setupToken: 'test-only-setup-code' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;

  const admin = await addUser(store, { username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', role: 'admin', password: PASSWORD });
  await addUser(store, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker', password: PASSWORD }, admin);
  const signIn = async username => {
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ username, password: PASSWORD }) });
    const data = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrf };
  };
  const call = (path, auth, { method = 'GET', body } = {}) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const maker = await signIn('maker1');
  const boss = await signIn('admin');

  for (const path of ['/api/petty-cash', '/api/replenishments']) {
    assert.equal((await call(path, maker)).status, 403, `${path} is closed to a maker`);
    assert.equal((await call(path, boss)).status, 200, `${path} is open to an administrator`);
  }
  assert.equal((await call('/api/petty-cash/open', maker, { method: 'POST', body: { entryDate: '2026-09-01', amount: 1 } })).status, 403);

  const bootstrap = await (await call('/api/bootstrap', maker)).json();
  assert.equal(bootstrap.canSeePettyCashFund, false);
  assert.equal(bootstrap.canEncodeBankRecords, true, 'the maker keeps the passbook');
  assert.equal(bootstrap.canVoidBankRecords, false);
  assert.equal(bootstrap.canManageBankAccounts, false, 'but does not manage the accounts themselves');
  assert.equal(bootstrap.dashboard.pettyCash.balance, undefined);

  // A maker keeps the passbook but does not decide which accounts the company has.
  assert.equal((await call('/api/banks', maker, { method: 'POST', body: { name: 'Rogue Bank' } })).status, 403, 'a maker cannot add a bank');
  const bank = await (await call('/api/banks', boss, { method: 'POST', body: { name: 'BDO Unibank' } })).json();
  assert.equal((await call('/api/bank-accounts', maker, { method: 'POST', body: {
    bankId: bank.id, accountName: 'Rogue', currency: 'PHP',
  } })).status, 403, 'nor a bank account');
  const account = await (await call('/api/bank-accounts', boss, { method: 'POST', body: {
    bankId: bank.id, accountName: 'Operating Account', accountNumber: '0123', currency: 'PHP', accountType: 'Savings',
  } })).json();
  assert.equal((await call('/api/bank-accounts', maker)).status, 200, 'but a maker may read them, to encode against them');
  assert.equal((await call(`/api/bank-accounts/${account.id}`, maker, { method: 'DELETE' })).status, 403, 'and cannot remove one');

  const line = extra => ({
    accountId: account.id, entryDate: '2026-09-10', reference: 'DEP-1', type: 'Deposit',
    description: 'Cash deposit', debit: 0, credit: 5000, remarks: '', ...extra,
  });
  const unopened = await call('/api/bank', maker, { method: 'POST', body: line() });
  assert.equal(unopened.status, 409, 'not before the beginning balance is entered');
  assert.equal((await call('/api/bank/open', maker, { method: 'POST', body: {
    accountId: account.id, entryDate: '2026-09-01', balance: 1000, remarks: '',
  } })).status, 201, 'which the maker may enter by hand');

  const encoded = await call('/api/bank', maker, { method: 'POST', body: line() });
  assert.equal(encoded.status, 201);
  const record = await encoded.json();
  assert.equal(record.balance, 6000, 'the balance is worked out by the system');
  assert.equal((await call('/api/bank', maker)).status, 200);
  assert.equal((await call(`/api/bank/${record.id}`, maker, { method: 'POST', body: line({ reference: 'DEP-2' }) })).status, 200, 'a maker manages their own encoding');
  assert.equal((await call(`/api/bank/${record.id}/void`, maker, { method: 'POST', body: { reason: 'Encoded twice' } })).status, 403, 'voiding is not theirs');
  assert.equal((await call(`/api/bank/${record.id}/void`, boss, { method: 'POST', body: { reason: 'Encoded twice' } })).status, 200);

  const adminBootstrap = await (await call('/api/bootstrap', boss)).json();
  assert.equal(adminBootstrap.canSeePettyCashFund, true);
  assert.equal(adminBootstrap.canVoidBankRecords, true);
  assert.equal(adminBootstrap.canManageBankAccounts, true);
  assert.equal((await call('/api/bank/static/../../etc', boss)).status, 404);
});
