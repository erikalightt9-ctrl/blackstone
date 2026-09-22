import { randomUUID } from 'node:crypto';
import { bankRecordSchema, bankOpeningSchema, bankVoidSchema } from './schema.mjs';
import { AppError, permit, found } from './errors.mjs';
import { toMinor, fromMinor } from './money.mjs';
import { accountFor, accountLabel } from './accounts.mjs';
import { BANK_RECORD_ROLES, BANK_OPENING_TYPE } from './defaults.mjs';

// Bank Records: the official passbook, encoded by hand, one running balance per bank account.
//
// An account is opened by someone entering its beginning balance. That figure is typed by a
// person and it is the only balance anyone ever types: from then on the running balance is
// the system's arithmetic - previous balance, plus the deposit, less the withdrawal - so the
// column can never disagree with the movements. Until the beginning balance exists, nothing
// can be encoded against the account at all.
//
// Entries stay correctable, unlike a financial request, because a passbook entry is a
// transcription and a typo should be fixable. What makes that safe is the trail: every change
// keeps the entry exactly as it was and exactly as it became, with who changed it and when,
// and nothing is ever deleted.
//
// Amounts are held in the minor units of the account's own currency, so an account in a
// currency with no decimal place is stored and validated as such rather than as pesos.
export { BANK_RECORD_ROLES };

const RECORD_SELECT = `SELECT r.*, a.account_name, a.account_number, a.currency, a.account_type,
    b.name AS bank_name, c.symbol AS currency_symbol, c.decimals AS currency_decimals
  FROM bank_records r
    JOIN bank_accounts a ON a.id = r.account_id
    JOIN banks b ON b.id = a.bank_id
    LEFT JOIN currencies c ON c.code = a.currency`;

const shape = row => {
  const decimals = row.currency_decimals ?? 2;
  const opening = row.type === BANK_OPENING_TYPE;
  return {
    id: row.id, seq: row.seq, accountId: row.account_id,
    account: accountLabel(row),
    bankName: row.bank_name, accountName: row.account_name, accountNumber: row.account_number,
    currency: row.currency, currencySymbol: row.currency_symbol ?? '', currencyDecimals: decimals,
    entryDate: row.entry_date, reference: row.reference, type: row.type, description: row.description,
    debit: fromMinor(row.debit_cents, decimals), credit: fromMinor(row.credit_cents, decimals),
    balance: fromMinor(row.balance_cents, decimals),
    remarks: row.remarks, voided: !!row.voided, voidReason: row.void_reason,
    opening,
    // An opening the system worked out for itself during the move to automatic balances,
    // rather than one a person entered. It is shown as such until someone confirms it.
    derived: opening && row.encoded_by === 'System',
    encodedBy: row.encoded_by, encodedAt: row.encoded_at,
    updatedBy: row.updated_by || '', updatedAt: row.updated_at || '',
  };
};

const openingRow = (store, accountId) => store.get('SELECT * FROM bank_records WHERE account_id = ? AND type = ? LIMIT 1', accountId, BANK_OPENING_TYPE);

// Passbook order: by date, and on a shared date the beginning balance comes before the day's
// movements, since it is the figure they start from.
const ORDER = 'entry_date, CASE WHEN type = ? THEN 0 ELSE 1 END, seq';

// Walks an account's live entries in passbook order and writes each running balance. Called
// after anything that could move a figure, so the column always follows from the movements.
function rebalance(store, accountId) {
  const rows = store.all(`SELECT * FROM bank_records WHERE account_id = ? AND voided = 0 ORDER BY ${ORDER}`, accountId, BANK_OPENING_TYPE);
  let balance = 0;
  const update = store.db.prepare('UPDATE bank_records SET balance_cents = ? WHERE id = ?');
  for (const row of rows) {
    balance = row.type === BANK_OPENING_TYPE ? row.balance_cents : balance + row.credit_cents - row.debit_cents;
    if (row.balance_cents !== balance) update.run(balance, row.id);
  }
  store.changed = true;
  return balance;
}

