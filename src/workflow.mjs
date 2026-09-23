// The single source of truth for request status. Every state change goes through
// `transition`, so no route can invent a status or skip a step.
//
// The flow is deliberately short. Two people move a request:
//   Maker             prepares it and submits it
//   Approver/Releaser approves it, then releases the payment or disburses the cash
// Final approval is a physical signature on the printed form, not a step in this system;
// the selected final approver's name is printed in the PDF's signature block.
export const KINDS = ['payment', 'petty_cash'];
export const STATUSES = ['draft', 'submitted', 'approved', 'paid', 'disbursed', 'rejected', 'cancelled'];
export const STATUS_LABELS = {
  draft: 'Draft', submitted: 'For Approval', approved: 'Approved',
  paid: 'Released', disbursed: 'Disbursed', rejected: 'Rejected', cancelled: 'CANCELLED',
};
export const KIND_LABELS = { payment: 'Payment Request', petty_cash: 'Petty Cash Request' };

const shared = {
  submit: { from: ['draft'], to: 'submitted', roles: ['admin', 'maker', 'requester'] },
  approve: { from: ['submitted'], to: 'approved', roles: ['admin', 'approver'] },
  reject: { from: ['submitted'], to: 'rejected', roles: ['admin', 'approver'] },
  cancel: { from: ['draft', 'submitted', 'approved', 'paid', 'disbursed'], to: 'cancelled', roles: ['admin', 'approver'] },
};
export const ACTIONS = {
  payment: {
    ...shared,
    // One step: the check or transfer details are recorded and the payment released together.
    release: { from: ['approved'], to: 'paid', roles: ['admin', 'approver'] },
  },
  petty_cash: {
    ...shared,
    disburse: { from: ['approved'], to: 'disbursed', roles: ['admin', 'approver'] },
    return: { from: ['disbursed', 'cancelled'], to: null, roles: ['admin', 'approver'] }, // A ledger reversal; the status is untouched.
  },
};

// Draft is the only status whose own particulars, amounts and categories may be rewritten.
export const isEditable = status => status === 'draft';
// From approval onward the financial record is permanent: correct it by cancelling and re-filing.
export const isFinanciallyLocked = status => ['approved', 'paid', 'disbursed', 'rejected', 'cancelled'].includes(status);
export const isTerminal = status => ['paid', 'disbursed', 'rejected', 'cancelled'].includes(status);
export const isOpen = status => !isTerminal(status);

export function actionFor(kind, action) {
  const rule = ACTIONS[kind]?.[action];
  if (!rule) throw new WorkflowError(`Unknown action "${action}" for a ${KIND_LABELS[kind] || kind}.`, 404);
  return rule;
}
export class WorkflowError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export function transition(kind, action, current) {
  const rule = actionFor(kind, action);
  if (!rule.from.includes(current)) {
    throw new WorkflowError(`A ${STATUS_LABELS[current] || current} ${KIND_LABELS[kind] || kind} cannot be ${pastTense(action)}. Allowed from: ${rule.from.map(s => STATUS_LABELS[s]).join(', ')}.`, 409);
  }
  return rule.to ?? current;
}
const pastTense = action => ({ submit: 'submitted', approve: 'approved', reject: 'rejected', cancel: 'cancelled', release: 'released', disburse: 'disbursed', return: 'reversed' })[action] || action;

// Actions a given role may attempt at all, used to shape the UI and to fail closed on the server.
export const permitsRole = (kind, action, role) => actionFor(kind, action).roles.includes(role);
export const availableActions = (kind, status, role) => Object.entries(ACTIONS[kind] || {})
  .filter(([, rule]) => rule.from.includes(status) && rule.roles.includes(role))
  .map(([action]) => action);
