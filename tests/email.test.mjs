import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { addUser, login, session, updateUser, listUsers, requestPasswordReset, sendPasswordReset, redeemPasswordReset, SESSION_COOKIE } from '../src/auth.mjs';
import { mailSettings, resetEmail } from '../src/mailer.mjs';

const PASSWORD = 'a-strong-test-password';
const cookie = token => `${SESSION_COOKIE}=${token}`;

async function office() {
  const store = new Store();
  store.setConfig('appUrl', 'https://finance.example.test');
  const admin = await addUser(store, { username: 'erika', fullName: 'Erika Hernando', email: 'erika@example.com', role: 'admin', password: PASSWORD });
  const maker = await addUser(store, { username: 'maker', fullName: 'Angela Din', email: 'angela.din@example.com', role: 'maker', password: PASSWORD }, admin);
  return { store, admin, maker };
}
// The one-time link is never returned to the requester, so tests read it the way the holder
// would: out of the message that was addressed to them.
const linkFor = store => store.get("SELECT token_hash FROM password_resets ORDER BY created_at DESC LIMIT 1");

test('an account cannot be registered without a valid, unique email address', async () => {
  const { store, admin } = await office();
  await assert.rejects(addUser(store, { username: 'one', fullName: 'X', role: 'maker', password: PASSWORD }, admin), /email/);
  await assert.rejects(addUser(store, { username: 'two', fullName: 'X', email: 'not-an-address', role: 'maker', password: PASSWORD }, admin), /valid email/);
  await assert.rejects(addUser(store, { username: 'tri', fullName: 'X', email: 'nope@nodot', role: 'maker', password: PASSWORD }, admin), /valid email/);
  await assert.rejects(addUser(store, { username: 'fou', fullName: 'X', email: 'ERIKA@example.com', role: 'maker', password: PASSWORD }, admin), /already registered/);
  assert.equal(listUsers(store, admin).length, 2);
  store.close();
});

test('the registered email is an identity: it signs in, and an unregistered one never does', async () => {
  const { store } = await office();
  const byEmail = await login(store, 'angela.din@example.com', PASSWORD, 'k1');
  assert.equal(byEmail.user.username, 'maker');
  assert.equal(byEmail.user.email, 'angela.din@example.com');
  const shouted = await login(store, 'ANGELA.DIN@EXAMPLE.COM', PASSWORD, 'k2');
  assert.equal(shouted.user.username, 'maker', 'the address is not case sensitive');
  assert.equal((await login(store, 'maker', PASSWORD, 'k3')).user.username, 'maker', 'the username still works');
  await assert.rejects(login(store, 'stranger@example.com', PASSWORD, 'k4'), /Incorrect username or password/);
  assert.equal(session(store, cookie(byEmail.token)).user.email, 'angela.din@example.com', 'the session carries it');
  store.close();
});

test('only an administrator changes the registry, and never to a duplicate', async () => {
  const { store, admin, maker } = await office();
  assert.throws(() => updateUser(store, { id: maker.id, role: 'maker' }, maker.id, { username: 'maker', fullName: 'Angela Din', email: 'other@example.com', role: 'maker' }), /permission/);
  const updated = updateUser(store, admin, maker.id, { username: 'maker', fullName: 'Angela D. Din', email: 'angela@example.com', role: 'maker' });
  assert.equal(updated.email, 'angela@example.com');
  assert.equal(updated.fullName, 'Angela D. Din');
  assert.equal((await login(store, 'angela@example.com', PASSWORD, 'k1')).user.username, 'maker', 'the new address signs in');
  await assert.rejects(login(store, 'angela.din@example.com', PASSWORD, 'k2'), /Incorrect/, 'the old one no longer does');
  assert.throws(() => updateUser(store, admin, maker.id, { username: 'maker', fullName: 'X', email: 'erika@example.com', role: 'maker' }), /already registered/);
  const updates = store.history('user', maker.id).filter(entry => entry.action === 'update');
  assert.equal(updates.length, 1, 'only the change that succeeded was recorded');
  assert.match(updates[0].detail, /email "angela.din@example.com" to "angela@example.com"/);
  assert.match(updates[0].detail, /fullName "Angela Din" to "Angela D. Din"/);
  store.close();
});

