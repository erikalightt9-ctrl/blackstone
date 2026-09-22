import { searchSchema } from './schema.mjs';
import { toPeso } from './money.mjs';
import { STATUS_LABELS, KIND_LABELS } from './workflow.mjs';
import { clauses } from './search.mjs';
import { ledger } from './pettycash.mjs';
import { AppError, permit } from './errors.mjs';
import { PETTY_CASH_FUND_ROLES } from './defaults.mjs';

// Reports are returned as { title, columns, rows, totals } so one table renderer and one CSV
// writer serve every report, and a new report never needs new UI.
const money = cents => toPeso(cents);
// Cancelled and rejected requests are excluded from expense analysis but keep their own report.
const REAL_EXPENSE = "r.status NOT IN ('cancelled', 'rejected')";

const report = (id, title, columns, rows, totals = {}) => ({ id, title, columns, rows, totals, generatedAt: new Date().toISOString() });

function scope(store, actor, input) {
  const query = searchSchema.parse(input);
  const { sql, params } = clauses(store, actor, query);
  return { sql, params, query };
}

// The specification names these two reports exactly; they are not derived from the module label.
const REGISTER_TITLES = { payment: 'Payment Request Register', petty_cash: 'Petty Cash Register' };
function register(store, actor, kind, input) {
  const { sql, params } = scope(store, actor, { ...input, kind });
  const rows = store.all(`SELECT r.*, p.check_number, p.date_released FROM requests r LEFT JOIN payments p ON p.request_id = r.id WHERE ${sql} ORDER BY r.number`, ...params);
  const columns = [
    { key: 'number', label: 'Reference No.' }, { key: 'date', label: 'Date' }, { key: 'requestedBy', label: 'Requested By' },
    { key: 'payee', label: 'Payee' }, { key: 'purpose', label: 'Purpose' }, { key: 'status', label: 'Status' },
    { key: 'approver', label: 'Approved By' }, { key: 'finalApprover', label: 'Final Approver' },
    ...(kind === 'payment' ? [{ key: 'checkNumber', label: 'Check No.' }, { key: 'released', label: 'Date Released' }] : [{ key: 'released', label: 'Date Disbursed' }]),
    { key: 'amount', label: 'Amount', money: true },
  ];
  return report(`${kind}-register`, REGISTER_TITLES[kind], columns, rows.map(r => ({
    number: r.number, date: r.date_requested, requestedBy: r.requested_by, payee: r.payee || r.requested_by,
    purpose: r.purpose, status: STATUS_LABELS[r.status], approver: r.approver_name || '', finalApprover: r.final_approver,
    checkNumber: r.check_number || '', released: r.date_released || (r.settled_at || '').slice(0, 10), amount: money(r.total_cents),
  })), { amount: money(rows.reduce((sum, r) => sum + r.total_cents, 0)), count: rows.length });
}

function grouped(store, actor, input, { id, title, select, group, label, join = '', amount = 'r.total_cents' }) {
  const { sql, params } = scope(store, actor, input);
  const rows = store.all(`SELECT ${select} AS bucket, COUNT(DISTINCT r.id) AS n, COALESCE(SUM(${amount}), 0) AS amount
    FROM requests r ${join} WHERE ${sql} AND ${REAL_EXPENSE} GROUP BY ${group} ORDER BY amount DESC`, ...params);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return report(id, title, [
    { key: 'bucket', label }, { key: 'count', label: 'Requests' }, { key: 'amount', label: 'Amount', money: true }, { key: 'share', label: 'Share' },
  ], rows.map(row => ({ bucket: row.bucket || '(unclassified)', count: row.n, amount: money(row.amount), share: total ? `${(row.amount / total * 100).toFixed(1)}%` : '0.0%' })),
  { amount: money(total), count: rows.reduce((sum, row) => sum + row.n, 0) });
}

