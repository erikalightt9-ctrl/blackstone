import { Store } from '../src/store.mjs';
import { createRequest } from '../src/requests.mjs';
import { createBank, createBankAccount } from '../src/accounts.mjs';

export const actors = {
  admin: { id: 'u-admin', username: 'admin', fullName: 'System Administrator', email: 'admin@example.test', role: 'admin' },
  maker: { id: 'u-maker', username: 'amaker', fullName: 'Ana Maker', email: 'amaker@example.test', role: 'maker' },
  maker2: { id: 'u-maker2', username: 'bmaker', fullName: 'Ben Maker', email: 'bmaker@example.test', role: 'maker' },
  requester: { id: 'u-requester', username: 'frequester', fullName: 'Fay Requester', email: 'frequester@example.test', role: 'requester' },
  approver: { id: 'u-approver', username: 'capprover', fullName: 'Carla Approver', email: 'capprover@example.test', role: 'approver' },
  releaser: { id: 'u-releaser', username: 'dreleaser', fullName: 'Dina Releaser', email: 'dreleaser@example.test', role: 'approver' },
  viewer: { id: 'u-viewer', username: 'eviewer', fullName: 'Elle Viewer', email: 'eviewer@example.test', role: 'viewer' },
};

export function newStore() {
  const store = new Store();
  for (const actor of Object.values(actors)) {
    store.run('INSERT INTO users(id, username, full_name, email, password_hash, role) VALUES(?,?,?,?,?,?)', actor.id, actor.username, actor.fullName, `${actor.username}@example.test`, 'x:y', actor.role);
  }
  return store;
}

export const categoryId = (store, code) => store.get('SELECT id FROM categories WHERE code = ?', code).id;

export function draftPayment(store, overrides = {}, actor = actors.maker) {
  return createRequest(store, actor, {
    kind: 'payment',
    dateRequested: '2026-09-21',
    requestedBy: 'Ana Maker',
    payee: 'Metro Office Depot',
    purpose: 'Monthly office supplies',
    finalApprover: 'Vicente Cheng',
    lines: [
      { particulars: 'Office Supplies', quantity: 5, unitAmount: 100, categoryId: categoryId(store, 'OFFICE-SUPPLIES') },
      { particulars: 'Delivery Fee', quantity: 1, unitAmount: 350, categoryId: categoryId(store, 'FREIGHT') },
    ],
    ...overrides,
  });
}

export function draftPettyCash(store, overrides = {}, actor = actors.maker) {
  return createRequest(store, actor, {
    kind: 'petty_cash',
    dateRequested: '2026-09-21',
    requestedBy: 'Ana Maker',
    payee: '',
    purpose: 'Courier and taxi fares',
    finalApprover: 'Vicente Cheng',
    lines: [{ particulars: 'Taxi fare', quantity: 1, unitAmount: 3500, categoryId: categoryId(store, 'TRANSPORTATION') }],
    ...overrides,
  });
}

// A bank and an account with it, since a passbook entry now belongs to a managed account
// rather than to a typed-in label.
export function demoBankAccount(store, overrides = {}, actor = actors.admin) {
  const { bankName = 'BDO Unibank', ...account } = overrides;
  const bank = createBank(store, actor, { name: bankName });
  return createBankAccount(store, actor, {
    bankId: bank.id, accountName: 'Operating Account', accountNumber: '0123', currency: 'PHP',
    accountType: 'Current / Checking', ...account,
  });
}
