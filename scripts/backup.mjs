// Takes a consistent copy of the database, checks that the copy is actually usable, and
// optionally puts a second copy somewhere off this machine.
//
// VACUUM INTO is SQLite's own hot backup: it writes a complete, defragmented copy inside a
// read transaction, so the copy is never half-written even mid-transaction. Copying the file
// with the file manager while the service is running is NOT safe; this is.
//
//   FR_KEEP_BACKUPS    how many to keep here (default 240, about ten days of hourly copies)
//   FR_BACKUP_COPY_TO  a second destination: OneDrive, a network share, a USB drive
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, stat, unlink, copyFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const KEEP = Number(process.env.FR_KEEP_BACKUPS || 240);
const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.FR_DATA_DIR || path.join(directory, '../data'));
const source = path.join(dataDirectory, 'finance.sqlite');
const backupDirectory = path.join(dataDirectory, 'backups');
const elsewhere = (process.env.FR_BACKUP_COPY_TO || '').trim();

// The tables whose row counts are compared, so a copy that silently lost records is caught.
const COUNTED = ['users', 'requests', 'request_lines', 'payments', 'ledger', 'replenishments', 'banks', 'bank_accounts', 'currencies', 'bank_records', 'documents', 'audit'];
// Only the tables the database actually has. A backup must never fail because it is older
// than this script - an earlier database that predates a table is exactly what a restore is
// for, and refusing to copy it would be the worst possible moment to be strict.
const tablesIn = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
const counts = (db, tables) => Object.fromEntries([...tables].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));

try {
  await stat(source);
} catch {
  console.error(`No database at ${source}. Nothing to back up.`);
  process.exit(1);
}
await mkdir(backupDirectory, { recursive: true });

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const target = path.join(backupDirectory, `finance-${stamp}.sqlite`);

const live = new DatabaseSync(source, { readOnly: true });
let expected, counted;
try {
  counted = COUNTED.filter(table => tablesIn(live).has(table));
  expected = counts(live, counted);
  live.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  live.close();
}

// A backup nobody has opened is a guess. Open it, check it, and count it.
const copy = new DatabaseSync(target, { readOnly: true });
let integrity, actual;
try {
  integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  actual = counts(copy, counted);
} finally {
  copy.close();
}
if (integrity !== 'ok') {
  console.error(`Backup failed its integrity check: ${integrity}`);
  process.exit(1);
}
const short = counted.filter(table => actual[table] !== expected[table]);
if (short.length) {
  console.error(`Backup is missing rows in: ${short.map(t => `${t} ${actual[t]} of ${expected[t]}`).join(', ')}`);
  process.exit(1);
}

const { size } = await stat(target);
console.log(`Backup verified: ${target}`);
console.log(`  ${(size / 1024).toFixed(0)} KB, integrity ok, ${expected.requests} requests, ${expected.ledger} ledger entries, ${expected.bank_records} bank records, ${expected.audit} history rows`);

// A backup on the same disk as the database does not survive that disk.
if (elsewhere) {
  try {
    await mkdir(elsewhere, { recursive: true });
    const away = path.join(elsewhere, path.basename(target));
    await copyFile(target, away);
    console.log(`Second copy: ${away}`);
  } catch (error) {
    console.error(`Could not write the off-machine copy to ${elsewhere}: ${error.message}`);
    process.exitCode = 1; // the local backup stands, but this is not a silent failure
  }
} else {
  console.warn('FR_BACKUP_COPY_TO is not set, so every copy is on this machine only. One failed disk would take all of them.');
}

const files = (await readdir(backupDirectory)).filter(name => /^finance-.*\.sqlite$/.test(name)).sort().reverse();
for (const stale of files.slice(KEEP)) await unlink(path.join(backupDirectory, stale));
if (files.length > KEEP) console.log(`Removed ${files.length - KEEP} backup(s) beyond the ${KEEP} kept`);
console.log(`${Math.min(files.length, KEEP)} backup(s) in ${backupDirectory}`);
