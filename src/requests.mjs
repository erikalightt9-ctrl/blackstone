import { randomUUID } from 'node:crypto';
import { createRequestSchema, requestSchema, decisionSchema, cancelSchema, commentSchema } from './schema.mjs';
import { AppError, permit, found } from './errors.mjs';
import { toCentavos, toPeso, lineAmountCentavos, sumCentavos } from './money.mjs';
import { requireActiveCategory } from './categories.mjs';
import { nextNumber } from './numbering.mjs';
import { transition, availableActions, isEditable, STATUS_LABELS, KIND_LABELS } from './workflow.mjs';

export const MAKER_ROLES = ['admin', 'maker'];
const NUMBER_FORMAT = { payment: 'paymentNumberFormat', petty_cash: 'pettyCashNumberFormat' };

// Makers see the requests they prepared. Approvers, viewers and administrators
// see every request, because approval and payment are their work.
export const seesAllRequests = actor => ['admin', 'approver', 'viewer'].includes(actor.role);
function assertVisible(actor, row) {
  if (!seesAllRequests(actor) && row.maker_id !== actor.id) throw new AppError('Request not found.', 404);
  return row;
}

export function shapeLine(row) {
  return {
    id: row.id, particulars: row.particulars, quantity: row.quantity,
    unitAmount: toPeso(row.unit_cents), amount: toPeso(row.amount_cents),
    categoryId: row.category_id, categoryCode: row.code ?? '', categoryName: row.name ?? '',
  };
}
export function linesOf(store, requestId) {
  return store.all('SELECT l.*, c.code, c.name FROM request_lines l JOIN categories c ON c.id = l.category_id WHERE l.request_id = ? ORDER BY l.position', requestId).map(shapeLine);
}

export function shapeRequest(store, row, actor = null) {
  const request = {
    id: row.id, kind: row.kind, kindLabel: KIND_LABELS[row.kind], number: row.number,
    status: row.status, statusLabel: STATUS_LABELS[row.status],
    dateRequested: row.date_requested, requestedBy: row.requested_by, payee: row.payee, purpose: row.purpose,
    finalApprover: row.final_approver, total: toPeso(row.total_cents),
    maker: { id: row.maker_id, name: row.maker_name },
    approver: row.approver_id ? { id: row.approver_id, name: row.approver_name } : null,
    createdAt: row.created_at, updatedAt: row.updated_at, submittedAt: row.submitted_at,
    decidedAt: row.decided_at, decisionRemarks: row.decision_remarks,
    previousStatus: row.previous_status, cancelledBy: row.cancelled_by, cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason, settledAt: row.settled_at,
    cancelled: row.status === 'cancelled',
    lines: linesOf(store, row.id),
    documents: store.all('SELECT id, name, mime, size, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt FROM documents WHERE request_id = ? ORDER BY uploaded_at', row.id),
    history: store.history('request', row.id),
    comments: store.history('request', row.id).filter(entry => entry.action === 'comment').map(entry => ({ id: entry.id, at: entry.at, actor: entry.actor, text: entry.detail })),
  };
  const payment = store.get('SELECT * FROM payments WHERE request_id = ?', row.id);
  if (payment) request.payment = shapePayment(payment);
  const ledger = store.all('SELECT id, entry_date AS entryDate, reference, type, description, in_cents, out_cents, balance_cents, actor FROM ledger WHERE request_id = ? ORDER BY seq', row.id);
  if (ledger.length) request.ledger = ledger.map(e => ({ ...e, in: toPeso(e.in_cents), out: toPeso(e.out_cents), balance: toPeso(e.balance_cents) }));
  if (actor) {
    // Ownership narrows the role's actions: only the maker submits their own request, and
    // the maker of a request is never offered the decision on it.
    const own = row.maker_id === actor.id;
    request.actions = availableActions(row.kind, row.status, actor.role)
      .filter(action => (action === 'submit' ? own : !(own && ['approve', 'reject'].includes(action))));
    request.canEdit = row.status === 'draft' && own;
  }
  return request;
}
export const shapePayment = row => ({
  id: row.id, requestId: row.request_id, method: row.method, bank: row.bank, checkNumber: row.check_number,
  checkDate: row.check_date, amount: toPeso(row.amount_cents), payee: row.payee, datePrepared: row.date_prepared,
  dateReleased: row.date_released, releasedBy: row.released_by, receivedBy: row.received_by,
  remarks: row.remarks, recordedBy: row.recorded_by, recordedAt: row.recorded_at,
});

