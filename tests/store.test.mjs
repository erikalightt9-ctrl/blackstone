import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

const actor = { id: 'u1', username: 'maker1', fullName: 'Ana Maker' };

test('a new database seeds configuration and the accounting category master list', () => {
  const store = new Store();
  const config = store.config();
  assert.equal(config.paymentNumberFormat, 'PR-{YYYY}-{SEQ:6}');
  assert.equal(config.pettyCashNumberFormat, 'PCR-{YYYY}-{SEQ:6}');
  assert.deepEqual(config.finalApprovers, ['Demry Cheng', 'Vicente Cheng']);
  assert.ok(store.all('SELECT code FROM categories WHERE active = 1').length >= 10);
  store.setConfig('defaultFinalApprover', 'Demry Cheng');
  assert.equal(store.config().defaultFinalApprover, 'Demry Cheng');
  store.close();
});

test('the audit trail is append-only at the database level', () => {
  const store = new Store();
  store.log(actor, 'create', 'request', 'r1', { status: 'draft', detail: 'Request created' });
  assert.equal(store.history('request', 'r1').length, 1);
  assert.equal(store.history('request', 'r1')[0].actor, 'Ana Maker');
  assert.throws(() => store.run("UPDATE audit SET action = 'tamper'"), /cannot be edited/);
  assert.throws(() => store.run('DELETE FROM audit'), /cannot be deleted/);
  assert.equal(store.auditTrail().length, 1);
  store.close();
});

test('the petty cash ledger cannot be edited or deleted, only appended', () => {
  const store = new Store();
  store.run("INSERT INTO ledger(id, at, entry_date, reference, type, description, in_cents, out_cents, balance_cents, actor) VALUES('l1','2026-09-21T01:00:00Z','2026-09-21','PCF-2026-0001','replenishment','Opening',5000000,0,5000000,'Ana Maker')");
  assert.throws(() => store.run('UPDATE ledger SET balance_cents = 0'), /cannot be edited/);
  assert.throws(() => store.run('DELETE FROM ledger'), /cannot be deleted/);
  store.close();
});

test('financial requests, payments and replenishments can never be hard deleted', () => {
  const store = new Store();
  const insert = "INSERT INTO requests(id, kind, number, status, date_requested, requested_by, final_approver, maker_id, maker_name, created_at, updated_at) VALUES('r1','payment','PR-2026-000001','draft','2026-09-21','Ana','Vicente Cheng','u1','Ana Maker','x','x')";
  store.run(insert);
  assert.throws(() => store.run('DELETE FROM requests'), /never deleted/);
  store.run("INSERT INTO payments(id, request_id, method, amount_cents, payee, date_prepared, recorded_by, recorded_at) VALUES('p1','r1','Check',1000,'Ana','2026-09-22','Tess','x')");
  assert.throws(() => store.run('DELETE FROM payments'), /cannot be deleted/);
  store.run("INSERT INTO replenishments(id, number, status, amount_cents, requested_by, requested_at) VALUES('rep1','PCF-2026-0001','funded',5000,'Ana','x')");
  assert.throws(() => store.run('DELETE FROM replenishments'), /cannot be deleted/);
  store.close();
});

test('expense lines are frozen by the database once a request leaves draft', () => {
  const store = new Store();
  store.run("INSERT INTO requests(id, kind, number, status, date_requested, requested_by, final_approver, maker_id, maker_name, created_at, updated_at) VALUES('r1','payment','PR-2026-000001','draft','2026-09-21','Ana','Vicente Cheng','u1','Ana Maker','x','x')");
  const category = store.get('SELECT id FROM categories LIMIT 1').id;
  const line = "INSERT INTO request_lines(id, request_id, position, particulars, quantity, unit_cents, amount_cents, category_id) VALUES(?, 'r1', 1, 'Office Supplies', 5, 10000, 50000, ?)";
  store.run(line, 'l1', category);
  store.run("UPDATE requests SET status = 'submitted' WHERE id = 'r1'");
  assert.throws(() => store.run(line, 'l2', category), /only a draft request/i);
  assert.throws(() => store.run("UPDATE request_lines SET quantity = 99 WHERE id = 'l1'"), /only a draft request/i);
  assert.throws(() => store.run("DELETE FROM request_lines WHERE id = 'l1'"), /only a draft request/i);
  store.close();
});

test('a failed transaction rolls back every write and fires no change event', () => {
  const store = new Store();
  let changes = 0;
  store.onChange(() => { changes++; });
  assert.throws(() => store.transaction(() => {
    store.log(actor, 'create', 'request', 'r9', { status: 'draft' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.history('request', 'r9').length, 0);
  assert.equal(changes, 0);
  store.transaction(() => { store.log(actor, 'create', 'request', 'r9', { status: 'draft' }); });
  assert.equal(changes, 1, 'a committed transaction notifies listeners exactly once');
  store.close();
});

test('nested transactions commit as one unit', () => {
  const store = new Store();
  let changes = 0;
  store.onChange(() => { changes++; });
  store.transaction(() => {
    store.log(actor, 'create', 'request', 'r1', {});
    store.transaction(() => store.log(actor, 'submit', 'request', 'r1', {}));
  });
  assert.equal(store.history('request', 'r1').length, 2);
  assert.equal(changes, 1);
  store.close();
});
