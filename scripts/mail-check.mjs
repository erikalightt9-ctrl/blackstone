// Checks the outgoing mail settings by actually sending one message, and says plainly whether
// it worked. Nothing here prints the password - only whether one is present and how long it is,
// which is enough to spot an empty or half-pasted value without putting a secret in a terminal.
//
//   node scripts/mail-check.mjs             sends to FR_MAIL_FROM
//   node scripts/mail-check.mjs you@there   sends somewhere else
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../src/env.mjs';
import { mailSettings, send } from '../src/mailer.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const loaded = loadEnvFile(path.join(directory, '../.env'));
if (loaded.length) console.log(`Read from .env: ${loaded.join(', ')}\n`);

const settings = mailSettings();
if (!settings.configured) {
  console.error(`Mail is not configured: ${settings.reason}.

Copy .env.example to .env and fill it in, then run this again.`);
  process.exit(1);
}

console.log('Settings found:');
console.log(`  from     ${settings.from}`);
if (settings.url) {
  console.log('  url      (FR_SMTP_URL is set)');
} else {
  console.log(`  host     ${settings.options.host}:${settings.options.port}`);
  console.log(`  security ${settings.options.secure ? 'TLS from the first byte' : 'STARTTLS'}`);
  console.log(`  user     ${settings.options.auth?.user || '(none - sending unauthenticated)'}`);
  const pass = settings.options.auth?.pass || '';
  console.log(`  password ${pass ? `set, ${pass.length} characters` : 'NOT SET'}`);
  if (pass && /\s/.test(pass)) console.log('           note: it contains a space. Google app passwords are usually pasted without them.');
}

const to = (process.argv[2] || settings.from).trim();
console.log(`\nSending a test message to ${to} ...`);
const result = await send({
  to,
  subject: 'Financial Monitoring - mail is working',
  text: 'If you are reading this, password reset links will now be delivered by email.\n\nNothing else about this message matters; it exists only to prove the settings are right.',
});

if (result.sent) {
  console.log(`\nSent. Check ${to} - including the spam folder the first time.`);
} else {
  console.error(`\nNot sent: ${result.reason}`);
  console.error(`
Common causes:
  - "Invalid login"       the password is not an app password, or has been revoked
  - "Username and Password not accepted"   two-factor is on and the account's own
                          password was used instead of an app password
  - connection timed out  the port is blocked, or the host name is wrong
`);
  process.exit(1);
}