// Accounts that appear before anything can be encoded against them: every managed account,
// whether or not it has been opened yet.
export function bankAccounts(store) {
  return store.all(`SELECT a.id, a.account_name, a.account_number, a.currency, a.active, b.name AS bank_name, b.active AS bank_active,
      c.symbol AS currency_symbol, c.decimals AS currency_decimals,
      (SELECT COUNT(*) FROM bank_records WHERE account_id = a.id AND voided = 0) AS entries,
      (SELECT COUNT(*) FROM bank_records WHERE account_id = a.id AND type = ?) AS opened,
      (SELECT entry_date FROM bank_records WHERE account_id = a.id AND type = ? LIMIT 1) AS opened_on
    FROM bank_accounts a JOIN banks b ON b.id = a.bank_id LEFT JOIN currencies c ON c.code = a.currency
    ORDER BY b.name COLLATE NOCASE, a.account_name COLLATE NOCASE`, BANK_OPENING_TYPE, BANK_OPENING_TYPE)
    .map(row => ({
      id: row.id, account: accountLabel(row), accountName: row.account_name, accountNumber: row.account_number,
      bankName: row.bank_name, currency: row.currency, currencySymbol: row.currency_symbol ?? '',
      currencyDecimals: row.currency_decimals ?? 2,
      entries: row.entries, opened: !!row.opened, openedOn: row.opened_on || '',
      active: !!row.active && !!row.bank_active,
    }));
}

export function listBankRecords(store, actor, { accountId = '', from = '', to = '', text = '', includeVoided = true, limit = 200, offset = 0 } = {}) {
  permit(actor, [...BANK_RECORD_ROLES, 'viewer']);
  const where = ['1 = 1'], params = [];
  if (accountId) { where.push('r.account_id = ?'); params.push(accountId); }
  if (from) { where.push('r.entry_date >= ?'); params.push(from); }
  if (to) { where.push('r.entry_date <= ?'); params.push(to); }
  if (!includeVoided) where.push('r.voided = 0');
  if (text) { where.push('(r.description LIKE ? OR r.reference LIKE ? OR r.remarks LIKE ?)'); params.push(...Array(3).fill(`%${text}%`)); }
  const clause = where.join(' AND ');

  const rows = store.all(`${RECORD_SELECT} WHERE ${clause}
    ORDER BY r.entry_date DESC, CASE WHEN r.type = ? THEN 0 ELSE 1 END DESC, r.seq DESC LIMIT ? OFFSET ?`,
  ...params, BANK_OPENING_TYPE, limit, offset);

  // Totals are per currency. Adding a dollar account to a peso account would produce a
  // number that means nothing, so the system does not produce one.
  const totals = store.all(`SELECT a.currency, COALESCE(c.symbol, '') AS symbol, COALESCE(c.decimals, 2) AS decimals,
      COUNT(*) AS n, COALESCE(SUM(r.debit_cents), 0) AS debit, COALESCE(SUM(r.credit_cents), 0) AS credit
    FROM bank_records r JOIN bank_accounts a ON a.id = r.account_id JOIN banks b ON b.id = a.bank_id
      LEFT JOIN currencies c ON c.code = a.currency
    WHERE ${clause} AND r.voided = 0 AND r.type <> ?
    GROUP BY a.currency ORDER BY a.currency`, ...params, BANK_OPENING_TYPE);

  return {
    rows: rows.map(shape),
    total: totals.reduce((sum, row) => sum + row.n, 0),
    totals: totals.map(row => ({
      currency: row.currency, symbol: row.symbol, decimals: row.decimals, entries: row.n,
      debit: fromMinor(row.debit, row.decimals), credit: fromMinor(row.credit, row.decimals),
    })),
    accounts: bankAccounts(store),
    balances: balancesFor(store),
  };
}

// The balance as of each account's last dated line - not its last encoded one, since a line
// can be encoded late and still belong earlier in the passbook.
function balancesFor(store) {
  return store.all(`SELECT r.account_id, r.balance_cents, r.entry_date, a.account_name, a.account_number, a.currency,
      b.name AS bank_name, COALESCE(c.symbol, '') AS currency_symbol, COALESCE(c.decimals, 2) AS currency_decimals
    FROM bank_records r JOIN bank_accounts a ON a.id = r.account_id JOIN banks b ON b.id = a.bank_id
      LEFT JOIN currencies c ON c.code = a.currency
    WHERE r.voided = 0
      AND NOT EXISTS (SELECT 1 FROM bank_records x WHERE x.account_id = r.account_id AND x.voided = 0
        AND (x.entry_date, CASE WHEN x.type = ? THEN 0 ELSE 1 END, x.seq)
          > (r.entry_date, CASE WHEN r.type = ? THEN 0 ELSE 1 END, r.seq))
    ORDER BY b.name COLLATE NOCASE, a.account_name COLLATE NOCASE`, BANK_OPENING_TYPE, BANK_OPENING_TYPE)
    .map(row => ({
      accountId: row.account_id, account: accountLabel(row), bankName: row.bank_name,
      currency: row.currency, symbol: row.currency_symbol, decimals: row.currency_decimals,
      balance: fromMinor(row.balance_cents, row.currency_decimals), asOf: row.entry_date,
    }));
}

