import { randomUUID } from 'node:crypto';
import { disburseSchema, returnSchema, replenishmentSchema, fundingSchema, adjustmentSchema } from './schema.mjs';
import { AppError, permit, found } from './errors.mjs';
import { toCentavos, toPeso } from './money.mjs';
import { transition } from './workflow.mjs';
import { requestRow, getRequest } from './requests.mjs';
import { nextNumber } from './numbering.mjs';

// The petty cash fund. Every movement appends one immutable ledger entry carrying its own
// running balance, so the balance is always the last entry and is never recomputed from,
// or written back over, history. Reversals are new entries, never edits.
export const RELEASER_ROLES = ['admin', 'approver'];
export const REPLENISHMENT_STATUSES = ['requested', 'approved', 'funded', 'rejected'];

const lastEntry = store => store.get('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1');
export const balanceCentavos = store => lastEntry(store)?.balance_cents ?? 0;
export const balance = store => toPeso(balanceCentavos(store));

export const shapeEntry = row => ({
  id: row.id, seq: row.seq, at: row.at, entryDate: row.entry_date, reference: row.reference, type: row.type,
  description: row.description, in: toPeso(row.in_cents), out: toPeso(row.out_cents), balance: toPeso(row.balance_cents),
  actor: row.actor, requestId: row.request_id, replenishmentId: row.replenishment_id,
});

