import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { userSchema, userUpdateSchema, resetRequestSchema, resetRedeemSchema } from './schema.mjs';
import { send, resetEmail, mailSettings } from './mailer.mjs';
import { AppError, permit, found } from './errors.mjs';

const scrypt = promisify(scryptCallback);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const SESSION_HOURS = 8;
export const SESSION_COOKIE = 'fr_session';

export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
const equal = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
export const shapeUser = row => ({ id: row.id, username: row.username, fullName: row.full_name, email: row.email || '', role: row.role, disabled: !!row.disabled });
export const RESET_MINUTES = 60;

const WATCHER = { id: 'system', fullName: 'System', role: 'admin' };

export function checkLimit(store, key, maximum = 10, describe = '') {
  const now = Date.now();
  store.run('DELETE FROM login_limits WHERE until_ms < ?', now);
  const row = store.get('SELECT * FROM login_limits WHERE key = ?', key);
  if (row && row.attempts >= maximum) throw new AppError('Too many attempts. Try again in 15 minutes.', 429);
  store.run('INSERT INTO login_limits VALUES(?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1', key, now + 900000);
  // Logged once, as the limit is reached, rather than on every blocked attempt afterwards -
  // otherwise an attacker could fill the history by being blocked repeatedly.
  if (describe && row && row.attempts + 1 === maximum) {
    store.log(WATCHER, 'rate-limit', 'security', key, { detail: `${describe} reached ${maximum} failed attempts and is blocked for 15 minutes` });
  }
}

export async function addUser(store, input, actor = null) {
  const value = userSchema.parse(input);
  if (actor) permit(actor, ['admin']);
  const hash = await passwordHash(value.password);
  return store.transaction(() => {
    const count = store.get('SELECT COUNT(*) AS n FROM users').n;
    if (!actor && count) throw new AppError('Initial setup is already complete.', 409);
    if (!actor && value.role !== 'admin') throw new AppError('The first account must be an administrator.');
    if (store.get('SELECT id FROM users WHERE username = ?', value.username)) throw new AppError('That username already exists.', 409);
    if (store.get('SELECT id FROM users WHERE email = ?', value.email)) throw new AppError(`${value.email} is already registered to another account.`, 409);
    const user = { id: randomUUID(), username: value.username, fullName: value.fullName, email: value.email, role: value.role, disabled: false };
    store.run('INSERT INTO users(id, username, full_name, email, password_hash, role) VALUES(?,?,?,?,?,?)', user.id, user.username, user.fullName, user.email, hash, user.role);
    store.log(actor || user, 'create', 'user', user.id, { detail: `Account ${user.username} registered as ${user.role} for ${user.email}`, after: user });
    return user;
  });
}

export async function login(store, username, password, clientKey) {
  // Three tiers rather than one. The tight limit is on a source attacking a particular
  // account, which is what a real guessing attempt looks like. The per-account limit is
  // deliberately loose, because a strict one lets anybody who knows a username lock its owner
  // out - the attacker needs no password at all for that. The loose limit still stops a
  // distributed attempt, at the price of being far more effort to abuse as a nuisance.
  const name = String(username).trim().toLowerCase();
  const accountKey = `account:${name}`;
  const pairKey = `pair:${name}:${clientKey}`;
  checkLimit(store, clientKey, 50, `Sign-in from ${clientKey}`);
  checkLimit(store, pairKey, 10, `Sign-in from ${clientKey} against "${name}"`);
  checkLimit(store, accountKey, 100, `Sign-in against "${name}" from many sources`);
  // The registered address is an identity in its own right: an administrator hands out an
  // email, and that is what the holder signs in with. An address nobody registered matches
  // nothing here, which is what keeps unregistered people out.
  const identifier = String(username).trim();
  const row = store.get("SELECT * FROM users WHERE username = ? OR (email <> '' AND email = ?)", identifier, identifier.toLowerCase());
  // A missing account still costs one scrypt so timing does not reveal which usernames exist.
  const stored = row?.password_hash || `${'0'.repeat(32)}:${'0'.repeat(128)}`;
  const computed = await passwordHash(password, stored.split(':')[0]);
  if (!equal(stored, computed) || !row || row.disabled) throw new AppError('Incorrect username or password.', 401);
  // A correct password clears this source's and this account's counters.
  store.run('DELETE FROM login_limits WHERE key IN (?, ?, ?)', accountKey, pairKey, clientKey);
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  store.run('DELETE FROM sessions WHERE expires < ?', Date.now());
  store.run('INSERT INTO sessions VALUES(?, ?, ?, ?)', hashToken(token), row.id, csrf, Date.now() + SESSION_HOURS * 3600000);
  store.log(shapeUser(row), 'sign-in', 'user', row.id, { detail: 'Signed in' });
  return { token, csrf, user: shapeUser(row) };
}