export function getBankRecord(store, actor, id) {
  permit(actor, [...BANK_RECORD_ROLES, 'viewer']);
  const row = found(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id), 'Bank record');
  return { ...shape(row), history: store.history('bank', id) };
}

// The amount as the account's own currency counts it.
const amountIn = (account, value, field) => {
  try {
    return toMinor(value, account.currencyDecimals);
  } catch (error) {
    const places = account.currencyDecimals;
    if (!/decimal|whole amount/.test(error.message)) throw new AppError(`${field}: ${error.message}`);
    throw new AppError(places > 0
      ? `${field}: ${account.currency} is recorded to ${places} decimal place${places === 1 ? '' : 's'}, so use at most ${places}.`
      : `${field}: ${account.currency} has no decimal places, so enter a whole amount.`);
  }
};

// The beginning balance, entered by hand once per account, before anything can be encoded
// against it. Nothing else in the passbook takes a balance figure from a person.
export function openBankAccount(store, actor, input) {
  permit(actor, BANK_RECORD_ROLES);
  const value = bankOpeningSchema.parse(input);
  return store.transaction(() => {
    const account = accountFor(store, value.accountId, { mustBeUsable: true });
    if (openingRow(store, account.id)) throw new AppError(`${account.display} already has a beginning balance. Encode a transaction instead.`, 409);
    const id = randomUUID(), at = new Date().toISOString();
    store.run(`INSERT INTO bank_records(id, account_id, entry_date, reference, type, description, debit_cents, credit_cents, balance_cents, remarks, encoded_by, encoded_at)
      VALUES(?,?,?,'',?,?,0,0,?,?,?,?)`, id, account.id, value.entryDate, BANK_OPENING_TYPE,
    `Beginning balance of ${account.display}`, amountIn(account, value.balance, 'Beginning balance'), value.remarks, actor.fullName, at);
    rebalance(store, account.id);
    const record = shape(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id));
    store.log(actor, 'open-account', 'bank', id, { detail: `${account.display} opened with a beginning balance of ${value.balance} ${account.currency} as of ${value.entryDate}`, after: record });
    return record;
  });
}

function requireOpened(store, account, entryDate) {
  const opening = openingRow(store, account.id);
  if (!opening) throw new AppError(`${account.display} has no beginning balance yet. Enter the beginning balance first, then encode its transactions.`, 409);
  if (entryDate < opening.entry_date) throw new AppError(`That date is before the beginning balance of ${account.display} (${opening.entry_date}). A transaction cannot predate the opening figure.`);
  return opening;
}

export function createBankRecord(store, actor, input) {
  permit(actor, BANK_RECORD_ROLES);
  const value = bankRecordSchema.parse(input);
  return store.transaction(() => {
    const account = accountFor(store, value.accountId, { mustBeUsable: true });
    requireOpened(store, account, value.entryDate);
    const id = randomUUID(), at = new Date().toISOString();
    store.run(`INSERT INTO bank_records(id, account_id, entry_date, reference, type, description, debit_cents, credit_cents, balance_cents, remarks, encoded_by, encoded_at)
      VALUES(?,?,?,?,?,?,?,?,0,?,?,?)`, id, account.id, value.entryDate, value.reference, value.type, value.description,
    amountIn(account, value.debit, 'Debit'), amountIn(account, value.credit, 'Credit'), value.remarks, actor.fullName, at);
    rebalance(store, account.id);
    const record = shape(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id));
    store.log(actor, 'encode', 'bank', id, {
      detail: `${value.type} ${value.entryDate}${value.reference ? ` (${value.reference})` : ''} on ${account.display}: ${value.debit > 0 ? `withdrawal ${value.debit}` : `deposit ${value.credit}`} ${account.currency}, balance ${record.balance}`,
      after: record,
    });
    return record;
  });
}