// The only way a ledger row is ever created. Call inside a transaction.
function appendEntry(store, { entryDate, reference, type, description, inCents = 0, outCents = 0, actor, requestId = null, replenishmentId = null }) {
  const previous = balanceCentavos(store);
  const balanceCents = previous + inCents - outCents;
  if (balanceCents < 0) throw new AppError(`Petty cash fund has ${toPeso(previous).toFixed(2)} available; this movement of ${toPeso(outCents).toFixed(2)} would overdraw it. Replenish the fund first.`, 409);
  const entry = { id: randomUUID(), at: new Date().toISOString(), entryDate, reference, type, description, inCents, outCents, balanceCents, actor: actor.fullName, requestId, replenishmentId };
  store.run('INSERT INTO ledger(id, at, entry_date, reference, type, description, in_cents, out_cents, balance_cents, actor, request_id, replenishment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    entry.id, entry.at, entry.entryDate, entry.reference, entry.type, entry.description, inCents, outCents, balanceCents, entry.actor, requestId, replenishmentId);
  store.changed = true;
  return entry;
}

export function ledger(store, { from = '', to = '', type = '', limit = 500, offset = 0 } = {}) {
  const where = [], params = [];
  if (from) { where.push('entry_date >= ?'); params.push(from); }
  if (to) { where.push('entry_date <= ?'); params.push(to); }
  if (type) { where.push('type = ?'); params.push(type); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return {
    balance: balance(store),
    entries: store.all(`SELECT * FROM ledger ${clause} ORDER BY seq DESC LIMIT ? OFFSET ?`, ...params, limit, offset).map(shapeEntry),
    total: store.get(`SELECT COUNT(*) AS n FROM ledger ${clause}`, ...params).n,
  };
}

export function setOpeningBalance(store, actor, input) {
  permit(actor, ['admin']);
  const value = replenishmentSchema.parse(input);
  return store.transaction(() => {
    if (lastEntry(store)) throw new AppError('The petty cash fund is already open. Use a replenishment to add funds.', 409);
    const entry = appendEntry(store, { entryDate: value.entryDate, reference: 'OPENING', type: 'opening', description: value.remarks || 'Opening petty cash fund', inCents: toCentavos(value.amount), actor });
    store.setConfig('pettyCashOpeningBalance', value.amount);
    store.log(actor, 'open-fund', 'petty_cash', entry.id, { detail: `Petty cash fund opened at ${value.amount.toFixed(2)}` });
    return shapeEntry(store.get('SELECT * FROM ledger WHERE id = ?', entry.id));
  });
}

function pettyCashRow(store, id) {
  const row = requestRow(store, id);
  if (row.kind !== 'petty_cash') throw new AppError('This action applies to Petty Cash Requests only.', 409);
  return row;
}

// The fund is reduced on actual disbursement, never when the request is merely created or approved.
export function disburse(store, actor, id, input) {
  permit(actor, RELEASER_ROLES);
  const value = disburseSchema.parse(input);
  return store.transaction(() => {
    const row = pettyCashRow(store, id);
    const status = transition('petty_cash', 'disburse', row.status);
    const entry = appendEntry(store, {
      entryDate: value.entryDate, reference: row.number, type: 'disbursement',
      description: `${row.purpose || row.requested_by} - received by ${value.receivedBy}`.slice(0, 400),
      outCents: row.total_cents, actor, requestId: id,
    });
    const at = new Date().toISOString();
    store.run('UPDATE requests SET status = ?, settled_at = ?, updated_at = ? WHERE id = ?', status, at, at, id);
    store.log(actor, 'disburse', 'request', id, {
      status,
      detail: `Cash disbursed to ${value.receivedBy} on ${value.entryDate}${value.remarks ? ` - ${value.remarks}` : ''}. Fund balance ${toPeso(entry.balanceCents).toFixed(2)}`,
    });
    return getRequest(store, actor, id);
  });
}

// A return or reversal is its own ledger entry. It never rewrites the disbursement.
export function recordReturn(store, actor, id, input) {
  permit(actor, RELEASER_ROLES);
  const value = returnSchema.parse(input);
  return store.transaction(() => {
    const row = pettyCashRow(store, id);
    transition('petty_cash', 'return', row.status);
    const movements = store.get("SELECT COALESCE(SUM(out_cents), 0) AS out, COALESCE(SUM(in_cents), 0) AS returned FROM ledger WHERE request_id = ?", id);
    const amountCents = toCentavos(value.amount);
    const outstanding = movements.out - movements.returned;
    if (outstanding <= 0) throw new AppError('There is nothing left to return against this request.', 409);
    if (amountCents > outstanding) throw new AppError(`Only ${toPeso(outstanding).toFixed(2)} remains outstanding on ${row.number}.`);
    const entry = appendEntry(store, {
      entryDate: value.entryDate, reference: row.number, type: 'return',
      description: `Return / reversal - ${value.reason}`.slice(0, 400), inCents: amountCents, actor, requestId: id,
    });
    store.log(actor, 'return', 'request', id, { status: row.status, detail: `Cash returned to the fund: ${value.amount.toFixed(2)} - ${value.reason}. Fund balance ${toPeso(entry.balanceCents).toFixed(2)}` });
    return getRequest(store, actor, id);
  });
}

export function recordAdjustment(store, actor, input) {
  permit(actor, ['admin']);
  const value = adjustmentSchema.parse(input);
  const direction = value.direction;
  return store.transaction(() => {
    const amountCents = toCentavos(value.amount);
    const entry = appendEntry(store, {
      entryDate: value.entryDate, reference: 'ADJUSTMENT', type: 'adjustment', description: value.reason,
      inCents: direction === 'in' ? amountCents : 0, outCents: direction === 'out' ? amountCents : 0, actor,
    });
    store.log(actor, 'adjust-fund', 'petty_cash', entry.id, { detail: `Fund adjustment ${direction === 'in' ? '+' : '-'}${value.amount.toFixed(2)} - ${value.reason}. Fund balance ${toPeso(entry.balanceCents).toFixed(2)}` });
    return shapeEntry(store.get('SELECT * FROM ledger WHERE id = ?', entry.id));
  });
}

const shapeReplenishment = row => ({
  id: row.id, number: row.number, status: row.status, amount: toPeso(row.amount_cents), source: row.source,
  remarks: row.remarks, requestedBy: row.requested_by, requestedAt: row.requested_at,
  approvedBy: row.approved_by, approvedAt: row.approved_at, fundedBy: row.funded_by, fundedAt: row.funded_at,
});
export const listReplenishments = store => store.all('SELECT * FROM replenishments ORDER BY requested_at DESC').map(shapeReplenishment);
export function getReplenishment(store, id) {
  const row = found(store.get('SELECT * FROM replenishments WHERE id = ?', id), 'Replenishment');
  return { ...shapeReplenishment(row), history: store.history('replenishment', id) };
}

export function createReplenishment(store, actor, input) {
  permit(actor, RELEASER_ROLES);
  const value = replenishmentSchema.parse(input);
  return store.transaction(() => {
    const { number } = nextNumber(store, store.config().replenishmentNumberFormat, value.entryDate);
    const id = randomUUID(), at = new Date().toISOString();
    store.run('INSERT INTO replenishments(id, number, status, amount_cents, source, remarks, requested_by, requested_at) VALUES(?,?,?,?,?,?,?,?)',
      id, number, 'requested', toCentavos(value.amount), value.source, value.remarks, actor.fullName, at);
    store.log(actor, 'create', 'replenishment', id, { status: 'requested', detail: `Replenishment ${number} requested for ${value.amount.toFixed(2)}` });
    return getReplenishment(store, id);
  });
}

export function decideReplenishment(store, actor, id, approve, remarks = '') {
  permit(actor, ['admin', 'approver']);
  return store.transaction(() => {
    const row = found(store.get('SELECT * FROM replenishments WHERE id = ?', id), 'Replenishment');
    if (row.status !== 'requested') throw new AppError(`This replenishment is already ${row.status}.`, 409);
    const status = approve ? 'approved' : 'rejected';
    store.run('UPDATE replenishments SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?', status, actor.fullName, new Date().toISOString(), id);
    store.log(actor, approve ? 'approve' : 'reject', 'replenishment', id, { status, detail: `Replenishment ${row.number} ${status}${remarks ? ` - ${remarks}` : ''}` });
    return getReplenishment(store, id);
  });
}

// Recording the funding is what increases the available balance.
export function fundReplenishment(store, actor, id, input) {
  permit(actor, RELEASER_ROLES);
  const value = fundingSchema.parse(input);
  return store.transaction(() => {
    const row = found(store.get('SELECT * FROM replenishments WHERE id = ?', id), 'Replenishment');
    if (row.status !== 'approved') throw new AppError(`Only an approved replenishment can be funded. This one is ${row.status}.`, 409);
    const entry = appendEntry(store, {
      entryDate: value.entryDate, reference: row.number, type: 'replenishment',
      description: `Replenishment${row.source ? ` from ${row.source}` : ''}${value.remarks ? ` - ${value.remarks}` : ''}`.slice(0, 400),
      inCents: row.amount_cents, actor, replenishmentId: id,
    });
    store.run('UPDATE replenishments SET status = ?, funded_by = ?, funded_at = ? WHERE id = ?', 'funded', actor.fullName, new Date().toISOString(), id);
    store.log(actor, 'fund', 'replenishment', id, { status: 'funded', detail: `Funding recorded on ${value.entryDate}. Fund balance ${toPeso(entry.balanceCents).toFixed(2)}` });
    return getReplenishment(store, id);
  });
}
