import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, demoBankAccount } from './helpers.mjs';
import {
  listCurrencies, createCurrency, updateCurrency, removeCurrency,
  listBanks, createBank, updateBank, removeBank,
  listBankAccounts, getBankAccount, createBankAccount, updateBankAccount, removeBankAccount,
} from '../src/accounts.mjs';
import { openBankAccount, createBankRecord, listBankRecords } from '../src/bank.mjs';

const bankOf = (store, name = 'Some Bank') => createBank(store, actors.admin, { name });
const accountOn = (store, bank, overrides = {}) => createBankAccount(store, actors.admin, {
  bankId: bank.id, accountName: 'Operating', accountNumber: '111', currency: 'PHP', ...overrides,
});

test('nothing names a bank or a currency in code: both are added by hand', () => {
  const store = newStore();
  // The starting currency list is a convenience, not a constraint - a currency the system
  // has never heard of can be added and used.
  const added = createCurrency(store, actors.admin, { code: 'aed', name: 'UAE Dirham', symbol: 'AED', decimals: 2 });
  assert.equal(added.code, 'AED', 'the code is normalised');
  const bank = createBank(store, actors.admin, { name: 'Emirates NBD', shortName: 'ENBD', country: 'United Arab Emirates' });
  const account = accountOn(store, bank, { currency: 'AED', accountName: 'Dirham Account', accountNumber: '55-99' });
  assert.equal(account.currency, 'AED');
  assert.equal(account.display, 'Emirates NBD 55-99');
  assert.equal(account.bankName, 'Emirates NBD');
  store.close();
});

test('one bank carries many accounts, each with its own currency and type', () => {
  const store = newStore();
  const bank = bankOf(store, 'BDO Unibank');
  const peso = accountOn(store, bank, { accountName: 'Peso Operating', accountNumber: '0123', currency: 'PHP', accountType: 'Current / Checking' });
  const dollar = accountOn(store, bank, { accountName: 'Dollar Savings', accountNumber: '0456', currency: 'USD', accountType: 'Savings' });
  const yen = accountOn(store, bank, { accountName: 'Yen Account', accountNumber: '0789', currency: 'JPY' });

  const accounts = listBankAccounts(store, actors.maker);
  assert.equal(accounts.length, 3);
  assert.deepEqual(accounts.map(a => a.currency).sort(), ['JPY', 'PHP', 'USD']);
  assert.equal(listBanks(store, actors.admin).find(b => b.id === bank.id).accounts, 3);
  assert.equal(peso.currencyDecimals, 2);
  assert.equal(yen.currencyDecimals, 0, 'the yen has no minor unit, and that is data on the currency');
  assert.equal(dollar.currencySymbol, '$');
  store.close();
});

test('an account number cannot repeat within a bank, but may across banks', () => {
  const store = newStore();
  const first = bankOf(store, 'Bank One');
  const second = bankOf(store, 'Bank Two');
  accountOn(store, first, { accountNumber: '0123' });
  assert.throws(() => accountOn(store, first, { accountNumber: '0123', accountName: 'Another' }), /already recorded for this bank/);
  accountOn(store, second, { accountNumber: '0123' });
  // A blank number is not a clash: not every account is known by one.
  accountOn(store, first, { accountNumber: '', accountName: 'Unnumbered A' });
  accountOn(store, first, { accountNumber: '', accountName: 'Unnumbered B' });
  assert.equal(listBankAccounts(store, actors.admin).length, 4);
  store.close();
});

test('renaming a bank renames it on every account and every passbook entry at once', () => {
  const store = newStore();
  const bank = bankOf(store, 'Banco de Oro');
  const account = accountOn(store, bank, { accountNumber: '0123' });
  openBankAccount(store, actors.maker, { accountId: account.id, entryDate: '2026-09-01', balance: 1000, remarks: '' });

  updateBank(store, actors.admin, bank.id, { name: 'BDO Unibank', shortName: 'BDO', country: 'Philippines', active: true });
  assert.equal(listBankAccounts(store, actors.admin)[0].display, 'BDO Unibank 0123');
  assert.equal(listBankRecords(store, actors.admin, {}).rows[0].account, 'BDO Unibank 0123', 'the passbook holds the account, not a copy of its name');
  store.close();
});