export function updateBankRecord(store, actor, id, input) {
  permit(actor, BANK_RECORD_ROLES);
  return store.transaction(() => {
    const existing = found(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id), 'Bank record');
    const before = shape(existing);
    if (before.voided) throw new AppError('This entry is voided. Encode a fresh entry instead of editing it.', 409);
    const at = new Date().toISOString();

    if (before.opening) {
      // Correcting the beginning balance re-bases every figure after it.
      const value = bankOpeningSchema.parse(input);
      if (value.accountId !== before.accountId) throw new AppError('The beginning balance belongs to its account and cannot be moved to another.');
      const account = accountFor(store, before.accountId);
      const later = store.get('SELECT MIN(entry_date) AS first FROM bank_records WHERE account_id = ? AND voided = 0 AND type <> ?', before.accountId, BANK_OPENING_TYPE).first;
      if (later && value.entryDate > later) throw new AppError(`Transactions are already encoded from ${later}. The beginning balance cannot be dated after them.`);
      store.run('UPDATE bank_records SET entry_date = ?, balance_cents = ?, remarks = ?, encoded_by = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        value.entryDate, amountIn(account, value.balance, 'Beginning balance'), value.remarks, actor.fullName, actor.fullName, at, id);
    } else {
      const value = bankRecordSchema.parse(input);
      const account = accountFor(store, value.accountId, { mustBeUsable: true });
      requireOpened(store, account, value.entryDate);
      store.run(`UPDATE bank_records SET account_id = ?, entry_date = ?, reference = ?, type = ?, description = ?,
        debit_cents = ?, credit_cents = ?, remarks = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      account.id, value.entryDate, value.reference, value.type, value.description,
      amountIn(account, value.debit, 'Debit'), amountIn(account, value.credit, 'Credit'), value.remarks, actor.fullName, at, id);
      if (account.id !== before.accountId) rebalance(store, before.accountId);
    }

    rebalance(store, store.get('SELECT account_id FROM bank_records WHERE id = ?', id).account_id);
    const after = shape(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id));
    const changed = Object.keys(after).filter(key => !['updatedBy', 'updatedAt', 'derived', 'encodedBy'].includes(key) && before[key] !== after[key]);
    if (!changed.length) throw new AppError('Nothing was changed.');
    store.log(actor, 'correct', 'bank', id, {
      detail: `Corrected ${changed.join(', ')} - ${changed.map(key => `${key}: "${before[key]}" to "${after[key]}"`).join('; ')}`.slice(0, 1800),
      before, after,
    });
    return after;
  });
}

export function voidBankRecord(store, actor, id, input) {
  permit(actor, ['admin', 'approver']);
  const value = bankVoidSchema.parse(input);
  return store.transaction(() => {
    const before = shape(found(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id), 'Bank record'));
    if (before.voided) throw new AppError('This entry is already voided.', 409);
    if (before.opening && store.get('SELECT COUNT(*) AS n FROM bank_records WHERE account_id = ? AND voided = 0 AND type <> ?', before.accountId, BANK_OPENING_TYPE).n) {
      throw new AppError('Transactions are encoded against this beginning balance. Void those first, or correct the beginning balance instead.', 409);
    }
    const at = new Date().toISOString();
    store.run('UPDATE bank_records SET voided = 1, void_reason = ?, updated_by = ?, updated_at = ? WHERE id = ?', value.reason, actor.fullName, at, id);
    rebalance(store, before.accountId);
    const after = shape(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id));
    store.log(actor, 'void', 'bank', id, { detail: `Entry voided - ${value.reason}`, before, after });
    return after;
  });
}

// Accounts encoded before balances were computed have no opening line, which would leave
// their passbook locked and their balances following nothing. Each one keeps the balance it
// stood at before its first movement, dated the same day, and its chain is worked out from
// there. It is recorded as entered by the System and shown as a derived figure, so it reads
// as what it is: a stand-in until somebody confirms the real opening balance.
export function ensureBankOpenings(store) {
  const accounts = store.all(`SELECT DISTINCT account_id FROM bank_records WHERE account_id IS NOT NULL AND account_id NOT IN
    (SELECT account_id FROM bank_records WHERE type = ?)`, BANK_OPENING_TYPE).map(row => row.account_id);
  if (!accounts.length) return [];
  const system = { id: 'system', fullName: 'System', role: 'admin' };
  return store.transaction(() => accounts.map(accountId => {
    const account = accountFor(store, accountId);
    const first = store.get('SELECT * FROM bank_records WHERE account_id = ? ORDER BY entry_date, seq LIMIT 1', accountId);
    const opening = first.balance_cents - first.credit_cents + first.debit_cents;
    const id = randomUUID(), at = new Date().toISOString();
    store.run(`INSERT INTO bank_records(id, account_id, entry_date, reference, type, description, debit_cents, credit_cents, balance_cents, remarks, encoded_by, encoded_at)
      VALUES(?,?,?,'',?,?,0,0,?,?,?,?)`, id, accountId, first.entry_date, BANK_OPENING_TYPE,
    `Beginning balance of ${account.display}`, opening, 'Worked out from the first encoded line - confirm this figure against the passbook', system.fullName, at);
    const balance = rebalance(store, accountId);
    store.log(system, 'open-account', 'bank', id, { detail: `${account.display} opened at ${fromMinor(opening, account.currencyDecimals)} ${account.currency} as of ${first.entry_date}, worked out from its first encoded line; balances re-worked to ${fromMinor(balance, account.currencyDecimals)}` });
    return { account: account.display, opening: fromMinor(opening, account.currencyDecimals), balance: fromMinor(balance, account.currencyDecimals), currency: account.currency };
  }));
}

// A short summary for the dashboard card.
export function bankSummary(store, actor) {
  if (![...BANK_RECORD_ROLES, 'viewer'].includes(actor.role)) return null;
  const { totals, balances } = listBankRecords(store, actor, { limit: 1 });
  return { entries: totals.reduce((sum, row) => sum + row.entries, 0), totals, balances };
}

// ---------------------------------------------------------------- bulk import
//
// Encoding a historical passbook one line at a time is not reasonable, so a whole file can be
// posted at once. The ledger rules do not change because the rows arrived together: the
// beginning balance still comes first, every line still belongs to a managed account in its
// own currency, and the running balance is still worked out rather than read from the file.
//
// It is all or nothing. One bad row and the whole import is refused, because a half-loaded
// passbook is worse than none: the balances would be right for a while and then wrong, with
// nothing to say where. Every row that does land is written to the audit trail individually,
// so an imported line has the same history as a hand-encoded one.
export function importBankRows(store, actor, { openings = [], lines = [], fileName = '' }) {
  permit(actor, BANK_RECORD_ROLES);
  return store.transaction(() => {
    const at = new Date().toISOString();
    const touched = new Map();
    const insert = store.db.prepare(`INSERT INTO bank_records(id, account_id, entry_date, reference, type, description,
      debit_cents, credit_cents, balance_cents, remarks, encoded_by, encoded_at) VALUES(?,?,?,?,?,?,?,?,0,?,?,?)`);

    for (const opening of openings) {
      const account = accountFor(store, opening.accountId, { mustBeUsable: true });
      if (openingRow(store, account.id)) throw new AppError(`${account.display} already has a beginning balance.`, 409);
      const id = randomUUID();
      insert.run(id, account.id, opening.entryDate, '', BANK_OPENING_TYPE, `Beginning balance of ${account.display}`,
        0, 0, opening.remarks || '', actor.fullName, at);
      // The opening carries its figure in the balance column; it is the one amount entered.
      store.run('UPDATE bank_records SET balance_cents = ? WHERE id = ?', amountIn(account, opening.balance, 'Beginning balance'), id);
      touched.set(account.id, account);
      store.log(actor, 'open-account', 'bank', id, {
        detail: `${account.display} opened with a beginning balance of ${opening.balance} ${account.currency} as of ${opening.entryDate}, imported from ${fileName || 'a spreadsheet'}`,
      });
    }

    const ids = [];
    for (const line of lines) {
      const account = accountFor(store, line.accountId, { mustBeUsable: true });
      requireOpened(store, account, line.entryDate);
      const id = randomUUID();
      insert.run(id, account.id, line.entryDate, line.reference || '', line.type, line.description,
        amountIn(account, line.debit || 0, 'Debit'), amountIn(account, line.credit || 0, 'Credit'),
        line.remarks || '', actor.fullName, at);
      touched.set(account.id, account);
      ids.push(id);
    }

    for (const accountId of touched.keys()) rebalance(store, accountId);

    // Logged after the balances settle, so each row's history shows the figure it ended on.
    for (const id of ids) {
      const record = shape(store.get(`${RECORD_SELECT} WHERE r.id = ?`, id));
      store.log(actor, 'encode', 'bank', id, {
        detail: `Imported from ${fileName || 'a spreadsheet'} - ${record.type} ${record.entryDate}${record.reference ? ` (${record.reference})` : ''} on ${record.account}: ${record.debit > 0 ? `withdrawal ${record.debit}` : `deposit ${record.credit}`} ${record.currency}, balance ${record.balance}`,
        after: record,
      });
    }

    const accounts = [...touched.values()].map(account => {
      const fresh = accountFor(store, account.id);
      return { account: fresh.display, currency: fresh.currency, balance: fresh.balance };
    });
    store.log(actor, 'import', 'bank', 'bulk', {
      detail: `Imported ${lines.length} transaction${lines.length === 1 ? '' : 's'}${openings.length ? ` and ${openings.length} beginning balance${openings.length === 1 ? '' : 's'}` : ''} from ${fileName || 'a spreadsheet'} across ${touched.size} account${touched.size === 1 ? '' : 's'}`,
      after: { accounts },
    });
    return { openings: openings.length, lines: lines.length, accounts };
  });
}
