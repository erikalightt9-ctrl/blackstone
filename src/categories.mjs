import { randomUUID } from 'node:crypto';
import { categorySchema } from './schema.mjs';
import { AppError, permit, found } from './errors.mjs';

// The Accounting Category Master List. Categories are added, renamed, activated and
// deactivated at runtime; they are never deleted, because posted expense lines keep
// pointing at the classification they were filed under.
export const CATEGORY_ROLES = ['admin'];
const shape = row => ({ id: row.id, code: row.code, name: row.name, active: !!row.active, createdAt: row.created_at });

export function listCategories(store, { includeInactive = false } = {}) {
  const rows = includeInactive
    ? store.all('SELECT * FROM categories ORDER BY active DESC, name')
    : store.all('SELECT * FROM categories WHERE active = 1 ORDER BY name');
  return rows.map(shape);
}
export const getCategory = (store, id) => {
  const row = store.get('SELECT * FROM categories WHERE id = ?', id);
  return row ? shape(row) : null;
};

export function createCategory(store, actor, input) {
  permit(actor, CATEGORY_ROLES);
  const value = categorySchema.parse(input);
  return store.transaction(() => {
    if (store.get('SELECT id FROM categories WHERE code = ?', value.code)) throw new AppError(`Accounting category code "${value.code}" already exists.`, 409);
    const category = { id: randomUUID(), ...value, createdAt: new Date().toISOString() };
    store.run('INSERT INTO categories(id, code, name, active, created_at) VALUES(?, ?, ?, ?, ?)', category.id, category.code, category.name, category.active ? 1 : 0, category.createdAt);
    store.log(actor, 'create', 'category', category.id, { detail: `Accounting category ${category.code} created`, after: category });
    return category;
  });
}

export function updateCategory(store, actor, id, input) {
  permit(actor, CATEGORY_ROLES);
  const value = categorySchema.parse(input);
  return store.transaction(() => {
    const before = found(getCategory(store, id), 'Accounting category');
    const clash = store.get('SELECT id FROM categories WHERE code = ? AND id <> ?', value.code, id);
    if (clash) throw new AppError(`Accounting category code "${value.code}" already exists.`, 409);
    store.run('UPDATE categories SET code = ?, name = ?, active = ? WHERE id = ?', value.code, value.name, value.active ? 1 : 0, id);
    const after = { ...before, ...value };
    store.log(actor, value.active === before.active ? 'update' : (value.active ? 'activate' : 'deactivate'), 'category', id, {
      detail: `Accounting category ${after.code}${value.active === before.active ? ' updated' : (value.active ? ' activated' : ' deactivated')}`, before, after,
    });
    return after;
  });
}

// Used when validating expense lines: an inactive category may stay on historical records
// but can never be chosen for a new or edited line.
export function requireActiveCategory(store, id) {
  const category = found(getCategory(store, id), 'Accounting category');
  if (!category.active) throw new AppError(`Accounting category "${category.name}" is deactivated. Choose an active category.`);
  return category;
}
