import { randomUUID } from 'node:crypto';
import { currencySchema, currencyUpdateSchema, bankSchema, bankAccountSchema } from './schema.mjs';
import { AppError, permit, found } from './errors.mjs';
import { fromMinor } from './money.mjs';
import { BANK_ADMIN_ROLES, BANK_RECORD_ROLES, BANK_OPENING_TYPE } from './defaults.mjs';

// Bank Account Management: the company's banks, the accounts held with them, and the
// currencies those accounts are kept in - all of it data an authorised user maintains.
//
// Three deliberate choices:
//
// Nothing is named in code. No bank, no currency and no account type is built in. The
// currencies table is seeded once with a starting list an administrator can edit or empty,
// and a currency code is validated by shape rather than against a fixed list, so an account
// can be recorded in a currency this system has never heard of.
//
// An account in use is retired, not deleted. Deactivating keeps every record readable and
// every balance correct while stopping new entries; removing is only allowed while an
// account is still empty, and even then the row it removes is written to the audit trail
// first so the trail outlives the record.
//
// A bank account is the unit a balance belongs to. Renaming the bank or correcting the
// account number changes how it reads everywhere at once, because the passbook holds the
// account's identity and not a copy of its name.

export { BANK_ADMIN_ROLES };

const READ_ROLES = [...BANK_RECORD_ROLES, 'viewer'];

