import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { addUser, login, session, logout, changePassword, resetPassword, setDisabled, listUsers, passwordHash, SESSION_COOKIE } from '../src/auth.mjs';

const PASSWORD = 'a-strong-test-password';
const cookie = token => `${SESSION_COOKIE}=${token}`;

async function withAdmin() {
  const store = new Store();
  const admin = await addUser(store, { username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', role: 'admin', password: PASSWORD });
  return { store, admin };
}

test('the first account must be an administrator and setup closes afterwards', async () => {
  const store = new Store();
  await assert.rejects(addUser(store, { username: 'maker1', fullName: 'Ana', email: 'maker1@example.test', role: 'maker', password: PASSWORD }), /first account must be an administrator/);
  await addUser(store, { username: 'admin', fullName: 'Admin', email: 'admin@example.test', role: 'admin', password: PASSWORD });
  await assert.rejects(addUser(store, { username: 'admin2', fullName: 'Admin2', email: 'admin2@example.test', role: 'admin', password: PASSWORD }), /already complete/);
  store.close();
});

test('only an administrator creates accounts, and usernames are unique', async () => {
  const { store, admin } = await withAdmin();
  const maker = await addUser(store, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker', password: PASSWORD }, admin);
  assert.equal(maker.role, 'maker');
  await assert.rejects(addUser(store, { username: 'nope1', fullName: 'X', email: 'nope1@example.test', role: 'maker', password: PASSWORD }, maker), /permission/);
  await assert.rejects(addUser(store, { username: 'MAKER1', fullName: 'Clash', email: 'MAKER1@example.test', role: 'maker', password: PASSWORD }, admin), /already exists/);
  await assert.rejects(addUser(store, { username: 'shorty', fullName: 'S', email: 'shorty@example.test', role: 'maker', password: 'tooshort' }, admin), /at least 12 characters/);
  await assert.rejects(addUser(store, { username: 'bad user', fullName: 'B', role: 'maker', password: PASSWORD }, admin), /Usernames use/);
  await assert.rejects(addUser(store, { username: 'nobody', fullName: 'N', email: 'nobody@example.test', role: 'wizard', password: PASSWORD }, admin), /role/);
  assert.equal(listUsers(store, admin).length, 2);
  assert.throws(() => listUsers(store, maker), /permission/);
  store.close();
});

test('sign-in issues a session that carries the role, and a wrong password never does', async () => {
  const { store } = await withAdmin();
  await assert.rejects(login(store, 'admin', 'wrong-password-x', 'k1'), /Incorrect username or password/);
  await assert.rejects(login(store, 'ghost', PASSWORD, 'k2'), /Incorrect username or password/);
  const auth = await login(store, 'admin', PASSWORD, 'k3');
  assert.equal(auth.user.role, 'admin');
  assert.match(auth.token, /^[a-f0-9]{64}$/);
  const live = session(store, cookie(auth.token));
  assert.equal(live.user.username, 'admin');
  assert.equal(live.csrf, auth.csrf);
  assert.equal(session(store, cookie('not-a-token')), null);
  assert.equal(session(store, ''), null);
  assert.equal(session(store, cookie('f'.repeat(64))), null);
  logout(store, live.tokenHash);
  assert.equal(session(store, cookie(auth.token)), null);
  store.close();
});

test('a session dies when it expires or its account is disabled', async () => {
  const { store, admin } = await withAdmin();
  const maker = await addUser(store, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker', password: PASSWORD }, admin);
  const auth = await login(store, 'maker1', PASSWORD, 'k1');
  assert.ok(session(store, cookie(auth.token)));
  setDisabled(store, admin, maker.id, true);
  assert.equal(session(store, cookie(auth.token)), null, 'disabling signs the account out everywhere');
  await assert.rejects(login(store, 'maker1', PASSWORD, 'k2'), /Incorrect username or password/);
  setDisabled(store, admin, maker.id, false);
  const back = await login(store, 'maker1', PASSWORD, 'k3');
  store.run('UPDATE sessions SET expires = ? WHERE token_hash IS NOT NULL', Date.now() - 1000);
  assert.equal(session(store, cookie(back.token)), null, 'an expired session is refused');
  assert.throws(() => setDisabled(store, admin, admin.id, true), /your own account/);
  store.close();
});

test('changing a password requires the current one and ends every session', async () => {
  const { store } = await withAdmin();
  const auth = await login(store, 'admin', PASSWORD, 'k1');
  const user = session(store, cookie(auth.token)).user;
  await assert.rejects(changePassword(store, user, 'not-my-password', 'another-strong-password'), /current password is incorrect/);
  await assert.rejects(changePassword(store, user, PASSWORD, 'short'), /at least 12/);
  const result = await changePassword(store, user, PASSWORD, 'another-strong-password');
  assert.equal(result.signInAgain, true);
  assert.equal(session(store, cookie(auth.token)), null);
  await assert.rejects(login(store, 'admin', PASSWORD, 'k2'), /Incorrect/);
  assert.ok(await login(store, 'admin', 'another-strong-password', 'k3'));
  store.close();
});

test('an administrator can reset a password without ever learning the old one', async () => {
  const { store, admin } = await withAdmin();
  const maker = await addUser(store, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker', password: PASSWORD }, admin);
  await assert.rejects(resetPassword(store, maker, maker.id, 'issued-by-the-admin'), /permission/);
  await assert.rejects(resetPassword(store, admin, maker.id, 'short'), /at least 12/);
  await resetPassword(store, admin, maker.id, 'issued-by-the-admin');
  await assert.rejects(login(store, 'maker1', PASSWORD, 'k1'), /Incorrect/);
  assert.ok(await login(store, 'maker1', 'issued-by-the-admin', 'k2'));
  assert.ok(store.history('user', maker.id).some(entry => entry.action === 'password-reset'));
  await assert.rejects(resetPassword(store, admin, '00000000-0000-4000-8000-000000000000', 'issued-by-the-admin'), /not found/);
  store.close();
});

test('passwords are salted, never stored in the clear, and repeated guesses are throttled', async () => {
  const { store } = await withAdmin();
  const stored = store.get('SELECT password_hash FROM users WHERE username = ?', 'admin').password_hash;
  assert.doesNotMatch(stored, new RegExp(PASSWORD));
  assert.match(stored, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(await passwordHash(PASSWORD), await passwordHash(PASSWORD), 'a fresh salt each time');
  let blocked = false;
  for (let attempt = 0; attempt < 12 && !blocked; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    await login(store, 'admin', 'wrong-password-x', 'client-key').catch(error => { blocked = error.status === 429; });
  }
  assert.ok(blocked, 'the account locks before a twelfth guess');
  store.close();
});
