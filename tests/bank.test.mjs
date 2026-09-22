import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, demoBankAccount } from './helpers.mjs';
import { listBankRecords, getBankRecord, openBankAccount, createBankRecord, updateBankRecord, voidBankRecord, bankSummary, ensureBankOpenings } from '../src/bank.mjs';
import { dashboard } from '../src/search.mjs';

const ACCOUNT = 'BDO Unibank 0123';

// The account every line in this file is encoded against, created on first use per store.
const accounts = new WeakMap();
const main = store => {
  if (!accounts.has(store)) accounts.set(store, demoBankAccount(store).id);
  return accounts.get(store);
};

const line = (overrides = {}) => ({
  entryDate: '2026-09-10', reference: 'DEP-0091', type: 'Deposit',
  description: 'Cash deposit, branch over the counter', debit: 0, credit: 50000, remarks: '',
  ...overrides,
});
const on = (store, overrides = {}) => ({ accountId: main(store), ...line(overrides) });

const open = (store, overrides = {}) => openBankAccount(store, actors.maker,
  { accountId: main(store), entryDate: '2026-09-01', balance: 100000, remarks: '', ...overrides });

// Opening 100,000; then +50,000, -3,200, -300 leaves 146,500.
function passbook(store) {
  open(store);
  createBankRecord(store, actors.maker, on(store, ));
  createBankRecord(store, actors.maker, on(store, { entryDate: '2026-09-12', reference: 'CHK-0012345', type: 'Check Payment', description: 'Check 0012345, Metro Office Depot', debit: 3200, credit: 0 }));
  return createBankRecord(store, actors.maker, on(store, { entryDate: '2026-09-15', reference: '', type: 'Bank Charge', description: 'Monthly maintaining balance charge', debit: 300, credit: 0 }));
}

test('an account is opened with its beginning balance, once', () => {
  const store = newStore();
  const opening = open(store);
  assert.equal(opening.opening, true);
  assert.equal(opening.balance, 100000);
  assert.equal(opening.entryDate, '2026-09-01');
  assert.equal(opening.debit, 0);
  assert.equal(opening.credit, 0);
  assert.equal(opening.encodedBy, 'Ana Maker');
  assert.throws(() => open(store), /already has a beginning balance/);
  assert.throws(() => openBankAccount(store, actors.viewer, { accountId: main(store), entryDate: '2026-09-01', balance: 1, remarks: '' }), /permission/);
  assert.match(getBankRecord(store, actors.admin, opening.id).history[0].action, /open-account/);
  store.close();
});

test('nothing can be encoded until the beginning balance is entered', () => {
  const store = newStore();
  assert.throws(() => createBankRecord(store, actors.maker, on(store, )), /no beginning balance yet/);
  open(store);
  assert.equal(createBankRecord(store, actors.maker, on(store, )).balance, 150000);
  assert.throws(() => createBankRecord(store, actors.maker, on(store, { entryDate: '2026-08-31' })), /before the beginning balance/);
  store.close();
});

test('a maker encodes the passbook, and every field is kept', () => {
  const store = newStore();
  open(store);
  const record = createBankRecord(store, actors.maker, on(store, ));
  assert.equal(record.entryDate, '2026-09-10');
  assert.equal(record.reference, 'DEP-0091');
  assert.equal(record.type, 'Deposit');
  assert.equal(record.description, 'Cash deposit, branch over the counter');
  assert.equal(record.credit, 50000);
  assert.equal(record.debit, 0);
  assert.equal(record.encodedBy, 'Ana Maker');
  assert.match(record.encodedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.voided, false);
  store.close();
});