export const REPORTS = {
  'payment-register': (store, actor, input) => register(store, actor, 'payment', input),
  'petty-cash-register': (store, actor, input) => register(store, actor, 'petty_cash', input),

  'petty-cash-ledger': (store, actor, input) => {
    const { query } = scope(store, actor, input);
    const { entries, balance } = ledger(store, { from: query.from, to: query.to, limit: 500 });
    return report('petty-cash-ledger', 'Petty Cash Ledger', [
      { key: 'entryDate', label: 'Date' }, { key: 'reference', label: 'Reference No.' }, { key: 'type', label: 'Transaction Type' },
      { key: 'description', label: 'Description' }, { key: 'in', label: 'Amount In', money: true }, { key: 'out', label: 'Amount Out', money: true },
      { key: 'balance', label: 'Running Balance', money: true }, { key: 'actor', label: 'Recorded By' }, { key: 'at', label: 'Date and Time Recorded' },
    ], entries.slice().reverse().map(e => ({ ...e, type: e.type.replace(/^./, c => c.toUpperCase()) })),
    { balance, in: entries.reduce((sum, e) => sum + e.in, 0), out: entries.reduce((sum, e) => sum + e.out, 0) });
  },

  'by-category': (store, actor, input) => grouped(store, actor, input, {
    id: 'by-category', title: 'Expenses by Accounting Category', label: 'Accounting Category',
    select: 'c.name', group: 'c.id', amount: 'l.amount_cents',
    join: 'JOIN request_lines l ON l.request_id = r.id JOIN categories c ON c.id = l.category_id',
  }),
  'by-date': (store, actor, input) => grouped(store, actor, input, {
    id: 'by-date', title: 'Expenses by Date', label: 'Date', select: 'r.date_requested', group: 'r.date_requested',
  }),
  'by-requester': (store, actor, input) => grouped(store, actor, input, {
    id: 'by-requester', title: 'Expenses by Requester', label: 'Requester', select: 'r.requested_by', group: 'r.requested_by',
  }),

  'paid-vs-pending': (store, actor, input) => {
    const { sql, params } = scope(store, actor, input);
    const rows = store.all(`SELECT r.kind, CASE WHEN r.status IN ('paid', 'disbursed') THEN 'Settled'
        WHEN r.status IN ('cancelled', 'rejected') THEN 'Closed without payment' ELSE 'Outstanding' END AS bucket,
      COUNT(*) AS n, COALESCE(SUM(r.total_cents), 0) AS amount FROM requests r WHERE ${sql} GROUP BY r.kind, bucket ORDER BY r.kind, bucket`, ...params);
    return report('paid-vs-pending', 'Paid vs. Pending Requests', [
      { key: 'kind', label: 'Module' }, { key: 'bucket', label: 'Settlement' }, { key: 'count', label: 'Requests' }, { key: 'amount', label: 'Amount', money: true },
    ], rows.map(r => ({ kind: KIND_LABELS[r.kind], bucket: r.bucket, count: r.n, amount: money(r.amount) })),
    { amount: money(rows.reduce((sum, r) => sum + r.amount, 0)), count: rows.reduce((sum, r) => sum + r.n, 0) });
  },

  cancelled: (store, actor, input) => {
    const { sql, params } = scope(store, actor, input);
    const rows = store.all(`SELECT r.* FROM requests r WHERE ${sql} AND r.status IN ('cancelled', 'rejected') ORDER BY r.cancelled_at DESC, r.decided_at DESC`, ...params);
    return report('cancelled', 'Cancelled and Rejected Transactions', [
      { key: 'number', label: 'Reference No.' }, { key: 'kind', label: 'Module' }, { key: 'status', label: 'Status' },
      { key: 'previousStatus', label: 'Previous Status' }, { key: 'by', label: 'Actioned By' }, { key: 'at', label: 'Date and Time' },
      { key: 'reason', label: 'Reason' }, { key: 'amount', label: 'Amount', money: true },
    ], rows.map(r => ({
      number: r.number, kind: KIND_LABELS[r.kind], status: STATUS_LABELS[r.status],
      previousStatus: STATUS_LABELS[r.previous_status] || '', by: r.cancelled_by || r.approver_name || '',
      at: r.cancelled_at || r.decided_at || '', reason: r.cancel_reason || r.decision_remarks || '', amount: money(r.total_cents),
    })), { amount: money(rows.reduce((sum, r) => sum + r.total_cents, 0)), count: rows.length });
  },

  replenishments: (store, actor, input) => {
    const { query } = scope(store, actor, input);
    const where = [], params = [];
    if (query.from) { where.push('requested_at >= ?'); params.push(query.from); }
    if (query.to) { where.push('requested_at <= ?'); params.push(`${query.to}T23:59:59Z`); }
    const rows = store.all(`SELECT * FROM replenishments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC`, ...params);
    return report('replenishments', 'Petty Cash Replenishment History', [
      { key: 'number', label: 'Reference No.' }, { key: 'requestedAt', label: 'Requested' }, { key: 'requestedBy', label: 'Requested By' },
      { key: 'source', label: 'Source' }, { key: 'status', label: 'Status' }, { key: 'approvedBy', label: 'Approved By' },
      { key: 'fundedAt', label: 'Funded' }, { key: 'fundedBy', label: 'Funding Recorded By' }, { key: 'amount', label: 'Amount', money: true },
    ], rows.map(r => ({
      number: r.number, requestedAt: r.requested_at, requestedBy: r.requested_by, source: r.source,
      status: r.status.replace(/^./, c => c.toUpperCase()), approvedBy: r.approved_by || '',
      fundedAt: r.funded_at || '', fundedBy: r.funded_by || '', amount: money(r.amount_cents),
    })), { amount: money(rows.filter(r => r.status === 'funded').reduce((sum, r) => sum + r.amount_cents, 0)), count: rows.length });
  },
};

