// Clears the transactional data - payment requests, petty cash requests and the passbook -
// and keeps everything the company has set up: accounts, banks, bank accounts, currencies,
// the accounting categories and the configuration.
//
// This exists because the system is built so that a record can never be deleted, and that is
// the right rule for real records. Sample data is not a real record. Rather than weaken the
// rule, this script takes a full backup, drops the protective triggers, clears the
// transactional tables, and leaves the triggers to be recreated on the next start - which the
// schema does for itself. The backup means the demo data is archived, not lost.
//
// It is not a way to edit history. It empties whole modules and resets the numbering, so the
// first real request is numbered 000001. Once real work is in the system, the way to correct
// a record is to cancel, void or correct it, which is what the audit trail is for.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.FR_DATA_DIR || path.join(directory, '../data'));
const live = path.join(dataDirectory, 'finance.sqlite');

// Emptied, in an order that respects the references between them.
const CLEARED = [
  'documents', 'request_lines', 'payments', 'ledger', 'replenishments', 'requests',
  'bank_records', 'audit', 'sequences',
];
// Kept, and reported so it is obvious what survives.
const KEPT = ['users', 'config', 'categories', 'banks', 'bank_accounts', 'currencies'];

// The triggers that forbid deletion. Dropped for this operation only; the schema recreates
// every one of them the next time the application opens the database.
const GUARDS = [
  'audit_no_delete', 'audit_no_update', 'bank_no_delete', 'ledger_no_delete', 'ledger_no_update',
  'lines_delete_locked', 'lines_insert_locked', 'lines_update_locked',
  'payment_no_delete', 'replenishment_no_delete', 'request_no_delete',
];

const exists = async file => { try { await stat(file); return true; } catch { return false; } };
const count = (db, table) => {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return null; }
};

if (!(await exists(live))) {
  console.error(`No database at ${live}.`);
  process.exit(1);
}

const confirmed = process.argv.includes('--confirm') || process.env.FR_CONFIRM === 'clear-transactions';
if (!confirmed) {
  const db = new DatabaseSync(live, { readOnly: true });
  console.error('This clears the transactional data and keeps everything else.\n');
  console.error('  Would be emptied:');
  for (const table of CLEARED) console.error(`    ${String(count(db, table)).padStart(6)}  ${table}`);
  console.error('\n  Would be kept:');
  for (const table of KEPT) console.error(`    ${String(count(db, table)).padStart(6)}  ${table}`);
  db.close();
  console.error(`\n  A full backup is taken first, so the current data is archived and not lost.
  Stop the service, then run:   npm run clear-transactions -- --confirm\n`);
  process.exit(1);
}

// A verified backup before anything is touched.
const backups = path.join(dataDirectory, 'backups');
await mkdir(backups, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const backup = path.join(backups, `before-clear-${stamp}.sqlite`);

const db = new DatabaseSync(live);
const before = Object.fromEntries([...CLEARED, ...KEPT].map(table => [table, count(db, table)]));
db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
console.log(`Backed up to: ${backup}`);

const verify = new DatabaseSync(backup, { readOnly: true });
const integrity = verify.prepare('PRAGMA integrity_check').get().integrity_check;
const copied = count(verify, 'requests');
verify.close();
if (integrity !== 'ok' || copied !== before.requests) {
  console.error(`The backup did not verify (${integrity}, ${copied} of ${before.requests} requests). Nothing has been cleared.`);
  db.close();
  process.exit(1);
}
console.log(`Backup verified: integrity ok, ${copied} request(s) preserved.`);

try {
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN IMMEDIATE');
  for (const trigger of GUARDS) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of CLEARED) if (before[table] !== null) db.exec(`DELETE FROM ${table}`);
  // Signed-in sessions refer to a state that no longer exists, so everyone signs in again.
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM login_limits');
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error(`Nothing was cleared: ${error.message}`);
  db.close();
  process.exit(1);
}

const after = Object.fromEntries([...CLEARED, ...KEPT].map(table => [table, count(db, table)]));
db.exec('VACUUM');
db.close();

console.log('\nCleared:');
for (const table of CLEARED) if (before[table] !== null) console.log(`  ${table}: ${before[table]} -> ${after[table]}`);
console.log('\nKept:');
for (const table of KEPT) if (before[table] !== null) console.log(`  ${table}: ${after[table]}`);
console.log(`
The deletion guards were dropped for this operation and are recreated automatically the next
time the application starts, so records are protected again from the first real entry.

Next:
  1. Start the service:  npm run dev
  2. Sign in again - every session was ended.
  3. Bank Records - enter each account's beginning balance by hand before encoding it.
  4. Petty Cash Fund - open the fund with its real opening balance.

The demo data is in ${backup} if any of it is ever needed.
`);
