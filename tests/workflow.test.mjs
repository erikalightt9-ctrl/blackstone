import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, availableActions, isEditable, isFinanciallyLocked, isTerminal, STATUSES, ACTIONS, WorkflowError } from '../src/workflow.mjs';

test('a payment request runs Draft to Released in three moves', () => {
  assert.equal(transition('payment', 'submit', 'draft'), 'submitted');
  assert.equal(transition('payment', 'approve', 'submitted'), 'approved');
  assert.equal(transition('payment', 'release', 'approved'), 'paid');
  assert.throws(() => transition('payment', 'release', 'submitted'), /cannot be released/);
  assert.throws(() => transition('payment', 'approve', 'draft'), /cannot be approved/);
  assert.throws(() => transition('payment', 'submit', 'paid'), /cannot be submitted/);
  assert.throws(() => transition('payment', 'disburse', 'approved'), /Unknown action/);
});

test('a petty cash request runs Draft to Disbursed and accepts a separate reversal', () => {
  assert.equal(transition('petty_cash', 'submit', 'draft'), 'submitted');
  assert.equal(transition('petty_cash', 'approve', 'submitted'), 'approved');
  assert.equal(transition('petty_cash', 'disburse', 'approved'), 'disbursed');
  assert.equal(transition('petty_cash', 'return', 'disbursed'), 'disbursed', 'a return is a ledger event, not a status change');
  assert.equal(transition('petty_cash', 'return', 'cancelled'), 'cancelled');
  assert.throws(() => transition('petty_cash', 'release', 'approved'), /Unknown action/);
});

test('the intermediate review and queue steps are gone', () => {
  for (const kind of ['payment', 'petty_cash']) {
    assert.throws(() => transition(kind, 'review', 'submitted'), /Unknown action/);
    assert.throws(() => transition(kind, 'queue', 'approved'), /Unknown action/);
    assert.throws(() => transition(kind, 'record-payment', 'approved'), /Unknown action/);
  }
  assert.ok(!STATUSES.includes('under_review'));
  assert.ok(!STATUSES.includes('for_payment'));
  assert.ok(!STATUSES.includes('for_disbursement'));
  assert.deepEqual(STATUSES, ['draft', 'submitted', 'approved', 'paid', 'disbursed', 'rejected', 'cancelled']);
});

test('cancellation is reachable from every live status but never from a closed one', () => {
  for (const status of STATUSES.filter(s => !['rejected', 'cancelled'].includes(s))) {
    assert.equal(transition('payment', 'cancel', status), 'cancelled', status);
  }
  assert.throws(() => transition('payment', 'cancel', 'cancelled'), /cannot be cancelled/);
  assert.throws(() => transition('payment', 'cancel', 'rejected'), /cannot be cancelled/);
});

test('only drafts are editable and approval locks the financial record permanently', () => {
  assert.ok(isEditable('draft'));
  assert.ok(!isEditable('submitted'));
  for (const status of ['approved', 'paid', 'disbursed', 'rejected', 'cancelled']) assert.ok(isFinanciallyLocked(status), status);
  for (const status of ['draft', 'submitted']) assert.ok(!isFinanciallyLocked(status), status);
  assert.deepEqual(STATUSES.filter(isTerminal), ['paid', 'disbursed', 'rejected', 'cancelled']);
});

test('the maker submits and the approver does everything after that', () => {
  assert.deepEqual(availableActions('payment', 'draft', 'maker'), ['submit']);
  assert.deepEqual(availableActions('payment', 'submitted', 'maker'), [], 'a submitted request is out of the maker\'s hands');
  assert.deepEqual(availableActions('payment', 'submitted', 'approver').sort(), ['approve', 'cancel', 'reject']);
  assert.deepEqual(availableActions('payment', 'approved', 'approver').sort(), ['cancel', 'release']);
  assert.deepEqual(availableActions('petty_cash', 'approved', 'approver').sort(), ['cancel', 'disburse']);
  assert.deepEqual(availableActions('petty_cash', 'disbursed', 'approver').sort(), ['cancel', 'return']);
  assert.deepEqual(availableActions('payment', 'paid', 'viewer'), []);
  assert.deepEqual(availableActions('payment', 'draft', 'viewer'), []);
  assert.throws(() => transition('payment', 'nope', 'draft'), WorkflowError);
});

test('only those who file and those who approve appear in the workflow at all', () => {
  const roles = new Set();
  for (const actions of Object.values(ACTIONS)) for (const rule of Object.values(actions)) for (const role of rule.roles) roles.add(role);
  // A requester files and submits like a maker; everything after that is the approver's.
  assert.deepEqual([...roles].sort(), ['admin', 'approver', 'maker', 'requester']);
  for (const [kind, actions] of Object.entries(ACTIONS)) {
    for (const [action, rule] of Object.entries(actions)) {
      if (action === 'submit') continue;
      assert.ok(!rule.roles.includes('requester'), `${kind}.${action} must never be available to a requester`);
    }
  }
  for (const [kind, actions] of Object.entries(ACTIONS)) {
    for (const [action, rule] of Object.entries(actions)) {
      assert.ok(rule.roles.includes('admin'), `${kind}.${action} must remain available to an administrator`);
      assert.ok(!rule.roles.includes('viewer'), `${kind}.${action} must never be available to a viewer`);
    }
  }
});