test('the last administrator cannot be demoted into locking everyone out', async () => {
  const { store, admin } = await office();
  assert.throws(() => updateUser(store, admin, admin.id, { username: 'erika', fullName: 'Erika Hernando', email: 'erika@example.com', role: 'maker' }), /only administrator/);
  await addUser(store, { username: 'second', fullName: 'Second Admin', email: 'second@example.com', role: 'admin', password: PASSWORD }, admin);
  const demoted = updateUser(store, admin, admin.id, { username: 'erika', fullName: 'Erika Hernando', email: 'erika@example.com', role: 'approver' });
  assert.equal(demoted.role, 'approver', 'with a second administrator in place it is allowed');
  store.close();
});

test('a reset link sets a new password once and ends every existing session', async () => {
  const { store, admin, maker } = await office();
  const signedIn = await login(store, 'maker', PASSWORD, 'k1');
  assert.ok(session(store, cookie(signedIn.token)));

  const issued = await sendPasswordReset(store, admin, maker.id);
  assert.equal(issued.sent, false, 'mail is not configured in the test environment');
  assert.match(issued.message, /not configured/);
  assert.match(issued.link, /^https:\/\/finance\.example\.test\/\?reset=[a-f0-9]{64}$/);
  const token = new URL(issued.link).searchParams.get('reset');

  const result = await redeemPasswordReset(store, { token, password: 'a-brand-new-password' });
  assert.equal(result.username, 'maker');
  assert.equal(session(store, cookie(signedIn.token)), null, 'the old session is gone');
  await assert.rejects(login(store, 'maker', PASSWORD, 'k2'), /Incorrect/);
  assert.equal((await login(store, 'maker', 'a-brand-new-password', 'k3')).user.username, 'maker');

  await assert.rejects(redeemPasswordReset(store, { token, password: 'yet-another-password' }), /expired or has already been used/);
  assert.match(store.history('user', maker.id).map(h => h.action).join(','), /password-reset-sent,password-reset/);
  store.close();
});

test('an expired or unknown link is refused, and so is a weak new password', async () => {
  const { store, admin, maker } = await office();
  const issued = await sendPasswordReset(store, admin, maker.id);
  const token = new URL(issued.link).searchParams.get('reset');
  await assert.rejects(redeemPasswordReset(store, { token, password: 'short' }), /at least 12/);
  await assert.rejects(redeemPasswordReset(store, { token: 'f'.repeat(64), password: PASSWORD }), /expired or has already been used/);
  await assert.rejects(redeemPasswordReset(store, { token: 'not-a-token', password: PASSWORD }), /not valid/);
  store.run('UPDATE password_resets SET expires = ?', Date.now() - 1000);
  await assert.rejects(redeemPasswordReset(store, { token, password: 'a-brand-new-password' }), /expired/);
  store.close();
});

test('asking for a reset says the same thing whether or not the address is registered', async () => {
  const { store } = await office();
  const known = await requestPasswordReset(store, { identifier: 'angela.din@example.com' });
  const unknown = await requestPasswordReset(store, { identifier: 'stranger@example.com' });
  assert.deepEqual(known, unknown, 'the reply cannot be used to discover which addresses exist');
  assert.match(known.message, /If that account is registered/);
  // A link was nonetheless issued for the real account, and none for the stranger.
  assert.equal(store.get('SELECT COUNT(*) AS n FROM password_resets').n, 1);
  store.close();
});

test('a disabled account is given no reset link', async () => {
  const { store, admin, maker } = await office();
  store.run('UPDATE users SET disabled = 1 WHERE id = ?', maker.id);
  await requestPasswordReset(store, { identifier: 'angela.din@example.com' });
  assert.equal(store.get('SELECT COUNT(*) AS n FROM password_resets').n, 0, 'nothing is issued');
  const issued = await sendPasswordReset(store, admin, maker.id);
  const token = new URL(issued.link).searchParams.get('reset');
  await assert.rejects(redeemPasswordReset(store, { token, password: 'a-brand-new-password' }), /disabled/, 'and a link cannot revive it');
  store.close();
});

