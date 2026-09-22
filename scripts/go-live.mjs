// Retires the demo database and leaves a clean one ready for first-run setup.
//
// Nothing is deleted: the demo database is backed up and then archived under its own name,
// so it can always be brought back. The service must be stopped first, or the archived copy
// could be missing writes still held in the write-ahead log.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, stat, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.FR_DATA_DIR || path.join(directory, '../data'));
const live = path.join(dataDirectory, 'finance.sqlite');

const exists = async file => { try { await stat(file); return true; } catch { return false; } };

const confirmed = process.argv.includes('--confirm') || process.env.FR_CONFIRM === 'go-live';
if (!confirmed) {
  console.error(`This retires the current database and starts an empty one.

  Current database: ${live}
  It will be archived, not deleted, and a backup is taken first.

  Stop the service, then run:   npm run go-live -- --confirm
`);
  process.exit(1);
}

if (!(await exists(live))) {
  console.log('No database to retire. The next start will begin first-run setup.');
  process.exit(0);
}

// A full backup before touching anything.
const backups = path.join(dataDirectory, 'backups');
await mkdir(backups, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const backup = path.join(backups, `before-go-live-${stamp}.sqlite`);
const db = new DatabaseSync(live, { readOnly: true });
try {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const requests = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  console.log(`Current database holds ${users} account(s) and ${requests} request(s).`);
  db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
} finally {
  db.close();
}
console.log(`Backed up to: ${backup}`);

// Archive the live database and its write-ahead files out of the way.
const archive = path.join(dataDirectory, `retired-${stamp}`);
await mkdir(archive, { recursive: true });
for (const name of await readdir(dataDirectory)) {
  if (name.startsWith('finance.sqlite')) await rename(path.join(dataDirectory, name), path.join(archive, name));
}
console.log(`Previous database archived in: ${archive}`);
console.log(`
Done. Start the service and it will print a one-time setup code:

  npm run dev

Open the address it prints, enter the code, and create the real administrator account.
Then, as that administrator:
  1. Settings - set the company name, numbering formats and the two approvers
  2. Settings - review the accounting categories against your chart of accounts
  3. Settings - add the maker's account
  4. Petty Cash Fund - open the fund with its real opening balance
`);
