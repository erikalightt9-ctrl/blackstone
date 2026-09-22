import test from 'node:test';
import assert from 'node:assert/strict';
import { loopbackOrigins, clientAddress } from '../src/server.mjs';

test('both spellings of a loopback origin are accepted, and nothing else is', () => {
  const allowed = loopbackOrigins('http://127.0.0.1:3403');
  assert.ok(allowed.has('http://127.0.0.1:3403'));
  assert.ok(allowed.has('http://localhost:3403'));
  assert.ok(allowed.has('http://[::1]:3403'));
  assert.ok(!allowed.has('http://localhost:3404'), 'a different port is a different origin');
  assert.ok(!allowed.has('https://localhost:3403'), 'a different scheme is a different origin');
  assert.ok(!allowed.has('http://attacker.example'));
  assert.ok(!allowed.has(undefined));
});

test('a hosted origin is never widened to loopback', () => {
  const allowed = loopbackOrigins('https://finance.example.com');
  assert.deepEqual([...allowed], ['https://finance.example.com']);
  assert.ok(!allowed.has('http://localhost:3403'));
  assert.ok(!allowed.has('http://127.0.0.1:3403'));
});

test('extra origins let one server answer to its hostname and its address', () => {
  const allowed = loopbackOrigins('https://finance-pc', 'https://192.168.1.10, https://finance.local');
  assert.ok(allowed.has('https://finance-pc'));
  assert.ok(allowed.has('https://192.168.1.10'));
  assert.ok(allowed.has('https://finance.local'));
  assert.ok(!allowed.has('https://192.168.1.11'), 'only the names actually listed');
  assert.ok(!allowed.has('http://finance-pc'), 'and only over the scheme they were listed with');
});

test('a malformed extra origin is refused at startup rather than silently ignored', () => {
  assert.throws(() => loopbackOrigins('https://finance-pc', 'finance-pc'), /scheme:\/\/host/);
  assert.throws(() => loopbackOrigins('https://finance-pc', 'https://finance-pc/finance'), /scheme:\/\/host/);
  assert.deepEqual([...loopbackOrigins('https://finance-pc', '')], ['https://finance-pc']);
});

test('the client address is only taken from headers when a proxy is declared', () => {
  const req = headers => ({ headers, socket: { remoteAddress: '127.0.0.1' } });
  const spoofed = req({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' });

  assert.equal(clientAddress(spoofed), '127.0.0.1', 'headers are ignored by default, so they cannot be spoofed');
  assert.equal(clientAddress(spoofed, true), '5.6.7.8', "Cloudflare's own header wins when a proxy is declared");
  assert.equal(clientAddress(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), true), '1.2.3.4', 'the originating client, not the hops');
  assert.equal(clientAddress(req({}), true), '127.0.0.1', 'falls back to the socket when nothing is forwarded');
  assert.equal(clientAddress(req({ 'x-forwarded-for': '   ' }), true), '127.0.0.1');
  assert.equal(clientAddress({ headers: {}, socket: {} }, true), 'unknown');
});
