import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, DEFAULT_CATEGORIES, SEED_CURRENCIES } from './defaults.mjs';

// Database triggers, not only application code, enforce the controls in the specification:
// the audit trail and the petty cash ledger are append-only, financial requests are never
// deleted, and expense lines can only move while their request is still a draft.
const SCHEMA = `
PRAGMA journal_mode=WAL;
-- Stated rather than inherited: every committed transaction is flushed to the disk before
-- the commit returns, so a power cut or a crash cannot lose an approval or a disbursement
-- that the screen already confirmed. It costs a disk sync per commit, which at this volume
-- is nothing, and it is the difference between "probably saved" and "saved".
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, full_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sequences (prefix TEXT NOT NULL, year INTEGER NOT NULL, next INTEGER NOT NULL, PRIMARY KEY(prefix, year));

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, number TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
  date_requested TEXT NOT NULL, requested_by TEXT NOT NULL, payee TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '',
  final_approver TEXT NOT NULL, total_cents INTEGER NOT NULL DEFAULT 0,
  maker_id TEXT NOT NULL, maker_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  submitted_at TEXT, approver_id TEXT, approver_name TEXT, decided_at TEXT, decision_remarks TEXT NOT NULL DEFAULT '',
  previous_status TEXT, cancelled_by TEXT, cancelled_at TEXT, cancel_reason TEXT NOT NULL DEFAULT '',
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS request_kind_status ON requests(kind, status);
CREATE INDEX IF NOT EXISTS request_date ON requests(date_requested);

CREATE TABLE IF NOT EXISTS request_lines (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), position INTEGER NOT NULL,
  particulars TEXT NOT NULL, quantity REAL NOT NULL, unit_cents INTEGER NOT NULL, amount_cents INTEGER NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id)
);
CREATE INDEX IF NOT EXISTS line_request ON request_lines(request_id);
CREATE INDEX IF NOT EXISTS line_category ON request_lines(category_id);

CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, content BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS document_request ON documents(request_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES requests(id), method TEXT NOT NULL,
  bank TEXT NOT NULL DEFAULT '', check_number TEXT NOT NULL DEFAULT '', check_date TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL, payee TEXT NOT NULL, date_prepared TEXT NOT NULL,
  date_released TEXT NOT NULL DEFAULT '', released_by TEXT NOT NULL DEFAULT '', received_by TEXT NOT NULL DEFAULT '',
  remarks TEXT NOT NULL DEFAULT '', recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replenishments (
  id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, status TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '', remarks TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
  approved_by TEXT, approved_at TEXT, funded_by TEXT, funded_at TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, entry_date TEXT NOT NULL,
  reference TEXT NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL,
  in_cents INTEGER NOT NULL DEFAULT 0, out_cents INTEGER NOT NULL DEFAULT 0, balance_cents INTEGER NOT NULL,
  actor TEXT NOT NULL, request_id TEXT REFERENCES requests(id), replenishment_id TEXT REFERENCES replenishments(id)
);

-- Currencies, banks and bank accounts are data, not code. Nothing here names a particular
-- bank or currency: the company adds, renames and retires its own, and an account carries
-- whichever currency it is actually held in.
CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT '',
  decimals INTEGER NOT NULL DEFAULT 2, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS banks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, short_name TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES banks(id),
  account_name TEXT NOT NULL, account_number TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL REFERENCES currencies(code), account_type TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT
);
-- Two accounts at the same bank cannot share a number, but a blank number is not a clash.
CREATE UNIQUE INDEX IF NOT EXISTS bank_account_number ON bank_accounts(bank_id, account_number) WHERE account_number <> '';
CREATE INDEX IF NOT EXISTS bank_account_bank ON bank_accounts(bank_id);

CREATE TABLE IF NOT EXISTS bank_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  account_id TEXT REFERENCES bank_accounts(id),
  entry_date TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, description TEXT NOT NULL,
  debit_cents INTEGER NOT NULL DEFAULT 0, credit_cents INTEGER NOT NULL DEFAULT 0, balance_cents INTEGER NOT NULL,
  remarks TEXT NOT NULL DEFAULT '', voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT NOT NULL DEFAULT '',
  encoded_by TEXT NOT NULL, encoded_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
  entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
  before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit(entity_kind, entity_id);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'History records cannot be edited.'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'History records cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'Petty cash ledger entries cannot be edited. Record a separate reversal.'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'Petty cash ledger entries cannot be deleted. Record a separate reversal.'); END;
CREATE TRIGGER IF NOT EXISTS request_no_delete BEFORE DELETE ON requests BEGIN SELECT RAISE(ABORT, 'Financial requests are never deleted. Cancel the request instead.'); END;
CREATE TRIGGER IF NOT EXISTS payment_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'Payment records cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS bank_no_delete BEFORE DELETE ON bank_records BEGIN SELECT RAISE(ABORT, 'Bank records are never deleted. Void the entry instead, which keeps it on file.'); END;
CREATE TRIGGER IF NOT EXISTS replenishment_no_delete BEFORE DELETE ON replenishments BEGIN SELECT RAISE(ABORT, 'Replenishment records cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS lines_insert_locked BEFORE INSERT ON request_lines
  BEGIN SELECT RAISE(ABORT, 'Only a draft request may have its expense lines changed.') WHERE (SELECT status FROM requests WHERE id = NEW.request_id) <> 'draft'; END;
CREATE TRIGGER IF NOT EXISTS lines_update_locked BEFORE UPDATE ON request_lines
  BEGIN SELECT RAISE(ABORT, 'Only a draft request may have its expense lines changed.') WHERE (SELECT status FROM requests WHERE id = OLD.request_id) <> 'draft'; END;
CREATE TRIGGER IF NOT EXISTS lines_delete_locked BEFORE DELETE ON request_lines
  BEGIN SELECT RAISE(ABORT, 'Only a draft request may have its expense lines changed.') WHERE (SELECT status FROM requests WHERE id = OLD.request_id) <> 'draft'; END;
`;