export function requestRow(store, id) { return found(store.get('SELECT * FROM requests WHERE id = ?', id), 'Request'); }
export function getRequest(store, actor, id) { return shapeRequest(store, assertVisible(actor, requestRow(store, id)), actor); }

function priceLines(store, lines) {
  return lines.map((line, index) => {
    const category = requireActiveCategory(store, line.categoryId);
    const unitCents = toCentavos(line.unitAmount);
    return { id: randomUUID(), position: index + 1, particulars: line.particulars, quantity: line.quantity, unitCents, amountCents: lineAmountCentavos(line.quantity, unitCents), categoryId: category.id };
  });
}
function writeLines(store, requestId, priced) {
  store.run('DELETE FROM request_lines WHERE request_id = ?', requestId);
  for (const line of priced) {
    store.run('INSERT INTO request_lines(id, request_id, position, particulars, quantity, unit_cents, amount_cents, category_id) VALUES(?,?,?,?,?,?,?,?)',
      line.id, requestId, line.position, line.particulars, line.quantity, line.unitCents, line.amountCents, line.categoryId);
  }
  const total = sumCentavos(priced.map(line => line.amountCents));
  store.run('UPDATE requests SET total_cents = ? WHERE id = ?', total, requestId);
  return total;
}
function assertFinalApprover(store, name) {
  const approvers = store.config().finalApprovers;
  if (!approvers.includes(name)) throw new AppError(`"${name}" is not an authorized final approver. Choose one of: ${approvers.join(', ')}.`);
  return name;
}

export function createRequest(store, actor, input) {
  permit(actor, MAKER_ROLES);
  const value = createRequestSchema.parse(input);
  return store.transaction(() => {
    assertFinalApprover(store, value.finalApprover);
    const priced = priceLines(store, value.lines);
    const now = new Date().toISOString();
    const { number } = nextNumber(store, store.config()[NUMBER_FORMAT[value.kind]], value.dateRequested);
    const id = randomUUID();
    store.run(`INSERT INTO requests(id, kind, number, status, date_requested, requested_by, payee, purpose, final_approver, total_cents, maker_id, maker_name, created_at, updated_at)
      VALUES(?,?,?,'draft',?,?,?,?,?,0,?,?,?,?)`, id, value.kind, number, value.dateRequested, value.requestedBy, value.payee, value.purpose, value.finalApprover, actor.id, actor.fullName, now, now);
    writeLines(store, id, priced);
    store.log(actor, 'create', 'request', id, { status: 'draft', detail: `${KIND_LABELS[value.kind]} ${number} created` });
    return getRequest(store, actor, id);
  });
}

export function updateRequest(store, actor, id, input) {
  permit(actor, MAKER_ROLES);
  const value = requestSchema.parse(input);
  return store.transaction(() => {
    const row = assertVisible(actor, requestRow(store, id));
    // Read access is wide; write access to a maker's own words and figures is not. An
    // administrator reviews and comments, but never rewrites what the maker submitted.
    if (row.maker_id !== actor.id) throw new AppError('Only the maker who prepared this request may edit it. Leave a comment for them instead.', 403);
    if (!isEditable(row.status)) throw new AppError(`A ${STATUS_LABELS[row.status]} request can no longer be edited. Cancel it and file a new request if a correction is needed.`, 409);
    assertFinalApprover(store, value.finalApprover);
    const priced = priceLines(store, value.lines);
    const before = shapeRequest(store, row);
    store.run('UPDATE requests SET date_requested = ?, requested_by = ?, payee = ?, purpose = ?, final_approver = ?, updated_at = ? WHERE id = ?',
      value.dateRequested, value.requestedBy, value.payee, value.purpose, value.finalApprover, new Date().toISOString(), id);
    writeLines(store, id, priced);
    const after = shapeRequest(store, requestRow(store, id));
    store.log(actor, 'update', 'request', id, { status: 'draft', detail: 'Draft request edited', before, after });
    return getRequest(store, actor, id);
  });
}

