import { searchSchema } from './schema.mjs';
import { toCentavos, toPeso } from './money.mjs';
import { STATUSES, STATUS_LABELS } from './workflow.mjs';
import { seesAllRequests, linesOf } from './requests.mjs';
import { balanceCentavos } from './pettycash.mjs';
import { PETTY_CASH_FUND_ROLES } from './defaults.mjs';
import { bankSummary } from './bank.mjs';

// Every list, filter and dashboard count comes through here, so a maker can never be shown
// another maker's request by a route that forgot to filter.
export function clauses(store, actor, query) {
  const where = ['1 = 1'], params = [];
  if (!seesAllRequests(actor)) { where.push('r.maker_id = ?'); params.push(actor.id); }
  if (query.kind) { where.push('r.kind = ?'); params.push(query.kind); }
  if (query.status) {
    const statuses = query.status.split(',').map(s => s.trim()).filter(s => STATUSES.includes(s));
    if (!statuses.length) { where.push('1 = 0'); } else { where.push(`r.status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
  }
  if (query.number) { where.push('r.number LIKE ?'); params.push(`%${query.number}%`); }
  if (query.requester) { where.push('r.requested_by LIKE ?'); params.push(`%${query.requester}%`); }
  if (query.payee) { where.push('r.payee LIKE ?'); params.push(`%${query.payee}%`); }
  if (query.approver) { where.push('(r.approver_name LIKE ? OR r.final_approver LIKE ?)'); params.push(`%${query.approver}%`, `%${query.approver}%`); }
  if (query.from) { where.push('r.date_requested >= ?'); params.push(query.from); }
  if (query.to) { where.push('r.date_requested <= ?'); params.push(query.to); }
  if (query.minAmount !== undefined) { where.push('r.total_cents >= ?'); params.push(toCentavos(query.minAmount)); }
  if (query.maxAmount !== undefined) { where.push('r.total_cents <= ?'); params.push(toCentavos(query.maxAmount)); }
  if (query.categoryId) { where.push('EXISTS (SELECT 1 FROM request_lines l WHERE l.request_id = r.id AND l.category_id = ?)'); params.push(query.categoryId); }
  if (query.checkNumber) { where.push('EXISTS (SELECT 1 FROM payments p WHERE p.request_id = r.id AND p.check_number LIKE ?)'); params.push(`%${query.checkNumber}%`); }
  if (query.paymentStatus === 'paid') where.push("r.status IN ('paid', 'disbursed')");
  if (query.paymentStatus === 'unpaid') where.push("r.status NOT IN ('paid', 'disbursed', 'cancelled', 'rejected')");
  if (query.text) {
    where.push('(r.number LIKE ? OR r.requested_by LIKE ? OR r.payee LIKE ? OR r.purpose LIKE ? OR EXISTS (SELECT 1 FROM request_lines l WHERE l.request_id = r.id AND l.particulars LIKE ?))');
    params.push(...Array(5).fill(`%${query.text}%`));
  }
  return { sql: where.join(' AND '), params };
}

const summary = (store, row, withLines) => ({
  id: row.id, kind: row.kind, number: row.number, status: row.status, statusLabel: STATUS_LABELS[row.status],
  dateRequested: row.date_requested, requestedBy: row.requested_by, payee: row.payee, purpose: row.purpose,
  finalApprover: row.final_approver, total: toPeso(row.total_cents), maker: row.maker_name, approver: row.approver_name || '',
  submittedAt: row.submitted_at, decidedAt: row.decided_at, settledAt: row.settled_at,
  cancelled: row.status === 'cancelled', cancelReason: row.cancel_reason,
  comments: row.comments ?? 0,
  checkNumber: row.check_number || '', checkDate: row.check_date || '', dateReleased: row.date_released || '',
  paymentMethod: row.method || '',
  ...(withLines ? { lines: linesOf(store, row.id) } : {}),
});

export function listRequests(store, actor, input = {}) {
  const query = searchSchema.parse(input);
  const { sql, params } = clauses(store, actor, query);
  const from = `FROM requests r LEFT JOIN payments p ON p.request_id = r.id WHERE ${sql}`;
  const totals = store.get(`SELECT COUNT(*) AS n, COALESCE(SUM(r.total_cents), 0) AS amount ${from}`, ...params);
  const rows = store.all(`SELECT r.*, p.check_number, p.check_date, p.date_released, p.method,
    (SELECT COUNT(*) FROM audit a WHERE a.entity_kind = 'request' AND a.entity_id = r.id AND a.action = 'comment') AS comments
    ${from} ORDER BY r.date_requested DESC, r.number DESC LIMIT ? OFFSET ?`, ...params, query.limit, query.offset);
  return { total: totals.n, amount: toPeso(totals.amount), limit: query.limit, offset: query.offset, rows: rows.map(row => summary(store, row, !!query.categoryId)) };
}

// Used by reports and exports, which need the whole matching set rather than one page.
export function allMatching(store, actor, input = {}) {
  const query = searchSchema.parse({ ...input, limit: 500, offset: 0 });
  const { sql, params } = clauses(store, actor, query);
  return store.all(`SELECT r.*, p.check_number, p.check_date, p.date_released, p.method FROM requests r LEFT JOIN payments p ON p.request_id = r.id WHERE ${sql} ORDER BY r.kind, r.number`, ...params)
    .map(row => summary(store, row, true));
}

export function dashboard(store, actor) {
  const { sql, params } = clauses(store, actor, searchSchema.parse({}));
  const counts = store.all(`SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS amount FROM requests r WHERE ${sql} GROUP BY kind, status`, ...params);
  const build = kind => {
    const card = { count: {}, amount: {}, total: 0, totalAmount: 0 };
    for (const status of STATUSES) { card.count[status] = 0; card.amount[status] = 0; }
    for (const row of counts.filter(c => c.kind === kind)) {
      card.count[row.status] = row.n; card.amount[row.status] = toPeso(row.amount);
      card.total += row.n; card.totalAmount = toPeso(toCentavos(card.totalAmount) + row.amount);
    }
    card.forApproval = card.count.submitted;
    card.forApprovalAmount = card.amount.submitted;
    return card;
  };
  // The fund balance, and every figure that would reveal it, is left out entirely for a
  // maker: omitted from the payload rather than hidden in the page.
  const seesFund = PETTY_CASH_FUND_ROLES.includes(actor.role);
  const replenishments = seesFund ? store.all('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS amount FROM replenishments GROUP BY status') : [];
  return {
    payment: build('payment'),
    pettyCash: {
      ...build('petty_cash'),
      seesFund,
      ...(seesFund ? {
        balance: toPeso(balanceCentavos(store)),
        fundOpened: !!store.get('SELECT 1 AS open FROM ledger LIMIT 1'),
        replenishments: Object.fromEntries(replenishments.map(r => [r.status, { count: r.n, amount: toPeso(r.amount) }])),
        replenishedTotal: toPeso(replenishments.filter(r => r.status === 'funded').reduce((sum, r) => sum + r.amount, 0)),
      } : {}),
    },
    bank: bankSummary(store, actor),
  };
}