test('a passbook line is a withdrawal or a deposit, never both or neither', () => {
  const store = newStore();
  open(store);
  assert.throws(() => createBankRecord(store, actors.maker, on(store, { debit: 0, credit: 0 })), /either a withdrawal or a deposit/);
  assert.throws(() => createBankRecord(store, actors.maker, on(store, { debit: 500, credit: 500 })), /not both/);
  assert.throws(() => createBankRecord(store, actors.maker, on(store, { type: 'Telepathy' })), /type/);
  assert.throws(() => createBankRecord(store, actors.maker, on(store, { description: '' })), /description/);
  assert.throws(() => createBankRecord(store, actors.maker, on(store, { credit: 1.005 })), /2 decimal places/);
  assert.throws(() => createBankRecord(store, actors.maker, { ...on(store), balance: 5 }), /balance/, 'the balance is not something anyone types');
  store.close();
});

test('the balance is worked out from the movements, in passbook order', () => {
  const store = newStore();
  const last = passbook(store);
  assert.equal(last.balance, 146500);
  const rows = listBankRecords(store, actors.admin, { accountId: main(store) }).rows;
  assert.deepEqual(rows.map(row => [row.entryDate, row.balance]), [
    ['2026-09-15', 146500],
    ['2026-09-12', 146800],
    ['2026-09-10', 150000],
    ['2026-09-01', 100000],
  ]);

  // A line encoded late still belongs where its date puts it, and everything after it moves.
  createBankRecord(store, actors.maker, on(store, { entryDate: '2026-09-11', reference: 'WD-1', type: 'Withdrawal', description: 'Cash withdrawal', debit: 1000, credit: 0 }));
  const after = listBankRecords(store, actors.admin, { accountId: main(store) }).rows;
  assert.deepEqual(after.map(row => [row.entryDate, row.balance]), [
    ['2026-09-15', 145500],
    ['2026-09-12', 145800],
    ['2026-09-11', 149000],
    ['2026-09-10', 150000],
    ['2026-09-01', 100000],
  ]);
  store.close();
});

test('correcting a line, or the beginning balance, re-works every balance after it', () => {
  const store = newStore();
  const last = passbook(store);
  const first = listBankRecords(store, actors.admin, { accountId: main(store) }).rows.at(-1);

  const deposit = listBankRecords(store, actors.admin, { text: 'Cash deposit' }).rows[0];
  updateBankRecord(store, actors.approver, deposit.id, on(store, { credit: 55000 }));
  assert.equal(getBankRecord(store, actors.admin, last.id).balance, 151500, '146,500 + the extra 5,000');

  updateBankRecord(store, actors.admin, first.id, { accountId: main(store), entryDate: '2026-09-01', balance: 90000, remarks: 'Per passbook page 4' });
  assert.equal(getBankRecord(store, actors.admin, last.id).balance, 141500, 'the whole chain drops by 10,000');

  assert.throws(() => updateBankRecord(store, actors.admin, first.id, { accountId: demoBankAccount(store, { bankName: 'Elsewhere Bank', accountNumber: '777' }).id, entryDate: '2026-09-01', balance: 90000, remarks: '' }), /cannot be moved to another/);
  assert.throws(() => updateBankRecord(store, actors.admin, first.id, { accountId: main(store), entryDate: '2026-09-20', balance: 90000, remarks: '' }), /cannot be dated after them/);
  store.close();
});

test('the maker, the releaser and the administrator can all encode and correct', () => {
  const store = newStore();
  open(store);
  for (const actor of [actors.maker, actors.approver, actors.admin]) {
    const record = createBankRecord(store, actor, on(store, { reference: `REF-${actor.id}` }));
    const corrected = updateBankRecord(store, actor, record.id, { ...on(store, { reference: `REF-${actor.id}` }), remarks: 'Checked against the passbook' });
    assert.equal(corrected.remarks, 'Checked against the passbook', actor.role);
  }
  assert.throws(() => createBankRecord(store, actors.viewer, on(store, )), /permission/);
  assert.throws(() => updateBankRecord(store, actors.viewer, 'x', on(store, )), /permission/);
  store.close();
});