test('an account in use is deactivated, never deleted; an empty one may be removed', () => {
  const store = newStore();
  const bank = bankOf(store);
  const used = accountOn(store, bank, { accountNumber: '0123' });
  const empty = accountOn(store, bank, { accountNumber: '0456', accountName: 'Never used' });
  openBankAccount(store, actors.maker, { accountId: used.id, entryDate: '2026-09-01', balance: 1000, remarks: '' });

  assert.throws(() => removeBankAccount(store, actors.admin, used.id), /cannot be removed/);
  assert.throws(() => removeBank(store, actors.admin, bank.id), /still holds 2 accounts/);

  // Deactivating stops new entries and leaves the history intact.
  updateBankAccount(store, actors.admin, used.id, {
    bankId: bank.id, accountName: used.accountName, accountNumber: used.accountNumber,
    currency: used.currency, accountType: used.accountType, description: used.description, active: false,
  });
  assert.throws(() => createBankRecord(store, actors.maker, {
    accountId: used.id, entryDate: '2026-09-10', reference: '', type: 'Deposit', description: 'x', debit: 0, credit: 5, remarks: '',
  }), /not in use/);
  assert.equal(listBankRecords(store, actors.admin, {}).rows.length, 1, 'but its records are still readable');

  assert.deepEqual(removeBankAccount(store, actors.admin, empty.id), { removed: empty.id });
  assert.equal(store.all("SELECT * FROM audit WHERE action = 'remove' AND entity_kind = 'bank-account'").length, 1, 'and the removal itself stays on file');
  store.close();
});

test('an account whose bank is out of use cannot be encoded against', () => {
  const store = newStore();
  const bank = bankOf(store);
  const account = accountOn(store, bank);
  updateBank(store, actors.admin, bank.id, { name: bank.name, shortName: '', country: '', active: false });
  assert.throws(() => openBankAccount(store, actors.maker, { accountId: account.id, entryDate: '2026-09-01', balance: 1, remarks: '' }), /because its bank is not in use/);
  store.close();
});

test('a currency cannot be reinterpreted under records already kept in it', () => {
  const store = newStore();
  const bank = bankOf(store);
  const account = accountOn(store, bank, { currency: 'PHP' });
  openBankAccount(store, actors.maker, { accountId: account.id, entryDate: '2026-09-01', balance: 1000, remarks: '' });

  // Changing the currency of an account holding entries would reinterpret every figure.
  assert.throws(() => updateBankAccount(store, actors.admin, account.id, {
    bankId: bank.id, accountName: 'Operating', accountNumber: '111', currency: 'USD', accountType: '', description: '', active: true,
  }), /currency can no longer be changed/);

  // And so would changing how many decimal places the currency itself has.
  assert.throws(() => updateCurrency(store, actors.admin, 'PHP', { name: 'Philippine Peso', symbol: '₱', decimals: 3, active: true }), /decimal places cannot be changed/);
  assert.throws(() => removeCurrency(store, actors.admin, 'PHP'), /used by 1 bank account/);

  // An unused currency is free to change and to remove.
  assert.equal(updateCurrency(store, actors.admin, 'JPY', { name: 'Japanese Yen', symbol: '¥', decimals: 2, active: true }).decimals, 2);
  assert.deepEqual(removeCurrency(store, actors.admin, 'JPY'), { removed: 'JPY' });
  assert.equal(listCurrencies(store, actors.admin).some(c => c.code === 'JPY'), false);
  store.close();
});

test('an account cannot be recorded in a currency that is absent or out of use', () => {
  const store = newStore();
  const bank = bankOf(store);
  assert.throws(() => accountOn(store, bank, { currency: 'ZZZ' }), /not on the currency list/);
  updateCurrency(store, actors.admin, 'USD', { name: 'US Dollar', symbol: '$', decimals: 2, active: false });
  assert.throws(() => accountOn(store, bank, { currency: 'USD' }), /not in use/);
  store.close();
});

test('a duplicate bank name is refused, on creation and on rename', () => {
  const store = newStore();
  bankOf(store, 'BDO Unibank');
  const other = bankOf(store, 'BPI');
  assert.throws(() => bankOf(store, 'bdo unibank'), /already on the list of banks/);
  assert.throws(() => updateBank(store, actors.admin, other.id, { name: 'BDO UNIBANK', shortName: '', country: '', active: true }), /Another bank is already called/);
  assert.throws(() => createCurrency(store, actors.admin, { code: 'PHP', name: 'Peso again', symbol: '₱', decimals: 2 }), /already on the currency list/);
  store.close();
});

test('makers and viewers read the accounts but never change them', () => {
  const store = newStore();
  const account = demoBankAccount(store);
  for (const actor of [actors.maker, actors.viewer]) {
    assert.equal(listBankAccounts(store, actor).length, 1, actor.role);
    assert.equal(listBanks(store, actor).length, 1, actor.role);
    assert.equal(listCurrencies(store, actor).length > 0, true, actor.role);
    assert.throws(() => createBank(store, actor, { name: 'Nope' }), /permission/);
    assert.throws(() => createBankAccount(store, actor, { bankId: 'x', accountName: 'Nope', currency: 'PHP' }), /permission/);
    assert.throws(() => updateBankAccount(store, actor, account.id, { bankId: 'x', accountName: 'Nope', currency: 'PHP' }), /permission/);
    assert.throws(() => removeBankAccount(store, actor, account.id), /permission/);
    assert.throws(() => createCurrency(store, actor, { code: 'XXX', name: 'No' }), /permission/);
    assert.throws(() => removeCurrency(store, actor, 'USD'), /permission/);
  }
  // The releaser maintains them alongside the administrator.
  assert.ok(createBank(store, actors.approver, { name: 'Releaser Added Bank' }));
  store.close();
});

