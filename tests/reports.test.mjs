import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, categoryId, draftPayment, draftPettyCash } from './helpers.mjs';
import { submitRequest, decideRequest, cancelRequest } from '../src/requests.mjs';
import { releasePayment } from '../src/payments.mjs';
import { setOpeningBalance, disburse, createReplenishment, decideReplenishment, fundReplenishment } from '../src/pettycash.mjs';
import { runReport, toCsv, REPORT_LIST } from '../src/reports.mjs';
import { listRequests, dashboard } from '../src/search.mjs';

function seeded() {
  const store = newStore();
  setOpeningBalance(store, actors.admin, { entryDate: '2026-09-01', amount: 50000, source: '', remarks: 'Opening' });
  const paid = draftPayment(store);
  submitRequest(store, actors.maker, paid.id);
  decideRequest(store, actors.approver, paid.id, 'approve', {});
  releasePayment(store, actors.releaser, paid.id, { method: 'Check', bank: 'BDO', checkNumber: '0012345', checkDate: '2026-09-22', amount: 850, payee: 'Metro', datePrepared: '2026-09-22', dateReleased: '2026-09-23', receivedBy: 'Metro', remarks: '' });

  const pending = draftPayment(store, { requestedBy: 'Ben Maker', dateRequested: '2026-09-22' });
  submitRequest(store, actors.maker, pending.id);

  const killed = draftPayment(store, { requestedBy: 'Ana Maker' });
  cancelRequest(store, actors.approver, killed.id, { reason: 'Duplicate request' });

  const cash = draftPettyCash(store);
  submitRequest(store, actors.maker, cash.id);
  decideRequest(store, actors.approver, cash.id, 'approve', {});
  disburse(store, actors.releaser, cash.id, { entryDate: '2026-09-21', receivedBy: 'Ana', remarks: '' });

  const replenishment = createReplenishment(store, actors.releaser, { entryDate: '2026-09-30', amount: 3500, source: 'BDO', remarks: '' });
  decideReplenishment(store, actors.approver, replenishment.id, true);
  fundReplenishment(store, actors.releaser, replenishment.id, { entryDate: '2026-09-30', remarks: '' });
  return store;
}

test('every report in the list runs and returns a usable shape', () => {
  const store = seeded();
  for (const { id, title } of REPORT_LIST) {
    const result = runReport(store, actors.admin, id, {});
    assert.equal(result.title, title, id);
    assert.ok(Array.isArray(result.columns) && result.columns.length, `${id} has columns`);
    assert.ok(Array.isArray(result.rows), `${id} has rows`);
    for (const row of result.rows) for (const column of result.columns) assert.ok(column.key in row, `${id}.${column.key}`);
  }
  assert.throws(() => runReport(store, actors.admin, 'nope', {}), /Unknown report/);
  store.close();
});

test('the payment register lists every payment request with its check details', () => {
  const store = seeded();
  const report = runReport(store, actors.admin, 'payment-register', {});
  assert.equal(report.rows.length, 3);
  assert.equal(report.totals.amount, 2550);
  const settled = report.rows.find(row => row.number === 'PR-2026-000001');
  assert.equal(settled.checkNumber, '0012345');
  assert.equal(settled.released, '2026-09-23');
  assert.equal(settled.status, 'Released');
  assert.equal(report.rows.find(row => row.status === 'CANCELLED').amount, 850);
  store.close();
});

test('the petty cash ledger report reads oldest first with a running balance', () => {
  const store = seeded();
  const report = runReport(store, actors.admin, 'petty-cash-ledger', {});
  assert.deepEqual(report.rows.map(row => row.type), ['Opening', 'Disbursement', 'Replenishment']);
  assert.deepEqual(report.rows.map(row => row.balance), [50000, 46500, 50000]);
  assert.equal(report.totals.balance, 50000);
  assert.equal(report.totals.out, 3500);
  store.close();
});

test('expense reports exclude cancelled and rejected transactions', () => {
  const store = seeded();
  const byCategory = runReport(store, actors.admin, 'by-category', {});
  // Two live payment requests (850 each) plus one petty cash request (3,500); the cancelled one is out.
  assert.equal(byCategory.totals.amount, 5200);
  const supplies = byCategory.rows.find(row => row.bucket === 'Office Supplies');
  assert.equal(supplies.amount, 1000, 'two live requests at 500 each');
  assert.equal(byCategory.rows.reduce((sum, row) => sum + row.amount, 0), 5200);
  assert.match(supplies.share, /^\d+\.\d%$/);

  const byRequester = runReport(store, actors.admin, 'by-requester', {});
  assert.equal(byRequester.rows.find(row => row.bucket === 'Ben Maker').amount, 850);
  const byDate = runReport(store, actors.admin, 'by-date', {});
  assert.deepEqual(byDate.rows.map(row => row.bucket).sort(), ['2026-09-21', '2026-09-22']);
  store.close();
});

test('paid versus pending separates settled, outstanding and closed transactions', () => {
  const store = seeded();
  const report = runReport(store, actors.admin, 'paid-vs-pending', {});
  const find = (kind, bucket) => report.rows.find(row => row.kind === kind && row.bucket === bucket);
  assert.equal(find('Payment Request', 'Settled').amount, 850);
  assert.equal(find('Payment Request', 'Outstanding').amount, 850);
  assert.equal(find('Payment Request', 'Closed without payment').amount, 850);
  assert.equal(find('Petty Cash Request', 'Settled').amount, 3500);
  store.close();
});

