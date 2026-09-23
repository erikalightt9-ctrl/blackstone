// Fills a database with a small, obviously fictional demo so the screens can be reviewed.
// It refuses to touch a database that already holds accounts, and every password it sets is
// a placeholder that must be changed before the system is used for real work.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { addUser } from '../src/auth.mjs';
import { createRequest, submitRequest, decideRequest, cancelRequest } from '../src/requests.mjs';
import { releasePayment } from '../src/payments.mjs';
import { setOpeningBalance, disburse, recordReturn, createReplenishment, decideReplenishment, fundReplenishment, balance } from '../src/pettycash.mjs';

// Generated, never written down here. A fixed password in a file is a published password:
// this repository is readable, so anything constant in it is known to everyone.
const PLACEHOLDER = `Demo-${randomBytes(9).toString('base64url')}`;
const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.FR_DATA_DIR || path.join(directory, '../data'));
await mkdir(dataDirectory, { recursive: true });
const store = new Store(path.join(dataDirectory, 'finance.sqlite'));

if (store.get('SELECT COUNT(*) AS n FROM users').n) {
  console.error('This database already has user accounts. Delete data/finance.sqlite first if you really want demo data.');
  store.close();
  process.exit(1);
}

// Two people use this system. Demry Cheng and Vicente Cheng approve by signing the printed
// form and hold no account here at all.
// Erika administers and releases: full visibility, but she cannot rewrite a maker's request.
const erika = await addUser(store, { username: 'erika', fullName: 'Erika Hernando', email: 'erika@example.com', role: 'admin', password: PLACEHOLDER });
const maker = await addUser(store, { username: 'maker', fullName: 'Angela Din', email: 'angela.din@example.com', role: 'maker', password: PLACEHOLDER }, erika);

const category = code => store.get('SELECT id FROM categories WHERE code = ?', code).id;
const file = (kind, dateRequested, requestedBy, payee, purpose, finalApprover, lines) =>
  createRequest(store, maker, { kind, dateRequested, requestedBy, payee, purpose, finalApprover, lines });

setOpeningBalance(store, erika, { entryDate: '2026-09-01', amount: 50000, source: '', remarks: 'Opening petty cash fund' });

// A payment request carried all the way through to a released check.
const supplies = file('payment', '2026-09-08', 'Angela Din', 'Metro Office Depot', 'Monthly office supplies for the head office', 'Vicente Cheng', [
  { particulars: 'Bond paper A4, by ream', quantity: 10, unitAmount: 285, categoryId: category('OFFICE-SUPPLIES') },
  { particulars: 'Courier delivery to Cebu branch', quantity: 1, unitAmount: 350, categoryId: category('FREIGHT') },
]);
submitRequest(store, maker, supplies.id);
decideRequest(store, erika, supplies.id, 'approve', { remarks: 'Verified against the supplier quotation' });
releasePayment(store, erika, supplies.id, { method: 'Check', bank: 'BDO Unibank', checkNumber: '0012345', checkDate: '2026-09-10', amount: 3200, payee: 'Metro Office Depot', datePrepared: '2026-09-10', dateReleased: '2026-09-11', receivedBy: 'R. Lim, Metro Office Depot', remarks: 'Picked up by the supplier representative' });

// One waiting for approval, one still a draft, one cancelled after approval.
const professional = file('payment', '2026-09-16', 'Angela Din', 'Cruz & Associates', 'Third quarter statutory audit fee', 'Demry Cheng', [
  { particulars: 'Audit professional fee, third quarter', quantity: 1, unitAmount: 45000, categoryId: category('PROFESSIONAL-FEES') },
]);
submitRequest(store, maker, professional.id);

file('payment', '2026-09-21', 'Angela Din', 'Smart Communications', 'Monthly mobile and internet subscription', 'Vicente Cheng', [
  { particulars: 'Postpaid mobile plans, 6 lines', quantity: 6, unitAmount: 1299, categoryId: category('COMMUNICATION') },
  { particulars: 'Office fibre internet', quantity: 1, unitAmount: 3499, categoryId: category('UTILITIES') },
]);

const duplicate = file('payment', '2026-09-14', 'Angela Din', 'Metro Office Depot', 'Office supplies', 'Vicente Cheng', [
  { particulars: 'Bond paper A4, by ream', quantity: 10, unitAmount: 285, categoryId: category('OFFICE-SUPPLIES') },
]);
submitRequest(store, maker, duplicate.id);
decideRequest(store, erika, duplicate.id, 'approve', {});
cancelRequest(store, erika, duplicate.id, { reason: 'Duplicate of PR-2026-000001; supplier billed only once' });

// Petty cash: one disbursed, one partially returned, one approved, one awaiting approval.
const fares = file('petty_cash', '2026-09-12', 'Angela Din', '', 'Taxi and courier fares for bank errands', 'Vicente Cheng', [
  { particulars: 'Taxi fare to BDO Makati', quantity: 4, unitAmount: 320, categoryId: category('TRANSPORTATION') },
  { particulars: 'Courier to BIR district office', quantity: 2, unitAmount: 185, categoryId: category('FREIGHT') },
]);
submitRequest(store, maker, fares.id);
decideRequest(store, erika, fares.id, 'approve', {});
disburse(store, erika, fares.id, { entryDate: '2026-09-12', receivedBy: 'Angela Din', remarks: '' });