export function session(store, cookie = '') {
  const token = String(cookie).split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = store.get(`SELECT s.csrf, s.expires, u.id, u.username, u.full_name, u.email, u.role, u.disabled
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, hashToken(token));
  if (!row || row.disabled || row.expires < Date.now()) return null;
  return { user: shapeUser(row), csrf: row.csrf, tokenHash: hashToken(token) };
}
export const logout = (store, tokenHash) => store.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);

export async function changePassword(store, user, currentPassword, newPassword) {
  const row = found(store.get('SELECT * FROM users WHERE id = ?', user.id), 'Account');
  const computed = await passwordHash(currentPassword, row.password_hash.split(':')[0]);
  if (!equal(row.password_hash, computed)) throw new AppError('Your current password is incorrect.', 401);
  if (newPassword.length < 12) throw new AppError('Use a new password of at least 12 characters.');
  const hash = await passwordHash(newPassword);
  store.transaction(() => {
    if (store.get('SELECT password_hash FROM users WHERE id = ?', user.id).password_hash !== row.password_hash) throw new AppError('The account changed during this request. Sign in again.', 409);
    store.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, user.id);
    store.run('DELETE FROM sessions WHERE user_id = ?', user.id);
    store.log(user, 'password-change', 'user', user.id, { detail: 'Password changed' });
  });
  return { ok: true, signInAgain: true };
}

export async function resetPassword(store, actor, id, newPassword) {
  permit(actor, ['admin']);
  if (String(newPassword).length < 12) throw new AppError('Use a password of at least 12 characters.');
  const hash = await passwordHash(newPassword);
  return store.transaction(() => {
    const row = found(store.get('SELECT * FROM users WHERE id = ?', id), 'Account');
    store.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, id);
    store.run('DELETE FROM sessions WHERE user_id = ?', id);
    store.log(actor, 'password-reset', 'user', id, { detail: `Password reset for ${row.username}. Hand the new password to them directly.` });
    return { ok: true };
  });
}

export function setDisabled(store, actor, id, disabled) {
  permit(actor, ['admin']);
  if (id === actor.id) throw new AppError('You cannot disable your own account.');
  return store.transaction(() => {
    const row = found(store.get('SELECT * FROM users WHERE id = ?', id), 'Account');
    store.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
    store.run('DELETE FROM sessions WHERE user_id = ?', id);
    store.log(actor, disabled ? 'disable-account' : 'enable-account', 'user', id, { detail: `${row.username} ${disabled ? 'disabled' : 're-enabled'}` });
    return { ok: true };
  });
}

export function listUsers(store, actor) {
  permit(actor, ['admin']);
  return store.all('SELECT * FROM users ORDER BY username').map(shapeUser);
}

// ---------------------------------------------------------------- account maintenance

export function updateUser(store, actor, id, input) {
  permit(actor, ['admin']);
  const value = userUpdateSchema.parse(input);
  return store.transaction(() => {
    const before = shapeUser(found(store.get('SELECT * FROM users WHERE id = ?', id), 'Account'));
    const clash = store.get('SELECT id FROM users WHERE email = ? AND id <> ?', value.email, id);
    if (clash) throw new AppError(`${value.email} is already registered to another account.`, 409);
    // Usernames are compared without regard to case, as the column itself is, so "Angela" and
    // "angela" cannot both exist.
    const taken = store.get('SELECT id FROM users WHERE username = ? AND id <> ?', value.username, id);
    if (taken) throw new AppError(`The username ${value.username} is already taken.`, 409);
    if (before.role === 'admin' && value.role !== 'admin' && store.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n < 2) {
      throw new AppError('This is the only administrator. Register another one before changing this role.');
    }
    // Nothing anywhere is filed under the username - requests, the ledger and the history all
    // key on the account's id - so renaming is a label change and carries no history with it.
    store.run('UPDATE users SET username = ?, full_name = ?, email = ?, role = ? WHERE id = ?',
      value.username, value.fullName, value.email, value.role, id);
    const after = shapeUser(store.get('SELECT * FROM users WHERE id = ?', id));
    const changed = Object.keys(after).filter(key => before[key] !== after[key]);
    store.log(actor, 'update', 'user', id, { detail: `Account ${after.username} updated: ${changed.map(k => `${k} "${before[k]}" to "${after[k]}"`).join('; ') || 'no change'}`, before, after });
    return after;
  });
}

// ---------------------------------------------------------------- password reset by email

const resetLink = (store, token) => `${store.config().appUrl || ''}/?reset=${token}`;

function issueReset(store, userId) {
  const token = randomBytes(32).toString('hex');
  store.run('DELETE FROM password_resets WHERE user_id = ? OR expires < ?', userId, Date.now());
  store.run('INSERT INTO password_resets(token_hash, user_id, expires, created_at) VALUES(?,?,?,?)',
    hashToken(token), userId, Date.now() + RESET_MINUTES * 60000, new Date().toISOString());
  return token;
}

async function mailReset(store, row, token) {
  const link = resetLink(store, token);
  const result = await send({ to: row.email, ...resetEmail({ companyName: store.config().companyName, fullName: row.full_name, link, minutes: RESET_MINUTES }) });
  return { ...result, link };
}

// Anyone may ask, so the answer never reveals whether an address is registered.
export async function requestPasswordReset(store, input) {
  const value = resetRequestSchema.parse(input);
  const identifier = value.identifier.trim();
  const row = store.get("SELECT * FROM users WHERE (username = ? OR (email <> '' AND email = ?)) AND disabled = 0", identifier, identifier.toLowerCase());
  const answer = { message: 'If that account is registered, a reset link is on its way to the address on file. Ask your administrator if nothing arrives.' };
  if (!row || !row.email) return answer;
  const token = store.transaction(() => {
    const issued = issueReset(store, row.id);
    store.log(shapeUser(row), 'password-reset-requested', 'user', row.id, { detail: `Reset link sent to ${row.email}` });
    return issued;
  });
  await mailReset(store, row, token);
  return answer;
}

// The administrator can send it on someone's behalf. If mail is not configured they are given
// the link to hand over, rather than being told it was sent when it was not.
export async function sendPasswordReset(store, actor, id) {
  permit(actor, ['admin']);
  const row = found(store.get('SELECT * FROM users WHERE id = ?', id), 'Account');
  if (!row.email) throw new AppError('Register an email address on this account first.');
  const token = store.transaction(() => {
    const issued = issueReset(store, row.id);
    store.log(actor, 'password-reset-sent', 'user', row.id, { detail: `Reset link issued for ${row.email}` });
    return issued;
  });
  const result = await mailReset(store, row, token);
  return result.sent
    ? { sent: true, message: `A reset link has been emailed to ${row.email}. It expires in ${RESET_MINUTES} minutes.` }
    : { sent: false, link: result.link, message: `Email is not configured (${result.reason}), so nothing was sent. Give this one-time link to ${row.full_name} directly. It expires in ${RESET_MINUTES} minutes.` };
}

export async function redeemPasswordReset(store, input) {
  const value = resetRedeemSchema.parse(input);
  const hash = await passwordHash(value.password);
  return store.transaction(() => {
    const reset = store.get('SELECT * FROM password_resets WHERE token_hash = ?', hashToken(value.token));
    if (!reset || reset.expires < Date.now()) throw new AppError('That reset link has expired or has already been used. Ask for a new one.', 410);
    const row = found(store.get('SELECT * FROM users WHERE id = ?', reset.user_id), 'Account');
    if (row.disabled) throw new AppError('That account is disabled.', 403);
    store.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.id);
    // The link is single use, and every existing session on the account ends.
    store.run('DELETE FROM password_resets WHERE user_id = ?', row.id);
    store.run('DELETE FROM sessions WHERE user_id = ?', row.id);
    store.log(shapeUser(row), 'password-reset', 'user', row.id, { detail: 'Password set from an emailed reset link' });
    return { ok: true, username: row.username };
  });
}

export const mailConfigured = () => mailSettings().configured;
