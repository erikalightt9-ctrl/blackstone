import test from 'node:test';
import assert from 'node:assert/strict';
import { newStore, actors, categoryId, draftPayment } from './helpers.mjs';
import { listCategories, createCategory, updateCategory, requireActiveCategory, getCategory } from '../src/categories.mjs';

test('the master list ships with the categories the specification names', () => {
  const store = newStore();
  const names = listCategories(store).map(c => c.name);
  for (const expected of [
    'Office Rent', 'Parking Rent', 'Utilities', 'Government Remittance', 'Salaries and Wages',
    'Professional Fees', 'Retainers Fee', 'Representation and Entertainment', 'Miscellaneous Expense',
    'Fuel Expenses', 'Freight & Delivery', 'Event Expenses', 'Bank Charges', 'Transportation',
    'Government Fees', 'Sponsorship', 'Office Supplies', 'Meals', 'Communication',
    'Repairs and Maintenance', 'Advertising and Promotions',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.equal(new Set(names).size, names.length, 'no category is listed twice');
  store.close();
});

test('categories are added, renamed and deactivated without touching the application', () => {
  const store = newStore();
  const created = createCategory(store, actors.admin, { code: 'TRAINING', name: 'Training' });
  assert.equal(created.active, true);
  assert.ok(listCategories(store).some(c => c.code === 'TRAINING'));
  const renamed = updateCategory(store, actors.admin, created.id, { code: 'TRAINING', name: 'Training and Seminars', active: true });
  assert.equal(renamed.name, 'Training and Seminars');
  const deactivated = updateCategory(store, actors.admin, created.id, { code: 'TRAINING', name: 'Training and Seminars', active: false });
  assert.equal(deactivated.active, false);
  assert.ok(!listCategories(store).some(c => c.code === 'TRAINING'), 'inactive categories drop out of the pick list');
  assert.ok(listCategories(store, { includeInactive: true }).some(c => c.code === 'TRAINING'), 'but remain in the master list');
  assert.deepEqual(store.history('category', created.id).map(h => h.action), ['create', 'update', 'deactivate']);
  store.close();
});

test('only an administrator maintains the master list', () => {
  const store = newStore();
  for (const actor of [actors.maker, actors.approver, actors.releaser, actors.viewer]) {
    assert.throws(() => createCategory(store, actor, { code: 'X', name: 'X' }), /permission/, actor.role);
  }
  store.close();
});

test('category codes stay unique and inputs are validated', () => {
  const store = newStore();
  assert.throws(() => createCategory(store, actors.admin, { code: 'MEALS', name: 'Duplicate' }), /already exists/);
  assert.throws(() => createCategory(store, actors.admin, { code: 'bad code!', name: 'Bad' }), /letters, numbers/);
  assert.throws(() => createCategory(store, actors.admin, { code: 'OK', name: '' }), /name/);
  const created = createCategory(store, actors.admin, { code: 'TEMP', name: 'Temporary' });
  assert.throws(() => updateCategory(store, actors.admin, created.id, { code: 'MEALS', name: 'Clash', active: true }), /already exists/);
  assert.throws(() => updateCategory(store, actors.admin, '00000000-0000-4000-8000-000000000000', { code: 'X', name: 'X', active: true }), /not found/);
  store.close();
});

test('a deactivated category survives on the records already filed under it', () => {
  const store = newStore();
  const id = categoryId(store, 'FREIGHT');
  const request = draftPayment(store);
  updateCategory(store, actors.admin, id, { code: 'FREIGHT', name: 'Freight & Delivery', active: false });
  const line = request.lines.find(l => l.categoryId === id);
  assert.ok(line, 'the historical line still points at the category');
  assert.equal(getCategory(store, id).active, false);
  assert.throws(() => requireActiveCategory(store, id), /deactivated/);
  store.close();
});