const meeting = file('petty_cash', '2026-09-15', 'Angela Din', '', 'Refreshments for the quarterly management meeting', 'Vicente Cheng', [
  { particulars: 'Meeting refreshments', quantity: 12, unitAmount: 185.75, categoryId: category('MEALS') },
]);
submitRequest(store, maker, meeting.id);
decideRequest(store, erika, meeting.id, 'approve', {});
disburse(store, erika, meeting.id, { entryDate: '2026-09-15', receivedBy: 'Angela Din', remarks: '' });
recordReturn(store, erika, meeting.id, { entryDate: '2026-09-16', amount: 429, reason: 'Fewer attendees than expected; unused cash returned' });

const repairs = file('petty_cash', '2026-09-20', 'Angela Din', '', 'Aircon cleaning for the records room', 'Demry Cheng', [
  { particulars: 'Aircon cleaning, two units', quantity: 2, unitAmount: 750, categoryId: category('REPAIRS') },
]);
submitRequest(store, maker, repairs.id);
decideRequest(store, erika, repairs.id, 'approve', {});

const parking = file('petty_cash', '2026-09-21', 'Angela Din', '', 'Parking and toll fees for client visits', 'Vicente Cheng', [
  { particulars: 'Parking and toll fees', quantity: 1, unitAmount: 640, categoryId: category('TRANSPORTATION') },
]);
submitRequest(store, maker, parking.id);

const replenishment = createReplenishment(store, erika, { entryDate: '2026-09-18', amount: 5000, source: 'BDO current account 0123', remarks: 'Restore the fund to its authorized level' });
decideReplenishment(store, erika, replenishment.id, true);
fundReplenishment(store, erika, replenishment.id, { entryDate: '2026-09-18', remarks: 'Cheque encashed' });

// A few passbook lines so the Bank Records screen has something to show.
const { openBankAccount, createBankRecord } = await import('../src/bank.mjs');
const { createBank, createBankAccount } = await import('../src/accounts.mjs');
// A bank, then an account with it, then the account's beginning balance. All three are things
// an authorised user maintains; none of them is built into the system.
const bdo = createBank(store, erika, { name: 'BDO Unibank', shortName: 'BDO', country: 'Philippines' });
const account = createBankAccount(store, erika, {
  bankId: bdo.id, accountName: 'Operating Account', accountNumber: '0123-4567-89',
  currency: 'PHP', accountType: 'Current / Checking', description: 'Main peso operating account',
}).id;
// A second account, at a different bank and in a different currency, so the register shows
// what more than one account looks like and totals stay per currency.
const hsbc = createBank(store, erika, { name: 'HSBC', country: 'Hong Kong' });
const dollar = createBankAccount(store, erika, {
  bankId: hsbc.id, accountName: 'USD Savings', accountNumber: '801-224466',
  currency: 'USD', accountType: 'Savings', description: 'Foreign currency receipts',
}).id;
// The beginning balance is entered by hand; every figure after it is the system's arithmetic.
openBankAccount(store, maker, { accountId: account, entryDate: '2026-09-01', balance: 162500, remarks: 'Per passbook, carried forward from August' });
openBankAccount(store, maker, { accountId: dollar, entryDate: '2026-09-01', balance: 12000, remarks: 'Per statement, carried forward from August' });
for (const entry of [
  { entryDate: '2026-09-02', reference: 'DEP-00918', type: 'Deposit', description: 'Collection deposit, over the counter', debit: 0, credit: 250000 },
  { entryDate: '2026-09-10', reference: 'CHK-0012345', type: 'Check Payment', description: 'Check 0012345 - Metro Office Depot', debit: 3200, credit: 0 },
  { entryDate: '2026-09-18', reference: 'WD-00231', type: 'Withdrawal', description: 'Petty cash fund replenishment', debit: 5000, credit: 0 },
  { entryDate: '2026-09-30', reference: '', type: 'Bank Charge', description: 'Monthly service charge', debit: 300, credit: 0 },
]) createBankRecord(store, maker, { accountId: account, remarks: '', ...entry });
for (const entry of [
  { entryDate: '2026-09-08', reference: 'TT-5512', type: 'Deposit', description: 'Inward remittance, ore sample assay', debit: 0, credit: 8500 },
  { entryDate: '2026-09-22', reference: '', type: 'Bank Charge', description: 'Account maintenance fee', debit: 12, credit: 0 },
]) createBankRecord(store, maker, { accountId: dollar, remarks: '', ...entry });

console.log(`Demo data created in ${dataDirectory}`);
console.log(`Accounts: erika (administrator and releaser) and maker (Angela Din), both with the password "${PLACEHOLDER}".`);
console.log('Demry Cheng and Vicente Cheng have no accounts: they approve by signing the printed form.');
console.log('Change every password before using this system for real work.');
console.log(`Petty cash balance: ${balance(store).toFixed(2)}`);
store.close();