export function submitRequest(store, actor, id) {
  permit(actor, MAKER_ROLES);
  return store.transaction(() => {
    const row = assertVisible(actor, requestRow(store, id));
    if (row.maker_id !== actor.id) throw new AppError('Only the maker who prepared this request may submit it.', 403);
    const status = transition(row.kind, 'submit', row.status);
    if (!store.get('SELECT COUNT(*) AS n FROM request_lines WHERE request_id = ?', id).n) throw new AppError('Add at least one expense line before submitting.');
    const at = new Date().toISOString();
    store.run('UPDATE requests SET status = ?, submitted_at = ?, updated_at = ? WHERE id = ?', status, at, at, id);
    store.log(actor, 'submit', 'request', id, { status, detail: `${KIND_LABELS[row.kind]} ${row.number} submitted for approval` });
    return getRequest(store, actor, id);
  });
}

export function decideRequest(store, actor, id, action, input) {
  const value = decisionSchema.parse(input ?? {});
  return store.transaction(() => {
    const row = requestRow(store, id);
    permit(actor, ['admin', 'approver']);
    const status = transition(row.kind, action, row.status);
    // Maker-Approver separation: preparing a request disqualifies you from approving it.
    if (action !== 'review' && row.maker_id === actor.id) throw new AppError('The maker of a request cannot also approve or reject it. Another approver must decide.', 403);
    const at = new Date().toISOString();
    if (action === 'review') store.run('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?', status, at, id);
    else store.run('UPDATE requests SET status = ?, approver_id = ?, approver_name = ?, decided_at = ?, decision_remarks = ?, updated_at = ? WHERE id = ?', status, actor.id, actor.fullName, at, value.remarks, at, id);
    const detail = { approve: `Approval recorded - printed form signed by ${row.final_approver}`, reject: 'Request rejected' }[action];
    store.log(actor, action, 'request', id, { status, detail: value.remarks ? `${detail} - ${value.remarks}` : detail });
    return getRequest(store, actor, id);
  });
}

export function cancelRequest(store, actor, id, input) {
  const value = cancelSchema.parse(input ?? {});
  return store.transaction(() => {
    const row = requestRow(store, id);
    permit(actor, ['admin', 'approver']);
    const status = transition(row.kind, 'cancel', row.status);
    const at = new Date().toISOString();
    store.run('UPDATE requests SET status = ?, previous_status = ?, cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?',
      status, row.status, actor.fullName, at, value.reason, at, id);
    // A disbursed petty cash request keeps its ledger effect. Restoring the fund is a
    // separate, recorded return so the running balance is never rewritten in place.
    const disbursed = row.status === 'disbursed';
    store.log(actor, 'cancel', 'request', id, {
      status,
      detail: `Cancelled from ${STATUS_LABELS[row.status]} - ${value.reason}${disbursed ? ' (cash already released: record a return to restore the fund)' : ''}`,
    });
    return getRequest(store, actor, id);
  });
}

// Review feedback. A comment is an immutable audit entry: it is visible to the maker, it is
// part of the permanent history, and it changes nothing about the request itself. This is how
// a reviewer raises a discrepancy without touching the maker's figures.
export const COMMENT_ROLES = ['admin', 'approver', 'maker'];
export function addComment(store, actor, id, input) {
  permit(actor, COMMENT_ROLES);
  const value = commentSchema.parse(input);
  return store.transaction(() => {
    const row = assertVisible(actor, requestRow(store, id));
    store.log(actor, 'comment', 'request', id, { status: row.status, detail: value.text });
    return getRequest(store, actor, id);
  });
}
