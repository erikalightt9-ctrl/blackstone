// Puts a backup back in place.
//
// The database currently in use is never discarded: it is archived first, so a restore made
// in a panic can itself be undone. The backup is checked before it is trusted, and the
// service must be stopped, or the file will be reopened underneath it.
//
//   node scripts/restore.mjs                       lists what is available
//   node scripts/restore.mjs <file> --confirm      restores that one
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, stat, rename, copyFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.FR_DATA_DIR || path.join(directory, '../data'));
const live = path.join(dataDirectory, 'finance.sqlite');
const backupDirectory = path.join(dataDirectory, 'backups');

const args = process.argv.slice(2).filter(a => a !== '--confirm');
const confirmed = process.argv.includes('--confirm');
const exists = async file => { try { await stat(file); return true; } catch { return false; } };

const describe = async file => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const n = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const last = db.prepare('SELECT at FROM audit ORDER BY at DESC LIMIT 1').get()?.at || 'never';
    return { integrity, requests: n('requests'), ledger: n('ledger'), bank: n('bank_records'), lastActivity: last };
  } finally { db.close(); }
};

if (!args.length) {
  if (!(await exists(backupDirectory))) { console.error(`No backups yet in ${backupDirectory}. Run: npm run backup`); process.exit(1); }
  const files = (await readdir(backupDirectory)).filter(name => name.endsWith('.sqlite')).sort().reverse();
  if (!files.length) { console.error(`No backups yet in ${backupDirectory}. Run: npm run backup`); process.exit(1); }
  console.log(`Backups in ${backupDirectory}, newest first:\n`);
  for (const name of files.slice(0, 15)) {
    // A damaged backup among the good ones must be reported, not allowed to stop the listing.
    try {
      const summary = await describe(path.join(backupDirectory, name));
      console.log(`  ${name}\n    ${summary.integrity}, ${summary.requests} requests, ${summary.ledger} ledger entries, ${summary.bank} bank records, last activity ${summary.lastActivity}`);
    } catch (error) {
      console.log(`  ${name}\n    UNUSABLE - ${error.message}. Do not restore this one.`);
    }
  }
  if (files.length > 15) console.log(`  ... and ${files.length - 15} older`);
  console.log(`\nStop the service, then restore one with:\n  npm run restore -- ${files[0]} --confirm`);
  process.exit(0);
}

const chosen = path.isAbsolute(args[0]) ? args[0] : path.join(backupDirectory, args[0]);
if (!(await exists(chosen))) { console.error(`No such backup: ${chosen}`); process.exit(1); }

const summary = await describe(chosen);
if (summary.integrity !== 'ok') { console.error(`That backup fails its integrity check (${summary.integrity}). Choose another.`); process.exit(1); }

console.log(`Backup: ${chosen}`);
console.log(`  ${summary.requests} requests, ${summary.ledger} ledger entries, ${summary.bank} bank records, last activity ${summary.lastActivity}`);
if (await exists(live)) {
  // The database in use may itself be the reason for the restore, so failing to read it is an
  // expected outcome here rather than an error. It must never stop the recovery.
  try {
    const current = await describe(live);
    console.log(`Currently in use: ${current.requests} requests, ${current.ledger} ledger entries, last activity ${current.lastActivity}`);
    const losing = current.requests - summary.requests;
    if (losing > 0) console.log(`\n  This restore steps back past ${losing} request(s) recorded since that backup.`);
  } catch (error) {
    console.log(`Currently in use: unreadable (${error.message}). That is exactly what this restore is for.`);
  }
}
if (!confirmed) {
  console.error('\nNothing has changed. Stop the service, then add --confirm to go ahead.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
if (await exists(live)) {
  const archive = path.join(dataDirectory, `replaced-${stamp}`);
  await mkdir(archive, { recursive: true });
  for (const name of await readdir(dataDirectory)) {
    if (name.startsWith('finance.sqlite')) await rename(path.join(dataDirectory, name), path.join(archive, name));
  }
  console.log(`\nThe database that was in use is archived in: ${archive}`);
}
await copyFile(chosen, live);
const restored = await describe(live);
console.log(`Restored: ${restored.integrity}, ${restored.requests} requests, ${restored.ledger} ledger entries, ${restored.bank} bank records`);
console.log('\nStart the service again:  npm run dev');