test('a correction records the original entry, the change, the user and the time', () => {
  const store = newStore();
  open(store);
  const record = createBankRecord(store, actors.maker, on(store, { reference: 'DEP-0091' }));
  const corrected = updateBankRecord(store, actors.approver, record.id, on(store, { reference: 'DEP-0092', credit: 55000 }));
  assert.equal(corrected.reference, 'DEP-0092');
  assert.equal(corrected.balance, 155000, 'and the balance follows the corrected movement');
  assert.equal(corrected.updatedBy, 'Carla Approver');
  assert.match(corrected.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const history = getBankRecord(store, actors.admin, record.id).history;
  assert.deepEqual(history.map(h => h.action), ['encode', 'correct']);
  assert.equal(history[0].actor, 'Ana Maker');
  assert.equal(history[1].actor, 'Carla Approver');
  assert.match(history[1].detail, /reference: "DEP-0091" to "DEP-0092"/);
  assert.match(history[1].detail, /credit: "50000" to "55000"/);

  const audit = store.all("SELECT before_json, after_json FROM audit WHERE entity_id = ? AND action = 'correct'", record.id)[0];
  assert.equal(JSON.parse(audit.before_json).reference, 'DEP-0091', 'the entry as it was is kept in full');
  assert.equal(JSON.parse(audit.after_json).reference, 'DEP-0092', 'and the entry as it became');
  assert.throws(() => updateBankRecord(store, actors.maker, record.id, on(store, { reference: 'DEP-0092', credit: 55000 })), /Nothing was changed/);
  store.close();
});

test('a bank record is never deleted; a wrong line is voided and stays on file', () => {
  const store = newStore();
  open(store);
  const record = createBankRecord(store, actors.maker, on(store, ));
  assert.throws(() => store.run('DELETE FROM bank_records'), /never deleted/);
  assert.throws(() => voidBankRecord(store, actors.maker, record.id, { reason: 'Encoded twice' }), /permission/);
  assert.throws(() => voidBankRecord(store, actors.admin, record.id, { reason: 'oops' }), /at least five characters/);
  const voided = voidBankRecord(store, actors.admin, record.id, { reason: 'Encoded twice by mistake' });
  assert.equal(voided.voided, true);
  assert.equal(voided.voidReason, 'Encoded twice by mistake');
  const all = listBankRecords(store, actors.admin, {});
  assert.equal(all.rows.length, 2, 'it is still listed, beside the beginning balance');
  assert.deepEqual(all.totals, [], 'but drops out of the totals');
  assert.deepEqual(all.balances.map(b => [b.account, b.balance]), [[ACCOUNT, 100000]], 'and out of the running balance');
  assert.throws(() => updateBankRecord(store, actors.admin, record.id, on(store, { remarks: 'x' })), /voided/);
  assert.throws(() => voidBankRecord(store, actors.admin, record.id, { reason: 'Again, please' }), /already voided/);
  store.close();
});

test('a beginning balance with live transactions against it cannot be voided', () => {
  const store = newStore();
  passbook(store);
  const opening = listBankRecords(store, actors.admin, { accountId: main(store) }).rows.at(-1);
  assert.equal(opening.opening, true);
  assert.throws(() => voidBankRecord(store, actors.admin, opening.id, { reason: 'Wrong account entirely' }), /Void those first/);
  store.close();
});

test('the register filters, totals and reports the running balance per account', () => {
  const store = newStore();
  passbook(store);
  const second = demoBankAccount(store, { bankName: 'BPI', accountNumber: '9988' }).id;
  openBankAccount(store, actors.maker, { accountId: second, entryDate: '2026-09-05', balance: 0, remarks: '' });
  createBankRecord(store, actors.maker, { ...line({ entryDate: '2026-09-14', reference: 'DEP-1', credit: 20000, debit: 0 }), accountId: second });
  const all = listBankRecords(store, actors.admin, {});
  assert.equal(all.total, 4, 'four movements; the two beginning balances are not transactions');
  assert.deepEqual(all.totals, [{ currency: 'PHP', symbol: '₱', decimals: 2, entries: 4, debit: 3500, credit: 70000 }]);
  assert.deepEqual(all.accounts.map(a => [a.account, a.entries, a.opened]), [
    [ACCOUNT, 4, true],
    ['BPI 9988', 2, true],
  ]);
  assert.deepEqual(all.balances.map(b => [b.account, b.balance, b.asOf]), [
    [ACCOUNT, 146500, '2026-09-15'],
    ['BPI 9988', 20000, '2026-09-14'],
  ]);
  assert.equal(listBankRecords(store, actors.admin, { accountId: second }).total, 1);
  assert.equal(listBankRecords(store, actors.admin, { from: '2026-09-14' }).total, 2);
  assert.equal(listBankRecords(store, actors.admin, { to: '2026-09-10' }).total, 1);
  assert.equal(listBankRecords(store, actors.admin, { text: 'maintaining' }).total, 1);
  assert.equal(listBankRecords(store, actors.admin, { text: 'Metro' }).rows[0].reference, 'CHK-0012345');
  assert.equal(listBankRecords(store, actors.admin, {}).rows[0].entryDate, '2026-09-15', 'newest first');
  store.close();
});

test('a viewer can read the register but never touch it', () => {
  const store = newStore();
  passbook(store);
  assert.equal(listBankRecords(store, actors.viewer, {}).total, 3);
  assert.ok(bankSummary(store, actors.viewer));
  assert.throws(() => createBankRecord(store, actors.viewer, on(store, )), /permission/);
  store.close();
});

test('the dashboard summarises the passbook for every role that may see it', () => {
  const store = newStore();
  passbook(store);
  const summary = dashboard(store, actors.maker).bank;
  assert.equal(summary.entries, 3);
  assert.deepEqual(summary.totals, [{ currency: 'PHP', symbol: '₱', decimals: 2, entries: 3, debit: 3500, credit: 50000 }]);
  assert.deepEqual(summary.balances.map(b => [b.account, b.balance, b.asOf]), [[ACCOUNT, 146500, '2026-09-15']]);
  store.close();
});

test('an account whose passbook predates automatic balances is given a beginning balance', () => {
  const store = newStore();
  const accountId = main(store);
  // What the old model left behind: transcribed balances and no opening line.
  const insert = (date, debit, credit, balance) => store.run(`INSERT INTO bank_records(id, account_id, entry_date, reference, type,
    description, debit_cents, credit_cents, balance_cents, remarks, encoded_by, encoded_at)
    VALUES(hex(randomblob(16)), ?, ?, '', 'Deposit', 'Old line', ?, ?, ?, '', 'Ana Maker', '2026-09-01T00:00:00.000Z')`,
  accountId, date, debit, credit, balance);
  insert('2026-09-10', 0, 5_000_00, 150_000_00);
  insert('2026-09-12', 3_200_00, 0, 146_800_00);
  assert.throws(() => createBankRecord(store, actors.maker, on(store)), /no beginning balance yet/);

  assert.deepEqual(ensureBankOpenings(store), [{ account: ACCOUNT, opening: 145000, balance: 146800, currency: 'PHP' }]);
  assert.deepEqual(ensureBankOpenings(store), [], 'and it only happens once');

  const rows = listBankRecords(store, actors.admin, { accountId }).rows;
  assert.deepEqual(rows.map(row => [row.entryDate, row.balance]), [['2026-09-12', 146800], ['2026-09-10', 150000], ['2026-09-10', 145000]]);
  assert.equal(rows.at(-1).opening, true);
  assert.equal(rows.at(-1).derived, true, 'and it is marked as a figure nobody entered');
  assert.equal(createBankRecord(store, actors.maker, on(store, { entryDate: '2026-09-20', credit: 1000 })).balance, 147800, 'and encoding works again');
  assert.equal(store.all("SELECT * FROM audit WHERE action = 'open-account'").length, 1, 'the derivation is on the record');
  store.close();
});