const CURRENCY_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM bank_accounts WHERE currency = c.code) AS accounts FROM currencies c`;
const BANK_SELECT = `SELECT b.*, (SELECT COUNT(*) FROM bank_accounts WHERE bank_id = b.id) AS accounts FROM banks b`;

const shapeCurrency = row => ({
  code: row.code, name: row.name, symbol: row.symbol, decimals: row.decimals, active: !!row.active,
  accounts: row.accounts ?? 0,
});

const shapeBank = row => ({
  id: row.id, name: row.name, shortName: row.short_name, country: row.country, active: !!row.active,
  accounts: row.accounts ?? 0,
  createdBy: row.created_by, createdAt: row.created_at, updatedBy: row.updated_by || '', updatedAt: row.updated_at || '',
});

// The label a bank account reads as: the bank, then the number if it has one, else its name.
export const accountLabel = row =>
  [row.bank_name || row.bankName, row.account_number || row.accountNumber || row.account_name || row.accountName]
    .filter(Boolean).join(' ');

export const shapeAccount = row => ({
  id: row.id,
  bankId: row.bank_id,
  bankName: row.bank_name,
  accountName: row.account_name,
  accountNumber: row.account_number,
  accountType: row.account_type,
  description: row.description,
  currency: row.currency,
  currencySymbol: row.currency_symbol ?? '',
  currencyDecimals: row.currency_decimals ?? 2,
  currencyName: row.currency_name ?? row.currency,
  active: !!row.active && !!row.bank_active,
  bankActive: !!row.bank_active,
  display: accountLabel(row),
  entries: row.entries ?? 0,
  opened: !!row.opened,
  balance: row.balance_cents === null || row.balance_cents === undefined ? null : fromMinor(row.balance_cents, row.currency_decimals ?? 2),
  createdBy: row.created_by, createdAt: row.created_at, updatedBy: row.updated_by || '', updatedAt: row.updated_at || '',
});

// ---------------------------------------------------------------- currencies

export function listCurrencies(store, actor, { includeInactive = true } = {}) {
  permit(actor, READ_ROLES);
  return store.all(`${CURRENCY_SELECT} ${includeInactive ? '' : 'WHERE c.active = 1'} ORDER BY c.code`).map(shapeCurrency);
}

export function createCurrency(store, actor, input) {
  permit(actor, BANK_ADMIN_ROLES);
  const value = currencySchema.parse(input);
  return store.transaction(() => {
    if (store.get('SELECT code FROM currencies WHERE code = ?', value.code)) throw new AppError(`${value.code} is already on the currency list.`, 409);
    store.run('INSERT INTO currencies(code, name, symbol, decimals, active, created_at) VALUES(?, ?, ?, ?, ?, ?)',
      value.code, value.name, value.symbol, value.decimals, value.active ? 1 : 0, new Date().toISOString());
    const after = shapeCurrency(store.get(`${CURRENCY_SELECT} WHERE c.code = ?`, value.code));
    store.log(actor, 'create', 'currency', value.code, { detail: `Currency ${value.code} (${value.name}) added with ${value.decimals} decimal place${value.decimals === 1 ? '' : 's'}`, after });
    return after;
  });
}

export function updateCurrency(store, actor, code, input) {
  permit(actor, BANK_ADMIN_ROLES);
  const value = currencyUpdateSchema.parse(input);
  return store.transaction(() => {
    const before = shapeCurrency(found(store.get(`${CURRENCY_SELECT} WHERE c.code = ?`, code), 'Currency'));
    // Changing the precision of a currency that already holds balances would silently
    // rescale every figure recorded in it, so it is refused while it is in use.
    if (value.decimals !== before.decimals && before.accounts) {
      throw new AppError(`${code} is in use by ${before.accounts} account${before.accounts === 1 ? '' : 's'}, so its decimal places cannot be changed. Add a separate currency instead.`, 409);
    }
    store.run('UPDATE currencies SET name = ?, symbol = ?, decimals = ?, active = ? WHERE code = ?',
      value.name, value.symbol, value.decimals, value.active ? 1 : 0, code);
    const after = shapeCurrency(store.get(`${CURRENCY_SELECT} WHERE c.code = ?`, code));
    store.log(actor, 'update', 'currency', code, { detail: describe(before, after), before, after });
    return after;
  });
}

export function removeCurrency(store, actor, code) {
  permit(actor, BANK_ADMIN_ROLES);
  return store.transaction(() => {
    const before = shapeCurrency(found(store.get(`${CURRENCY_SELECT} WHERE c.code = ?`, code), 'Currency'));
    if (before.accounts) throw new AppError(`${code} is used by ${before.accounts} bank account${before.accounts === 1 ? '' : 's'}. Deactivate it instead, which keeps those accounts readable but offers it to nothing new.`, 409);
    store.run('DELETE FROM currencies WHERE code = ?', code);
    store.log(actor, 'remove', 'currency', code, { detail: `Currency ${code} (${before.name}) removed from the list`, before });
    return { removed: code };
  });
}

// ---------------------------------------------------------------- banks

export function listBanks(store, actor, { includeInactive = true } = {}) {
  permit(actor, READ_ROLES);
  return store.all(`${BANK_SELECT} ${includeInactive ? '' : 'WHERE b.active = 1'} ORDER BY b.name COLLATE NOCASE`).map(shapeBank);
}

export function createBank(store, actor, input) {
  permit(actor, BANK_ADMIN_ROLES);
  const value = bankSchema.parse(input);
  return store.transaction(() => {
    if (store.get('SELECT id FROM banks WHERE name = ? COLLATE NOCASE', value.name)) throw new AppError(`${value.name} is already on the list of banks.`, 409);
    const id = randomUUID(), at = new Date().toISOString();
    store.run('INSERT INTO banks(id, name, short_name, country, active, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      id, value.name, value.shortName, value.country, value.active ? 1 : 0, actor.fullName, at);
    const after = shapeBank(store.get(`${BANK_SELECT} WHERE b.id = ?`, id));
    store.log(actor, 'create', 'bank', id, { detail: `Bank ${value.name} added`, after });
    return after;
  });
}

export function updateBank(store, actor, id, input) {
  permit(actor, BANK_ADMIN_ROLES);
  const value = bankSchema.parse(input);
  return store.transaction(() => {
    const before = shapeBank(found(store.get(`${BANK_SELECT} WHERE b.id = ?`, id), 'Bank'));
    const clash = store.get('SELECT id FROM banks WHERE name = ? COLLATE NOCASE AND id <> ?', value.name, id);
    if (clash) throw new AppError(`Another bank is already called ${value.name}.`, 409);
    store.run('UPDATE banks SET name = ?, short_name = ?, country = ?, active = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      value.name, value.shortName, value.country, value.active ? 1 : 0, actor.fullName, new Date().toISOString(), id);
    const after = shapeBank(store.get(`${BANK_SELECT} WHERE b.id = ?`, id));
    store.log(actor, 'update', 'bank', id, { detail: describe(before, after), before, after });
    return after;
  });
}

export function removeBank(store, actor, id) {
  permit(actor, BANK_ADMIN_ROLES);
  return store.transaction(() => {
    const before = shapeBank(found(store.get(`${BANK_SELECT} WHERE b.id = ?`, id), 'Bank'));
    if (before.accounts) throw new AppError(`${before.name} still holds ${before.accounts} account${before.accounts === 1 ? '' : 's'}. Remove or move those first, or deactivate the bank instead.`, 409);
    store.run('DELETE FROM banks WHERE id = ?', id);
    store.log(actor, 'remove', 'bank', id, { detail: `Bank ${before.name} removed`, before });
    return { removed: id };
  });
}

// ---------------------------------------------------------------- bank accounts

const ACCOUNT_SELECT = `SELECT a.*, b.name AS bank_name, b.active AS bank_active,
    c.symbol AS currency_symbol, c.decimals AS currency_decimals, c.name AS currency_name,
    (SELECT COUNT(*) FROM bank_records WHERE account_id = a.id AND voided = 0) AS entries,
    (SELECT COUNT(*) FROM bank_records WHERE account_id = a.id AND type = '${BANK_OPENING_TYPE}') AS opened,
    (SELECT r.balance_cents FROM bank_records r WHERE r.account_id = a.id AND r.voided = 0
      ORDER BY r.entry_date DESC, CASE WHEN r.type = '${BANK_OPENING_TYPE}' THEN 0 ELSE 1 END DESC, r.seq DESC LIMIT 1) AS balance_cents
  FROM bank_accounts a JOIN banks b ON b.id = a.bank_id LEFT JOIN currencies c ON c.code = a.currency`;

export function listBankAccounts(store, actor, { includeInactive = true } = {}) {
  permit(actor, READ_ROLES);
  const where = includeInactive ? '' : 'WHERE a.active = 1 AND b.active = 1';
  return store.all(`${ACCOUNT_SELECT} ${where} ORDER BY b.name COLLATE NOCASE, a.account_name COLLATE NOCASE`).map(shapeAccount);
}

// Used by the passbook: the account a record is being written against, with the currency
// precision its amounts must obey.
export function accountFor(store, id, { mustBeUsable = false } = {}) {
  const row = found(store.get(`${ACCOUNT_SELECT} WHERE a.id = ?`, id), 'Bank account');
  const account = shapeAccount(row);
  if (mustBeUsable && !account.active) {
    throw new AppError(`${account.display} is not in use${account.bankActive ? '' : ' because its bank is not in use'}. Reactivate it in Bank Accounts to encode against it.`, 409);
  }
  return account;
}

export function getBankAccount(store, actor, id) {
  permit(actor, READ_ROLES);
  return { ...accountFor(store, id), history: store.history('bank-account', id) };
}

export function createBankAccount(store, actor, input) {
  permit(actor, BANK_ADMIN_ROLES);
  const value = bankAccountSchema.parse(input);
  return store.transaction(() => {
    found(store.get('SELECT id FROM banks WHERE id = ?', value.bankId), 'Bank');
    requireCurrency(store, value.currency);
    if (value.accountNumber && store.get('SELECT id FROM bank_accounts WHERE bank_id = ? AND account_number = ?', value.bankId, value.accountNumber)) {
      throw new AppError('That account number is already recorded for this bank.', 409);
    }
    const id = randomUUID(), at = new Date().toISOString();
    store.run(`INSERT INTO bank_accounts(id, bank_id, account_name, account_number, currency, account_type, description, active, created_by, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, value.bankId, value.accountName, value.accountNumber, value.currency,
    value.accountType, value.description, value.active ? 1 : 0, actor.fullName, at);
    const after = accountFor(store, id);
    store.log(actor, 'create', 'bank-account', id, { detail: `${after.display} added - ${after.accountName}, ${after.currency}${after.accountType ? `, ${after.accountType}` : ''}`, after });
    return after;
  });
}