export const REPORT_LIST = [
  { id: 'payment-register', title: 'Payment Request Register' },
  { id: 'petty-cash-register', title: 'Petty Cash Register' },
  { id: 'petty-cash-ledger', title: 'Petty Cash Ledger' },
  { id: 'by-category', title: 'Expenses by Accounting Category' },
  { id: 'by-date', title: 'Expenses by Date' },
  { id: 'by-requester', title: 'Expenses by Requester' },
  { id: 'paid-vs-pending', title: 'Paid vs. Pending Requests' },
  { id: 'cancelled', title: 'Cancelled and Rejected Transactions' },
  { id: 'replenishments', title: 'Petty Cash Replenishment History' },
];

// Two reports expose the fund itself - its balance, its movements and its funding - so they
// carry the same restriction as the fund pages. Without this a maker could read through
// Reports exactly what the dashboard withholds.
const REPORT_ROLES = { 'petty-cash-ledger': PETTY_CASH_FUND_ROLES, replenishments: PETTY_CASH_FUND_ROLES };
export const reportsFor = actor => REPORT_LIST.filter(report => !REPORT_ROLES[report.id] || REPORT_ROLES[report.id].includes(actor.role));

export function runReport(store, actor, id, input = {}) {
  const build = REPORTS[id];
  if (!build) throw new AppError('Unknown report.', 404);
  if (REPORT_ROLES[id]) permit(actor, REPORT_ROLES[id]);
  return build(store, actor, input);
}

// Excel opens a CSV straight from a browser download; a leading apostrophe, equals, plus or
// minus is neutralised so no exported cell is ever treated as a formula.
const cell = value => {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
export function toCsv(result) {
  const header = result.columns.map(c => cell(c.label)).join(',');
  const body = result.rows.map(row => result.columns.map(c => cell(row[c.key])).join(','));
  const totals = Object.entries(result.totals).map(([key, value]) => `${cell(`Total ${key}`)},${cell(value)}`);
  return [`${cell(result.title)}`, `${cell(`Generated ${result.generatedAt}`)}`, '', header, ...body, '', ...totals].join('\r\n');
}