export class Store {
  constructor(file = ':memory:') {
    this.listeners = new Set(); this.depth = 0; this.changed = false;
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // Accounts carry a registered email address. Only an address the administrator has
    // registered can be used to sign in or to receive a password reset, so the column is
    // added to an existing database too rather than only to a new one.
    const columns = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
    if (!columns.has('email')) this.db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    // Unique, but only among addresses that are actually set: accounts predating this column
    // have an empty one and must not collide with each other.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS user_email ON users(email) WHERE email <> ''");

    const insertConfig = this.db.prepare('INSERT OR IGNORE INTO config(key, value) VALUES(?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) insertConfig.run(key, JSON.stringify(value));
    // Any default category the database does not already hold is added, so a new entry in
    // the standard chart of accounts reaches an existing installation on the next start.
    // Existing rows are left exactly as they are, including ones an administrator renamed
    // or deactivated, because their code is what matches.
    const insertCategory = this.db.prepare('INSERT OR IGNORE INTO categories(id, code, name, active, created_at) VALUES(?, ?, ?, 1, ?)');
    const seededAt = new Date().toISOString();
    for (const [code, name] of DEFAULT_CATEGORIES) insertCategory.run(randomUUID(), code, name, seededAt);

    // If setting up or carrying over fails, the handle is released before the error leaves
    // the constructor. Otherwise a failed start would hold the database file open with no
    // object to close it - on Windows that locks the file against the very restore that
    // would fix it.
    try {
      this.seedCurrencies(seededAt);
      this.migrateBankAccounts(seededAt);
    } catch (error) {
      try { this.db.close(); } catch { /* the original error is the one worth reporting */ }
      throw error;
    }
  }

  // Written once, when the table is new. Unlike the categories these are not topped up on
  // every start, so a currency an administrator removes stays removed instead of returning.
  seedCurrencies(at) {
    if (this.get('SELECT COUNT(*) AS n FROM currencies').n) return;
    const insert = this.db.prepare('INSERT OR IGNORE INTO currencies(code, name, symbol, decimals, active, created_at) VALUES(?, ?, ?, ?, 1, ?)');
    for (const [code, name, symbol, decimals] of SEED_CURRENCIES) insert.run(code, name, symbol, decimals, at);
  }

  // The currency the carried-over accounts are recorded in: the configured base currency, or
  // any currency still in use. If the list has been emptied the base currency is put back,
  // because a carry-over must not be blocked by an administrator having cleared the list -
  // and an account has to be recorded in something.
  currencyForCarryOver(at) {
    const existing = this.get(`SELECT code FROM currencies WHERE code = ?
      UNION ALL SELECT code FROM currencies WHERE active = 1 LIMIT 1`, DEFAULT_CONFIG.baseCurrency);
    if (existing) return existing.code;
    const [code, name, symbol, decimals] = SEED_CURRENCIES.find(row => row[0] === DEFAULT_CONFIG.baseCurrency)
      ?? [DEFAULT_CONFIG.baseCurrency, DEFAULT_CONFIG.baseCurrency, '', 2];
    this.run('INSERT OR REPLACE INTO currencies(code, name, symbol, decimals, active, created_at) VALUES(?, ?, ?, ?, 1, ?)',
      code, name, symbol, decimals, at);
    return code;
  }

  // Bank records used to carry the account as free text, so "BDO 0123-4567-89" was a label
  // nobody could rename, group or give a currency. Each distinct label becomes a real bank
  // and bank account, keeping the original text as the account name so nothing is lost, and
  // every record is repointed at it. An administrator can then correct the split, which is
  // the whole point of the module this migration feeds.
  migrateBankAccounts(at) {
    const columns = new Set(this.db.prepare('PRAGMA table_info(bank_records)').all().map(column => column.name));
    if (!columns.has('account_id')) this.db.exec('ALTER TABLE bank_records ADD COLUMN account_id TEXT REFERENCES bank_accounts(id)');
    // Nothing to carry over: either a new database, or one already migrated.
    if (!columns.has('account')) { this.db.exec('CREATE INDEX IF NOT EXISTS bank_account_date ON bank_records(account_id, entry_date)'); return []; }

    const legacy = this.all("SELECT DISTINCT account FROM bank_records WHERE account_id IS NULL AND account <> ''").map(row => row.account);
    const currency = this.currencyForCarryOver(at);
    const carried = [];
    return this.transaction(() => {
      for (const label of legacy) {
        // "BDO 0123-4567-89" reads as a bank followed by its number; anything that does not
        // split that way is kept whole as the bank name for an administrator to correct.
        const split = label.match(/^([A-Za-z][A-Za-z.&'\- ]*?)\s+([0-9][0-9\- ]*)$/);
        const bankName = (split ? split[1] : label).trim();
        const number = split ? split[2].trim() : '';
        let bank = this.get('SELECT id FROM banks WHERE name = ? COLLATE NOCASE', bankName);
        if (!bank) {
          bank = { id: randomUUID() };
          this.run('INSERT INTO banks(id, name, created_by, created_at) VALUES(?, ?, ?, ?)', bank.id, bankName, 'System', at);
        }
        const id = randomUUID();
        this.run(`INSERT INTO bank_accounts(id, bank_id, account_name, account_number, currency, description, created_by, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, id, bank.id, label, number, currency, 'Carried over from the free-text account label', 'System', at);
        const moved = this.run('UPDATE bank_records SET account_id = ? WHERE account = ? AND account_id IS NULL', id, label);
        carried.push({ label, bank: bankName, number, records: Number(moved.changes ?? 0) });
      }
      // The old label column is removed rather than left to drift out of step with the
      // account it was replaced by.
      this.db.exec('DROP INDEX IF EXISTS bank_account_date');
      this.db.exec('ALTER TABLE bank_records DROP COLUMN account');
      this.db.exec('CREATE INDEX IF NOT EXISTS bank_account_date ON bank_records(account_id, entry_date)');
      return carried;
    });
  }

  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  config() { return Object.fromEntries(this.all('SELECT key, value FROM config').map(row => [row.key, JSON.parse(row.value)])); }
  setConfig(key, value) { this.run('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)); }

  // Nested calls join the outermost transaction so one request commits or rolls back as a unit.
  transaction(fn) {
    if (this.depth++) { try { return fn(); } finally { this.depth--; } }
    this.db.exec('BEGIN IMMEDIATE'); this.changed = false;
    try {
      const result = fn();
      this.db.exec('COMMIT'); this.depth--;
      if (this.changed) this.emitChange();
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); this.depth--; this.changed = false; throw error; }
  }

  log(actor, action, entityKind, entityId, { status = '', detail = '', before = null, after = null } = {}) {
    this.run('INSERT INTO audit(id, at, actor_id, actor_name, action, entity_kind, entity_id, status, detail, before_json, after_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      randomUUID(), new Date().toISOString(), actor?.id ?? 'system', actor?.fullName || actor?.username || 'system', action, entityKind, entityId, status, detail,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after));
    this.changed = true;
    if (!this.depth) this.emitChange();
  }

  history(entityKind, entityId) {
    return this.all('SELECT id, at, actor_name AS actor, action, status, detail FROM audit WHERE entity_kind = ? AND entity_id = ? ORDER BY at, rowid', entityKind, entityId);
  }
  auditTrail(limit = 500) {
    return this.all('SELECT id, at, actor_name AS actor, action, entity_kind AS entityKind, entity_id AS entityId, status, detail FROM audit ORDER BY at DESC, rowid DESC LIMIT ?', limit);
  }

  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emitChange() { for (const listener of this.listeners) { try { listener(); } catch { /* A disconnected browser must never affect a committed record. */ } } }
  close() { this.db.close(); }
}
