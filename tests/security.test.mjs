import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { addUser, login, checkLimit } from '../src/auth.mjs';
import { clientAddress, trustedProxies } from '../src/server.mjs';

// Properties that must not quietly regress. Each of these was a real finding.

const PASSWORD = 'a-genuinely-strong-password';

async function withAdmin() {
  const store = new Store();
  await addUser(store, { username: 'erika', fullName: 'Erika Hernando', email: 'e@example.com', role: 'admin', password: PASSWORD });
  return store;
}

test('somebody who knows a username cannot lock its owner out', async () => {
  const store = await withAdmin();
  // A username is not a secret - this one is in the seed script, and staff names are guessable.
  // Locking an account on failures alone would hand anyone a way to shut the books, needing
  // no password whatsoever.
  for (let attempt = 1; attempt <= 40; attempt++) {
    await assert.rejects(() => login(store, 'erika', `guess-${attempt}`, `client:203.0.113.${attempt}`));
  }
  const session = await login(store, 'erika', PASSWORD, 'client:198.51.100.7');
  assert.equal(session.user.username, 'erika', 'the owner still gets in');
  store.close();
});

test('but guessing from one source is stopped quickly, and does not touch the owner', async () => {
  const store = await withAdmin();
  let blockedAfter = null;
  for (let attempt = 1; attempt <= 15; attempt++) {
    try { await login(store, 'erika', `guess-${attempt}`, 'client:203.0.113.9'); } catch (error) {
      if (/Too many attempts/.test(error.message) && !blockedAfter) blockedAfter = attempt;
    }
  }
  assert.ok(blockedAfter && blockedAfter <= 11, `blocked after ${blockedAfter} attempts from one source`);
  // Meanwhile the real owner, from her own machine, is unaffected.
  assert.equal((await login(store, 'erika', PASSWORD, 'client:198.51.100.7')).user.role, 'admin');
  store.close();
});

test('a sustained attempt is written to the history, once, not on every blocked try', async () => {
  const store = await withAdmin();
  for (let attempt = 1; attempt <= 25; attempt++) {
    try { await login(store, 'erika', `guess-${attempt}`, 'client:203.0.113.9'); } catch { /* expected */ }
  }
  const alerts = store.all("SELECT * FROM audit WHERE action = 'rate-limit'");
  assert.ok(alerts.length >= 1, 'the lockout is on the record');
  assert.ok(alerts.length <= 3, `and cannot be used to flood the history (${alerts.length} rows from 25 attempts)`);
  assert.match(alerts[0].detail, /failed attempts and is blocked/);
  store.close();
});

test('a forwarded address is believed only when the proxy is this machine', () => {
  const request = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });

  // Caddy and the Cloudflare tunnel both connect over loopback, so their header is the truth.
  assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '9.9.9.9' }), true), '9.9.9.9');
  assert.equal(clientAddress(request('::1', { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }), true), '9.9.9.9');

  // The same header from someone reaching the port directly is a forgery, and ignoring it is
  // what keeps the per-source limits meaningful.
  assert.equal(clientAddress(request('203.0.113.50', { 'cf-connecting-ip': '9.9.9.9' }), true), '203.0.113.50');
  assert.equal(clientAddress(request('203.0.113.50', { 'x-forwarded-for': '8.8.8.8' }), true), '203.0.113.50');

  // And with trust switched off, nothing is taken from a header at all.
  assert.equal(clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '9.9.9.9' }), false), '127.0.0.1');
});

test('in a container, the proxy is believed by its own address and nothing else is', () => {
  const request = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
  const trusted = trustedProxies('172.28.0.2');

  // Caddy in its own container, as IPv4 or as Node reports it on a dual-stack socket.
  assert.equal(clientAddress(request('172.28.0.2', { 'x-forwarded-for': '9.9.9.9' }), true, trusted), '9.9.9.9');
  assert.equal(clientAddress(request('::ffff:172.28.0.2', { 'x-forwarded-for': '9.9.9.9' }), true, trusted), '9.9.9.9');
  // Loopback is still trusted, so an office install behaves exactly as before.
  assert.equal(clientAddress(request('127.0.0.1', { 'x-forwarded-for': '9.9.9.9' }), true, trusted), '9.9.9.9');
  // A neighbour on the same Docker network is not the proxy, and its header is a forgery.
  assert.equal(clientAddress(request('172.28.0.3', { 'x-forwarded-for': '9.9.9.9' }), true, trusted), '172.28.0.3');

  assert.throws(() => trustedProxies('172.28.0.0/16'), /must be IP addresses/);
  assert.throws(() => trustedProxies('caddy'), /must be IP addresses/);
});

test('an absurd forwarded value cannot be used to bloat the limits table', () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': 'x'.repeat(5000) } };
  assert.ok(clientAddress(request, true).length <= 64);
});

test('the limiter still blocks, and says when to come back', () => {
  const store = new Store();
  for (let attempt = 1; attempt <= 10; attempt++) checkLimit(store, 'thing', 10);
  assert.throws(() => checkLimit(store, 'thing', 10), /Too many attempts. Try again in 15 minutes./);
  store.close();
});
