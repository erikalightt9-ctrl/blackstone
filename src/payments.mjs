import { randomUUID } from 'node:crypto';
import { releaseSchema } from './schema.mjs';
import { AppError, permit } from './errors.mjs';
import { toCentavos, toPeso } from './money.mjs';
import { transition } from './workflow.mjs';
import { requestRow, getRequest, shapePayment } from './requests.mjs';

// Releasing a payment records the check or transfer details *and* the release in one step.
// The payment is a record attached to the approved request; the approved request itself is
// never modified, and once released the payment record is permanent.
export const RELEASER_ROLES = ['admin', 'approver'];

function paymentRequestRow(store, id) {
  const row = requestRow(store, id);
  if (row.kind !== 'payment') throw new AppError('Check and payment details apply to Payment Requests only. Petty cash is disbursed from the fund.', 409);
  return row;
}

export function releasePayment(store, actor, requestId, input) {
  permit(actor, RELEASER_ROLES);
  const value = releaseSchema.parse(input);
  return store.transaction(() => {
    const row = paymentRequestRow(store, requestId);
    const status = transition('payment', 'release', row.status);
    const amountCents = toCentavos(value.amount);
    if (amountCents > row.total_cents) throw new AppError(`The payment of ${value.amount.toFixed(2)} exceeds the approved total of ${toPeso(row.total_cents).toFixed(2)}. Cancel the request and file a corrected one.`);
    const at = new Date().toISOString();
    store.run(`INSERT INTO payments(id, request_id, method, bank, check_number, check_date, amount_cents, payee, date_prepared, date_released, released_by, received_by, remarks, recorded_by, recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(), requestId, value.method, value.bank, value.checkNumber, value.checkDate, amountCents, value.payee,
    value.datePrepared, value.dateReleased, actor.fullName, value.receivedBy, value.remarks, actor.fullName, at);
    store.run('UPDATE requests SET status = ?, settled_at = ?, updated_at = ? WHERE id = ?', status, at, at, requestId);
    const reference = value.method === 'Check' ? `${value.bank || 'Check'} ${value.checkNumber}` : value.method;
    store.log(actor, 'release', 'request', requestId, {
      status,
      detail: `Payment released to ${value.receivedBy} on ${value.dateReleased} - ${reference} for ${value.amount.toFixed(2)}`,
      after: shapePayment(store.get('SELECT * FROM payments WHERE request_id = ?', requestId)),
    });
    return getRequest(store, actor, requestId);
  });
}

export const getPayment = (store, requestId) => {
  const row = store.get('SELECT * FROM payments WHERE request_id = ?', requestId);
  return row ? shapePayment(row) : null;
};