test('mail settings are read from the environment and never guessed', () => {
  assert.equal(mailSettings({}).configured, false);
  assert.match(mailSettings({}).reason, /FR_MAIL_FROM/);
  assert.match(mailSettings({ FR_MAIL_FROM: 'a@b.co' }).reason, /FR_SMTP_URL nor FR_SMTP_HOST/);
  assert.equal(mailSettings({ FR_MAIL_FROM: 'a@b.co', FR_SMTP_URL: 'smtps://u:p@smtp.example:465' }).configured, true);

  const explicit = mailSettings({ FR_MAIL_FROM: 'a@b.co', FR_SMTP_HOST: 'smtp.example', FR_SMTP_USER: 'u', FR_SMTP_PASS: 'p' });
  assert.equal(explicit.options.port, 587, 'the submission port by default');
  assert.equal(explicit.options.secure, false, 'which upgrades with STARTTLS rather than starting encrypted');
  assert.equal(mailSettings({ FR_MAIL_FROM: 'a@b.co', FR_SMTP_HOST: 'h', FR_SMTP_PORT: '465' }).options.secure, true, 'port 465 is encrypted from the first byte');
  assert.equal(mailSettings({ FR_MAIL_FROM: 'a@b.co', FR_SMTP_HOST: 'h', FR_SMTP_PORT: '2525', FR_SMTP_SECURE: '1' }).options.secure, true, 'and it can be stated outright');
  assert.equal(mailSettings({ FR_MAIL_FROM: 'a@b.co', FR_SMTP_HOST: 'h' }).options.auth, undefined, 'no credentials means no auth attempt');
});

test('the reset email says what it is, links once, and gives the expiry', () => {
  const mail = resetEmail({ companyName: 'BLACK STONE MINERAL RESOURCES INC', fullName: 'Angela Din', link: 'https://finance.example.test/?reset=abc', minutes: 60 });
  assert.match(mail.subject, /BLACK STONE MINERAL RESOURCES INC - password reset/);
  assert.match(mail.text, /Hello Angela Din/);
  assert.match(mail.text, /https:\/\/finance\.example\.test\/\?reset=abc/);
  assert.match(mail.text, /works once and expires in 60 minutes/);
  assert.match(mail.text, /If you did not ask for this/);
  assert.doesNotMatch(mail.text, /password is/i, 'an existing password is never quoted back');
});

test('the stored token is a hash, so the database never holds a usable link', async () => {
  const { store, admin, maker } = await office();
  const issued = await sendPasswordReset(store, admin, maker.id);
  const token = new URL(issued.link).searchParams.get('reset');
  const stored = linkFor(store).token_hash;
  assert.notEqual(stored, token);
  assert.match(stored, /^[a-f0-9]{64}$/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?', token).n, 0);
  store.close();
});

test('an account can be renamed, but not onto a name already in use', async () => {
  const store = new Store();
  const admin = await addUser(store, { username: 'erika', fullName: 'Erika Hernando', email: 'erika@example.com', role: 'admin', password: 'a-strong-enough-password' });
  const maker = await addUser(store, { username: 'maker', fullName: 'Angela Din', email: 'angela@example.com', role: 'maker', password: 'a-strong-enough-password' }, admin);

  const renamed = updateUser(store, admin, maker.id, { username: 'angela', fullName: 'Angela Din', email: 'angela@example.com', role: 'maker' });
  assert.equal(renamed.username, 'angela');
  // Signing in follows the new name, and the old one matches nothing.
  assert.equal((await login(store, 'angela', 'a-strong-enough-password', 'c1')).user.id, maker.id);
  await assert.rejects(() => login(store, 'maker', 'a-strong-enough-password', 'c2'), /Incorrect username or password/);

  // Not a name somebody else already answers to, whatever the case it is typed in.
  assert.throws(() => updateUser(store, admin, maker.id, { username: 'ERIKA', fullName: 'Angela Din', email: 'angela@example.com', role: 'maker' }), /already taken/);
  assert.throws(() => updateUser(store, admin, maker.id, { username: 'ad', fullName: 'Angela Din', email: 'angela@example.com', role: 'maker' }), /at least three characters/);
  store.close();
});
