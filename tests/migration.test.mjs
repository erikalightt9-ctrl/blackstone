import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { listBankAccounts, listBanks } from '../src/accounts.mjs';
import { listBankRecords } from '../src/bank.mjs';
import { actors } from './helpers.mjs';

// A database from before bank accounts were managed: the account is free text on each record,
// there is no bank_accounts table, and no currency anywhere.
function legacyDatabase(file, labels) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE bank_records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, account TEXT NOT NULL DEFAULT '',
    entry_date TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, description TEXT NOT NULL,
    debit_cents INTEGER NOT NULL DEFAULT 0, credit_cents INTEGER NOT NULL DEFAULT 0, balance_cents INTEGER NOT NULL,
    remarks TEXT NOT NULL DEFAULT '', voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT NOT NULL DEFAULT '',
    encoded_by TEXT NOT NULL, encoded_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT);
    CREATE INDEX bank_account_date ON bank_records(account, entry_date);`);
  const insert = db.prepare(`INSERT INTO bank_records(id, account, entry_date, reference, type, description,
    debit_cents, credit_cents, balance_cents, remarks, encoded_by, encoded_at)
    VALUES(hex(randomblob(16)), ?, ?, '', 'Deposit', 'Old line', 0, ?, ?, '', 'Ana Maker', '2026-09-01T00:00:00.000Z')`);
  for (const [label, date, credit, balance] of labels) insert.run(label, date, credit, balance);
  db.close();
}

const workspace = () => mkdtempSync(path.join(tmpdir(), 'fr-migrate-'));

test('a free-text account label becomes a real bank and bank account', () => {
  const directory = workspace();
  const file = path.join(directory, 'finance.sqlite');
  try {
    legacyDatabase(file, [
      ['BDO 0123-4567-89', '2026-09-02', 250_000_00, 412_500_00],
      ['BDO 0123-4567-89', '2026-09-10', 0, 409_300_00],
      ['BPI 9988', '2026-09-14', 20_000_00, 20_000_00],
      ['Petty Cash Drawer', '2026-09-15', 1_000_00, 1_000_00],
    ]);

    const store = new Store(file);
    const banks = listBanks(store, actors.admin);
    // "BDO 0123-4567-89" reads as a bank and its number; a label that does not split that way
    // is kept whole for an administrator to correct.
    assert.deepEqual(banks.map(bank => [bank.name, bank.accounts]), [
      ['BDO', 1], ['BPI', 1], ['Petty Cash Drawer', 1],
    ]);

    const accounts = listBankAccounts(store, actors.admin);
    assert.deepEqual(accounts.map(account => [account.bankName, account.accountNumber, account.accountName, account.currency]), [
      ['BDO', '0123-4567-89', 'BDO 0123-4567-89', 'PHP'],
      ['BPI', '9988', 'BPI 9988', 'PHP'],
      ['Petty Cash Drawer', '', 'Petty Cash Drawer', 'PHP'],
    ], 'the original label is kept as the account name, so nothing is lost');

    // Every record is repointed, and the old column is gone rather than left to drift.
    const columns = store.all('PRAGMA table_info(bank_records)').map(column => column.name);
    assert.equal(columns.includes('account'), false);
    assert.equal(columns.includes('account_id'), true);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM bank_records WHERE account_id IS NULL').n, 0);
    assert.equal(listBankRecords(store, actors.admin, {}).rows.length, 4);
    store.close();

    // Opening it again must not migrate anything a second time.
    const again = new Store(file);
    assert.equal(listBanks(again, actors.admin).length, 3, 'no duplicate banks on a second start');
    assert.equal(listBankAccounts(again, actors.admin).length, 3);
    assert.deepEqual(again.migrateBankAccounts(new Date().toISOString()), [], 'and the migration itself is a no-op');
    again.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a new database is created already migrated, and is not rewritten on every start', () => {
  const directory = workspace();
  const file = path.join(directory, 'finance.sqlite');
  try {
    const store = new Store(file);
    const columns = store.all('PRAGMA table_info(bank_records)').map(column => column.name);
    assert.equal(columns.includes('account'), false, 'a new database never has the old column');
    assert.equal(columns.includes('account_id'), true);
    assert.deepEqual(store.migrateBankAccounts(new Date().toISOString()), [], 'and there is nothing to carry over');
    assert.equal(store.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'bank_account_date'").n, 1);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an emptied currency list does not block the carry-over', () => {
  const directory = workspace();
  const file = path.join(directory, 'finance.sqlite');
  try {
    legacyDatabase(file, [['BDO 0123', '2026-09-02', 100, 100]]);
    // A currency table that exists but offers nothing usable, so the seed does not run and
    // nothing is active. The carry-over has to put the base currency back rather than fail.
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE currencies (code TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT '',
      decimals INTEGER NOT NULL DEFAULT 2, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      INSERT INTO currencies(code, name, active, created_at) VALUES('XTS', 'Retired', 0, '2026-09-01');`);
    db.close();

    const store = new Store(file);
    assert.deepEqual(listBankAccounts(store, actors.admin).map(a => [a.accountName, a.currency]), [['BDO 0123', 'PHP']]);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the migration rolls back whole if it cannot finish', () => {
  const directory = workspace();
  const file = path.join(directory, 'finance.sqlite');
  try {
    legacyDatabase(file, [['BDO 0123', '2026-09-02', 100, 100], ['BPI 9988', '2026-09-03', 200, 200]]);
    // A banks table of the wrong shape, which CREATE TABLE IF NOT EXISTS will leave alone, so
    // the carry-over fails on its first insert - partway through, with records still to move.
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE banks (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    db.close();

    assert.throws(() => new Store(file), /short_name|no column/i, 'the carry-over fails rather than half-finishing');

    // SQLite rolls back DDL along with everything else, so a half-migrated database is not a
    // state this can end up in: the old column is still there and not one record was moved.
    const after = new DatabaseSync(file);
    const columns = after.prepare('PRAGMA table_info(bank_records)').all().map(column => column.name);
    assert.equal(columns.includes('account'), true, 'the old column is untouched');
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM bank_records WHERE account_id IS NOT NULL').get().n, 0, 'and nothing was repointed');
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM banks').get().n, 0, 'and no half-made bank was left behind');
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM bank_records').get().n, 2, 'while every record is still there');
    after.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