test('the cancelled report keeps the reason, the actor and the previous status', () => {
  const store = seeded();
  const report = runReport(store, actors.admin, 'cancelled', {});
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].reason, 'Duplicate request');
  assert.equal(report.rows[0].by, 'Carla Approver');
  assert.equal(report.rows[0].previousStatus, 'Draft');
  store.close();
});

test('the replenishment history shows the full request, approval and funding chain', () => {
  const store = seeded();
  const report = runReport(store, actors.admin, 'replenishments', {});
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].status, 'Funded');
  assert.equal(report.rows[0].approvedBy, 'Carla Approver');
  assert.equal(report.rows[0].fundedBy, 'Dina Releaser');
  assert.equal(report.totals.amount, 3500);
  store.close();
});

test('reports respect date filters and a maker only ever reports on their own requests', () => {
  const store = seeded();
  assert.equal(runReport(store, actors.admin, 'payment-register', { from: '2026-09-22' }).rows.length, 1);
  assert.equal(runReport(store, actors.admin, 'payment-register', { to: '2026-09-20' }).rows.length, 0);
  const maker2 = runReport(store, actors.maker2, 'payment-register', {});
  assert.equal(maker2.rows.length, 0, 'Ben Maker prepared none of these');
  assert.equal(runReport(store, actors.maker, 'payment-register', {}).rows.length, 3);
  store.close();
});

test('CSV export is quoted, includes totals, and neutralises formula injection', () => {
  const store = seeded();
  const csv = toCsv(runReport(store, actors.admin, 'payment-register', {}));
  const rows = csv.split('\r\n');
  assert.equal(rows[0], 'Payment Request Register');
  assert.ok(rows.some(row => row.startsWith('Reference No.,')));
  assert.ok(rows.some(row => row.includes('PR-2026-000001')));
  assert.ok(rows.some(row => row.startsWith('Total amount,2550')));

  const injected = toCsv({ title: 'T', generatedAt: 'now', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: '=1+1', b: 'has "quotes", and, commas' }], totals: {} });
  assert.match(injected, /'=1\+1/, 'a leading equals is neutralised');
  assert.match(injected, /"has ""quotes"", and, commas"/);
  store.close();
});

test('search filters on every field the specification lists', () => {
  const store = seeded();
  const find = filter => listRequests(store, actors.admin, filter).rows;
  assert.equal(find({ number: 'PR-2026-000001' }).length, 1);
  assert.equal(find({ kind: 'petty_cash' }).length, 1);
  assert.equal(find({ requester: 'Ben' }).length, 1);
  assert.equal(find({ payee: 'Metro' }).length, 3);
  assert.equal(find({ status: 'paid' }).length, 1);
  assert.equal(find({ status: 'paid,submitted' }).length, 2);
  assert.equal(find({ status: 'not-a-status' }).length, 0);
  assert.equal(find({ checkNumber: '00123' }).length, 1);
  assert.equal(find({ paymentStatus: 'paid' }).length, 2, 'paid and disbursed both count as settled');
  assert.equal(find({ paymentStatus: 'unpaid' }).length, 1);
  assert.equal(find({ approver: 'Carla' }).length, 2, 'the cancelled draft was never approved by anyone');
  assert.equal(find({ approver: 'VICENTE' }).length, 4, 'the final approver is searchable too');
  assert.equal(find({ categoryId: categoryId(store, 'TRANSPORTATION') }).length, 1);
  assert.equal(find({ minAmount: 1000 }).length, 1);
  assert.equal(find({ maxAmount: 1000 }).length, 3);
  assert.equal(find({ from: '2026-09-22' }).length, 1);
  assert.equal(find({ text: 'Delivery Fee' }).length, 3, 'particulars are searched');
  assert.equal(find({ text: 'Taxi' }).length, 1);
  assert.equal(listRequests(store, actors.admin, { limit: 2 }).rows.length, 2);
  assert.equal(listRequests(store, actors.admin, { limit: 2, offset: 3 }).total, 4, 'the total ignores paging');
  store.close();
});

test('the dashboard counts and money agree with the underlying records', () => {
  const store = seeded();
  const view = dashboard(store, actors.admin);
  assert.equal(view.payment.count.paid, 1);
  assert.equal(view.payment.count.submitted, 1);
  assert.equal(view.payment.count.cancelled, 1);
  assert.equal(view.payment.forApproval, 1);
  assert.equal(view.payment.total, 3);
  assert.equal(view.payment.totalAmount, 2550);
  assert.equal(view.pettyCash.balance, 50000);
  assert.equal(view.pettyCash.count.disbursed, 1);
  assert.equal(view.pettyCash.amount.disbursed, 3500);
  assert.equal(view.pettyCash.fundOpened, true);
  assert.equal(view.pettyCash.replenishments.funded.count, 1);
  assert.equal(view.pettyCash.replenishedTotal, 3500);
  assert.equal(dashboard(store, actors.maker2).payment.total, 0, 'a maker sees only their own');
  store.close();
});
