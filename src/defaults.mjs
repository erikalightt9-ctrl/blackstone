// Seed values only. Everything here is editable at runtime through the configuration and
// category master list, so adding a category or an approver never requires a code change.
export const DEFAULT_CONFIG = {
  companyName: 'BLACK STONE MINERAL RESOURCES INC',
  paymentNumberFormat: 'PR-{YYYY}-{SEQ:6}',
  pettyCashNumberFormat: 'PCR-{YYYY}-{SEQ:6}',
  replenishmentNumberFormat: 'PCF-{YYYY}-{SEQ:4}',
  finalApprovers: ['Demry Cheng', 'Vicente Cheng'],
  defaultFinalApprover: 'Demry Cheng',
  pettyCashOpeningBalance: 0,
  // The kinds of account a bank account may be. A list, not a rule: an administrator edits it
  // in Settings when a bank offers something this one does not name.
  accountTypes: ['Savings', 'Current / Checking', 'Time Deposit', 'Money Market', 'Trust', 'Other'],
  // The currency the books are kept in. Individual bank accounts carry their own currency and
  // are not bound by this; it is only what a new account is offered first.
  baseCurrency: 'PHP',
  currencySymbol: '₱',
  timeZone: 'Asia/Manila',
  appUrl: '',
};
export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

export const DEFAULT_CATEGORIES = [
  ['ADVERTISING', 'Advertising and Promotions'],
  ['BANK-CHARGES', 'Bank Charges'],
  ['COMMUNICATION', 'Communication'],
  ['EVENTS', 'Event Expenses'],
  ['FREIGHT', 'Freight & Delivery'],
  ['FUEL', 'Fuel Expenses'],
  ['GOVT-FEES', 'Government Fees'],
  ['GOVT-REMITTANCE', 'Government Remittance'],
  ['MEALS', 'Meals'],
  ['MISCELLANEOUS', 'Miscellaneous Expense'],
  ['OFFICE-RENT', 'Office Rent'],
  ['OFFICE-SUPPLIES', 'Office Supplies'],
  ['PARKING-RENT', 'Parking Rent'],
  ['PROFESSIONAL-FEES', 'Professional Fees'],
  ['REPAIRS', 'Repairs and Maintenance'],
  ['REPRESENTATION', 'Representation and Entertainment'],
  ['RETAINERS-FEE', 'Retainers Fee'],
  ['SALARIES-WAGES', 'Salaries and Wages'],
  ['SPONSORSHIP', 'Sponsorship'],
  ['TRANSPORTATION', 'Transportation'],
  ['UTILITIES', 'Utilities'],
];

export const ROLES = ['admin', 'maker', 'approver', 'viewer'];
// The people who actually approve - Demry Cheng and Vicente Cheng - sign the printed form
// and hold no account here. A "Releaser" is the member of staff who records that signed
// approval in the system and then releases the payment or disburses the cash.
export const ROLE_LABELS = { admin: 'Administrator / Releaser', maker: 'Maker', approver: 'Releaser', viewer: 'Viewer' };
// The Accounting / Internal copy carries the expense classifications and stays with these roles.
export const ACCOUNTING_COPY_ROLES = ['admin', 'approver'];
export const PAYMENT_METHODS = ['Check', 'Bank Transfer', 'Cash', 'Online Payment'];
export const LEDGER_TYPES = ['opening', 'replenishment', 'disbursement', 'return', 'adjustment'];

// Bank Records transcribe the official passbook, so the types mirror what a passbook prints.
export const BANK_TRANSACTION_TYPES = ['Deposit', 'Withdrawal', 'Check Payment', 'Bank Transfer', 'Bank Charge', 'Interest', 'Adjustment', 'Other'];
// The one entry type nobody picks from the list: it is created by entering the account's
// beginning balance, and it is the figure every later balance is worked out from.
export const BANK_OPENING_TYPE = 'Opening Balance';
// The petty cash fund balance is a restricted figure. A maker records requests against it but
// is never shown what is in the box.
export const PETTY_CASH_FUND_ROLES = ['admin', 'approver', 'viewer'];
export const BANK_RECORD_ROLES = ['admin', 'approver', 'maker'];
// Who may open a bank or a bank account, rename one, or take one out of use. Makers encode
// against the accounts but do not decide which accounts the company has.
export const BANK_ADMIN_ROLES = ['admin', 'approver'];

// Starting currencies, written once when the database is new and never re-seeded, so one
// removed by an administrator stays removed. Every field of every row is editable, more can
// be added at any time, and nothing in the system requires any particular currency to exist.
// JPY is here with no minor unit precisely because the decimal places are data, not an
// assumption: an amount is validated and displayed to whatever its own currency says.
export const SEED_CURRENCIES = [
  ['PHP', 'Philippine Peso', '₱', 2],
  ['USD', 'US Dollar', '$', 2],
  ['EUR', 'Euro', '€', 2],
  ['GBP', 'Pound Sterling', '£', 2],
  ['JPY', 'Japanese Yen', '¥', 0],
  ['SGD', 'Singapore Dollar', 'S$', 2],
  ['HKD', 'Hong Kong Dollar', 'HK$', 2],
  ['CNY', 'Chinese Yuan', '¥', 2],
  ['AUD', 'Australian Dollar', 'A$', 2],
  ['CAD', 'Canadian Dollar', 'C$', 2],
];