test('every change to an account is on file with who made it and when', () => {
  const store = newStore();
  const bank = bankOf(store, 'BDO Unibank');
  const account = accountOn(store, bank, { accountNumber: '0123' });
  updateBankAccount(store, actors.approver, account.id, {
    bankId: bank.id, accountName: 'Peso Operating', accountNumber: '0123-4567-89',
    currency: 'PHP', accountType: 'Current / Checking', description: 'Main account', active: true,
  });
  const detail = getBankAccount(store, actors.admin, account.id);
  assert.deepEqual(detail.history.map(entry => entry.action), ['create', 'update']);
  assert.equal(detail.history[0].actor, 'System Administrator');
  assert.equal(detail.history[1].actor, 'Carla Approver');
  assert.match(detail.history[1].detail, /accountNumber: "0123" to "0123-4567-89"/);
  assert.match(detail.history[1].detail, /accountName: "Operating" to "Peso Operating"/);
  assert.equal(detail.accountNumber, '0123-4567-89');
  assert.throws(() => updateBankAccount(store, actors.admin, account.id, {
    bankId: bank.id, accountName: 'Peso Operating', accountNumber: '0123-4567-89',
    currency: 'PHP', accountType: 'Current / Checking', description: 'Main account', active: true,
  }), /Nothing was changed/);
  store.close();
});

test('the passbook keeps its totals and balances apart by currency', () => {
  const store = newStore();
  const bank = bankOf(store, 'BDO Unibank');
  const peso = accountOn(store, bank, { accountName: 'Peso', accountNumber: '0123', currency: 'PHP' });
  const dollar = accountOn(store, bank, { accountName: 'Dollar', accountNumber: '0456', currency: 'USD' });
  for (const [account, balance] of [[peso, 100000], [dollar, 5000]]) {
    openBankAccount(store, actors.maker, { accountId: account.id, entryDate: '2026-09-01', balance, remarks: '' });
  }
  createBankRecord(store, actors.maker, { accountId: peso.id, entryDate: '2026-09-10', reference: '', type: 'Deposit', description: 'Peso deposit', debit: 0, credit: 25000, remarks: '' });
  createBankRecord(store, actors.maker, { accountId: dollar.id, entryDate: '2026-09-10', reference: '', type: 'Withdrawal', description: 'Dollar withdrawal', debit: 1200, credit: 0, remarks: '' });

  const list = listBankRecords(store, actors.admin, {});
  assert.deepEqual(list.totals, [
    { currency: 'PHP', symbol: '₱', decimals: 2, entries: 1, debit: 0, credit: 25000 },
    { currency: 'USD', symbol: '$', decimals: 2, entries: 1, debit: 1200, credit: 0 },
  ], 'a peso and a dollar are never added together');
  // Listed by bank, then by account name: "Dollar" before "Peso".
  assert.deepEqual(list.balances.map(b => [b.account, b.currency, b.balance]), [
    ['BDO Unibank 0456', 'USD', 3800],
    ['BDO Unibank 0123', 'PHP', 125000],
  ]);
  store.close();
});

test('an amount must fit the decimal places of its own currency', () => {
  const store = newStore();
  const bank = bankOf(store);
  const yen = accountOn(store, bank, { accountName: 'Yen', accountNumber: '999', currency: 'JPY' });
  assert.throws(() => openBankAccount(store, actors.maker, { accountId: yen.id, entryDate: '2026-09-01', balance: 1000.5, remarks: '' }), /no decimal places/);
  openBankAccount(store, actors.maker, { accountId: yen.id, entryDate: '2026-09-01', balance: 1000, remarks: '' });
  assert.throws(() => createBankRecord(store, actors.maker, {
    accountId: yen.id, entryDate: '2026-09-02', reference: '', type: 'Deposit', description: 'x', debit: 0, credit: 10.25, remarks: '',
  }), /JPY has no decimal places/);
  assert.equal(createBankRecord(store, actors.maker, {
    accountId: yen.id, entryDate: '2026-09-02', reference: '', type: 'Deposit', description: 'x', debit: 0, credit: 10, remarks: '',
  }).balance, 1010);
  store.close();
});