export function updateBankAccount(store, actor, id, input) {
  permit(actor, BANK_ADMIN_ROLES);
  const value = bankAccountSchema.parse(input);
  return store.transaction(() => {
    const before = accountFor(store, id);
    found(store.get('SELECT id FROM banks WHERE id = ?', value.bankId), 'Bank');
    requireCurrency(store, value.currency);
    if (value.accountNumber && store.get('SELECT id FROM bank_accounts WHERE bank_id = ? AND account_number = ? AND id <> ?', value.bankId, value.accountNumber, id)) {
      throw new AppError('That account number is already recorded for this bank.', 409);
    }
    // The currency decides what the stored minor units mean, so changing it under existing
    // records would reinterpret every figure on the account.
    if (value.currency !== before.currency && before.entries) {
      throw new AppError(`${before.display} already holds ${before.entries} entr${before.entries === 1 ? 'y' : 'ies'} in ${before.currency}. Its currency can no longer be changed - add a separate account for ${value.currency}.`, 409);
    }
    store.run(`UPDATE bank_accounts SET bank_id = ?, account_name = ?, account_number = ?, currency = ?,
      account_type = ?, description = ?, active = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    value.bankId, value.accountName, value.accountNumber, value.currency, value.accountType, value.description,
    value.active ? 1 : 0, actor.fullName, new Date().toISOString(), id);
    const after = accountFor(store, id);
    const changed = describe(before, after);
    if (!changed) throw new AppError('Nothing was changed.');
    store.log(actor, 'update', 'bank-account', id, { detail: changed, before, after });
    return after;
  });
}

export function removeBankAccount(store, actor, id) {
  permit(actor, BANK_ADMIN_ROLES);
  return store.transaction(() => {
    const before = accountFor(store, id);
    const held = store.get('SELECT COUNT(*) AS n FROM bank_records WHERE account_id = ?', id).n;
    if (held) {
      throw new AppError(`${before.display} holds ${held} passbook entr${held === 1 ? 'y' : 'ies'} and cannot be removed - those records are permanent. Deactivate it instead: the history stays readable and nothing new can be encoded against it.`, 409);
    }
    store.run('DELETE FROM bank_accounts WHERE id = ?', id);
    // The row goes; the trail of it does not.
    store.log(actor, 'remove', 'bank-account', id, { detail: `${before.display} removed while still empty - ${before.accountName}, ${before.currency}`, before });
    return { removed: id };
  });
}

function requireCurrency(store, code) {
  const currency = store.get('SELECT code, active FROM currencies WHERE code = ?', code);
  if (!currency) throw new AppError(`${code} is not on the currency list. Add it under Currencies first.`);
  if (!currency.active) throw new AppError(`${code} is not in use. Reactivate it under Currencies to record an account in it.`);
}

// A readable summary of what an edit moved, for the audit trail.
function describe(before, after) {
  const skip = new Set(['updatedBy', 'updatedAt', 'entries', 'balance', 'opened', 'history', 'display', 'accounts', 'createdBy', 'createdAt']);
  const changed = Object.keys(after).filter(key => !skip.has(key) && String(before[key]) !== String(after[key]));
  if (!changed.length) return '';
  return `Changed ${changed.join(', ')} - ${changed.map(key => `${key}: "${before[key]}" to "${after[key]}"`).join('; ')}`.slice(0, 1800);
}
