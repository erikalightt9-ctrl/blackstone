import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

const ORIGIN = 'http://127.0.0.1:3403';

async function serve(t) {
  const store = new Store();
  const app = createApp({ store, origin: ORIGIN, setupToken: 'test-only-setup-code' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const raw = (path, { method = 'GET', body, cookie = '', csrf = '', origin = ORIGIN } = {}) =>
    fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { store, raw };
}
async function account({ raw }, { username, fullName, role, password = 'strong-test-password' }, admin) {
  if (admin) {
    const created = await raw('/api/users', { method: 'POST', body: { username, fullName, email: `${username}@example.test`, role, password }, ...admin.auth });
    assert.equal(created.status, 201, `creating ${username}`);
  }
  const response = await raw('/api/login', { method: 'POST', body: { username, password } });
  assert.equal(response.status, 200, `signing in ${username}`);
  const data = await response.json();
  return { user: data.user, auth: { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrf } };
}
const json = async response => ({ status: response.status, body: await response.json() });

test('setup, sign-in, CSRF, origin and session revocation', async t => {
  const server = await serve(t);
  const { raw } = server;
  assert.equal((await raw('/api/bootstrap')).status, 401);
  assert.equal((await json(await raw('/api/session'))).body.setup, true);
  assert.equal((await raw('/api/setup', { method: 'POST', body: { token: 'wrong', username: 'admin', fullName: 'Admin', email: 'admin@example.test', password: 'strong-test-password' } })).status, 403);
  assert.equal((await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', password: 'strong-test-password' } })).status, 201);
  assert.equal((await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin2', fullName: 'Another', email: 'admin2@example.test', password: 'strong-test-password' } })).status, 409);
  const admin = await account(server, { username: 'admin' });
  assert.equal((await json(await raw('/api/session', admin.auth))).body.setup, false);
  assert.equal((await raw('/api/categories', { method: 'POST', body: { code: 'X', name: 'X' }, cookie: admin.auth.cookie })).status, 403, 'missing CSRF token');
  assert.equal((await raw('/api/categories', { method: 'POST', body: { code: 'X', name: 'X' }, ...admin.auth, origin: 'https://attacker.example' })).status, 403, 'cross-origin');
  assert.equal((await raw('/api/logout', { method: 'POST', ...admin.auth })).status, 200);
  assert.equal((await raw('/api/bootstrap', admin.auth)).status, 401, 'the session is revoked');
});

test('the static application and its assets are served', async t => {
  const { raw } = await serve(t);
  for (const asset of ['/', '/app.js', '/requests.js', '/pettycash.js', '/bank.js', '/reports.js', '/style.css', '/brand/logo.png', '/brand/mascot.png']) {
    assert.equal((await raw(asset)).status, 200, asset);
  }
  assert.equal((await raw('/../src/store.mjs')).status, 404);
  assert.equal((await raw('/api/nope', { cookie: '' })).status, 401);
});

test('a complete payment request travels the whole API, including both PDF copies', async t => {
  const server = await serve(t);
  const { raw } = server;
  await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', password: 'strong-test-password' } });
  const admin = await account(server, { username: 'admin' });
  const maker = await account(server, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker' }, admin);
  const approver = await account(server, { username: 'approver1', fullName: 'Carla Approver', email: 'approver1@example.test', role: 'approver' }, admin);
  const releaser = await account(server, { username: 'releaser1', fullName: 'Dina Releaser', email: 'releaser1@example.test', role: 'approver' }, admin);

  const bootstrap = (await json(await raw('/api/bootstrap', maker.auth))).body;
  assert.equal(bootstrap.config.defaultFinalApprover, 'Demry Cheng');
  assert.equal(bootstrap.canPrintAccountingCopy, false, 'a maker does not get the internal copy');
  const supplies = bootstrap.categories.find(c => c.code === 'OFFICE-SUPPLIES');

  const created = await json(await raw('/api/requests', { method: 'POST', ...maker.auth, body: {
    kind: 'payment', dateRequested: '2026-09-21', requestedBy: 'Ana Maker', payee: 'Metro Office Depot',
    purpose: 'Monthly office supplies', finalApprover: 'Vicente Cheng',
    lines: [{ particulars: 'Bond paper', quantity: 5, unitAmount: 100, categoryId: supplies.id }],
  } }));
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.number, 'PR-2026-000001');
  assert.equal(created.body.total, 500);

  assert.equal((await raw(`/api/requests/${id}/approve`, { method: 'POST', ...maker.auth, body: {} })).status, 403);
  assert.equal((await raw(`/api/requests/${id}/submit`, { method: 'POST', ...maker.auth, body: {} })).status, 200);
  assert.equal((await raw(`/api/requests/${id}/submit`, { method: 'POST', ...maker.auth, body: {} })).status, 409, 'the workflow refuses a repeat');
  assert.equal((await raw(`/api/requests/${id}/approve`, { method: 'POST', ...approver.auth, body: { remarks: 'Verified' } })).status, 200);
  assert.equal((await raw(`/api/requests/${id}/record-payment`, { method: 'POST', ...approver.auth, body: {} })).status, 404, 'the separate record-payment step is gone');

  const releaseBody = { method: 'Check', bank: 'BDO', checkNumber: '0012345', checkDate: '2026-09-22', amount: 500, payee: 'Metro Office Depot', datePrepared: '2026-09-22', dateReleased: '2026-09-23', receivedBy: 'Supplier courier', remarks: '' };
  assert.equal((await raw(`/api/requests/${id}/release`, { method: 'POST', ...maker.auth, body: releaseBody })).status, 403, 'a maker cannot release');
  const released = await json(await raw(`/api/requests/${id}/release`, { method: 'POST', ...releaser.auth, body: releaseBody }));
  assert.equal(released.body.status, 'paid');
  assert.deepEqual(released.body.history.map(h => h.action), ['create', 'submit', 'approve', 'release']);

  const makerView = (await json(await raw(`/api/requests/${id}`, maker.auth))).body;
  assert.equal(makerView.payment.checkNumber, '0012345', 'the maker can confirm the check details');

  const standard = await raw(`/api/requests/${id}/pdf`, maker.auth);
  assert.equal(standard.status, 200);
  assert.equal(standard.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await standard.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await raw(`/api/requests/${id}/pdf?copy=accounting`, maker.auth)).status, 403, 'the accounting copy is restricted');
  assert.equal((await raw(`/api/requests/${id}/pdf?copy=accounting`, releaser.auth)).status, 200);

  const dashboard = (await json(await raw('/api/dashboard', admin.auth))).body;
  assert.equal(dashboard.payment.count.paid, 1);
  assert.equal(dashboard.payment.amount.paid, 500);
});

test('the petty cash fund, ledger and replenishment run over HTTP', async t => {
  const server = await serve(t);
  const { raw } = server;
  await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', password: 'strong-test-password' } });
  const admin = await account(server, { username: 'admin' });
  const maker = await account(server, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker' }, admin);
  const approver = await account(server, { username: 'approver1', fullName: 'Carla Approver', email: 'approver1@example.test', role: 'approver' }, admin);
  const releaser = await account(server, { username: 'releaser1', fullName: 'Dina Releaser', email: 'releaser1@example.test', role: 'approver' }, admin);
  const categories = (await json(await raw('/api/categories', maker.auth))).body;
  const transport = categories.find(c => c.code === 'TRANSPORTATION');

  assert.equal((await raw('/api/petty-cash/open', { method: 'POST', ...maker.auth, body: { entryDate: '2026-09-01', amount: 50000 } })).status, 403);
  assert.equal((await raw('/api/petty-cash/open', { method: 'POST', ...admin.auth, body: { entryDate: '2026-09-01', amount: 50000, remarks: 'Opening fund' } })).status, 201);

  const request = (await json(await raw('/api/requests', { method: 'POST', ...maker.auth, body: {
    kind: 'petty_cash', dateRequested: '2026-09-21', requestedBy: 'Ana Maker', payee: '', purpose: 'Taxi fares',
    finalApprover: 'Demry Cheng', lines: [{ particulars: 'Taxi fare', quantity: 1, unitAmount: 3500, categoryId: transport.id }],
  } }))).body;
  assert.equal(request.number, 'PCR-2026-000001');
  await raw(`/api/requests/${request.id}/submit`, { method: 'POST', ...maker.auth, body: {} });
  await raw(`/api/requests/${request.id}/approve`, { method: 'POST', ...approver.auth, body: {} });
  assert.equal((await json(await raw('/api/petty-cash', admin.auth))).body.balance, 50000, 'approval alone moves no cash');
  const disbursed = await json(await raw(`/api/requests/${request.id}/disburse`, { method: 'POST', ...releaser.auth, body: { entryDate: '2026-09-21', receivedBy: 'Ana Maker', remarks: '' } }));
  assert.equal(disbursed.body.status, 'disbursed');
  const fund = (await json(await raw('/api/petty-cash', admin.auth))).body;
  assert.equal(fund.balance, 46500);
  assert.equal(fund.entries[0].out, 3500);

  const replenishment = (await json(await raw('/api/replenishments', { method: 'POST', ...releaser.auth, body: { entryDate: '2026-09-30', amount: 3500, source: 'BDO', remarks: '' } }))).body;
  assert.equal((await raw(`/api/replenishments/${replenishment.id}/fund`, { method: 'POST', ...releaser.auth, body: { entryDate: '2026-09-30', remarks: '' } })).status, 409);
  await raw(`/api/replenishments/${replenishment.id}/approve`, { method: 'POST', ...approver.auth, body: {} });
  await raw(`/api/replenishments/${replenishment.id}/fund`, { method: 'POST', ...releaser.auth, body: { entryDate: '2026-09-30', remarks: 'Cash received' } });
  assert.equal((await json(await raw('/api/petty-cash', admin.auth))).body.balance, 50000);
});

test('reports render as JSON and download as CSV', async t => {
  const server = await serve(t);
  const { raw } = server;
  await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', password: 'strong-test-password' } });
  const admin = await account(server, { username: 'admin' });
  const maker = await account(server, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker' }, admin);
  const categories = (await json(await raw('/api/categories', maker.auth))).body;
  await raw('/api/requests', { method: 'POST', ...maker.auth, body: {
    kind: 'payment', dateRequested: '2026-09-21', requestedBy: 'Ana Maker', payee: 'Supplier', purpose: 'Supplies',
    finalApprover: 'Vicente Cheng', lines: [{ particulars: 'Paper', quantity: 2, unitAmount: 250, categoryId: categories[0].id }],
  } });
  const report = (await json(await raw('/api/reports/payment-register', admin.auth))).body;
  assert.equal(report.title, 'Payment Request Register');
  assert.equal(report.rows.length, 1);
  assert.equal(report.totals.amount, 500);
  const csv = await raw('/api/reports/payment-register.csv', admin.auth);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /payment-register\.csv/);
  const text = await csv.text();
  assert.match(text, /Reference No\./);
  assert.match(text, /PR-2026-000001/);
  assert.equal((await raw('/api/reports/not-a-report', admin.auth)).status, 404);
});

test('configuration changes are validated and applied', async t => {
  const server = await serve(t);
  const { raw } = server;
  await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', password: 'strong-test-password' } });
  const admin = await account(server, { username: 'admin' });
  const maker = await account(server, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker' }, admin);
  assert.equal((await raw('/api/config', { method: 'POST', ...maker.auth, body: { companyName: 'Hacked Inc.' } })).status, 403);
  assert.equal((await raw('/api/config', { method: 'POST', ...admin.auth, body: { paymentNumberFormat: 'PR-2026' } })).status, 400);
  assert.equal((await raw('/api/config', { method: 'POST', ...admin.auth, body: { defaultFinalApprover: 'NOBODY' } })).status, 400);
  const updated = await json(await raw('/api/config', { method: 'POST', ...admin.auth, body: {
    companyName: 'BLACK STONE MINERAL RESOURCES INC', defaultFinalApprover: 'Demry Cheng', paymentNumberFormat: 'PV-{YYYY}-{SEQ:5}',
  } }));
  assert.equal(updated.body.defaultFinalApprover, 'Demry Cheng');
  const categories = (await json(await raw('/api/categories', maker.auth))).body;
  const created = await json(await raw('/api/requests', { method: 'POST', ...maker.auth, body: {
    kind: 'payment', dateRequested: '2026-09-21', requestedBy: 'Ana', payee: '', purpose: '',
    finalApprover: 'Demry Cheng', lines: [{ particulars: 'Paper', quantity: 1, unitAmount: 10, categoryId: categories[0].id }],
  } }));
  assert.equal(created.body.number, 'PV-2026-00001', 'the new numbering format takes effect immediately');
});

test('a maker only ever sees their own requests through the list and dashboard', async t => {
  const server = await serve(t);
  const { raw } = server;
  await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', password: 'strong-test-password' } });
  const admin = await account(server, { username: 'admin' });
  const maker = await account(server, { username: 'maker1', fullName: 'Ana Maker', email: 'maker1@example.test', role: 'maker' }, admin);
  const other = await account(server, { username: 'maker2', fullName: 'Ben Maker', email: 'maker2@example.test', role: 'maker' }, admin);
  const categories = (await json(await raw('/api/categories', maker.auth))).body;
  const body = kind => ({ kind, dateRequested: '2026-09-21', requestedBy: 'x', payee: '', purpose: '', finalApprover: 'Vicente Cheng', lines: [{ particulars: 'Item', quantity: 1, unitAmount: 100, categoryId: categories[0].id }] });
  const mine = (await json(await raw('/api/requests', { method: 'POST', ...maker.auth, body: body('payment') }))).body;
  await raw('/api/requests', { method: 'POST', ...other.auth, body: body('payment') });
  assert.equal((await json(await raw('/api/requests', maker.auth))).body.total, 1);
  assert.equal((await json(await raw('/api/requests', admin.auth))).body.total, 2);
  assert.equal((await json(await raw('/api/dashboard', maker.auth))).body.payment.count.draft, 1);
  assert.equal((await raw(`/api/requests/${mine.id}`, other.auth)).status, 404);
  assert.equal((await raw(`/api/requests/${mine.id}/pdf`, other.auth)).status, 404);
});

test('rate limiting stops repeated bad passwords on one account', async t => {
  const server = await serve(t);
  const { raw } = server;
  await raw('/api/setup', { method: 'POST', body: { token: 'test-only-setup-code', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', password: 'strong-test-password' } });
  let blocked = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await raw('/api/login', { method: 'POST', body: { username: 'admin', password: 'wrong-password-here' } });
    if (response.status === 429) { blocked = true; break; }
    assert.equal(response.status, 401);
  }
  assert.ok(blocked, 'the account is locked out before a twelfth guess');
});
