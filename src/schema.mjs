import { z } from 'zod';
import { KINDS } from './workflow.mjs';
import { ROLES, PAYMENT_METHODS, BANK_TRANSACTION_TYPES } from './defaults.mjs';

// Validation at the system boundary. Every amount arrives in pesos and is checked for two
// decimal places here; the service layer converts to centavos before anything is stored.
const text = max => z.string().trim().min(1).max(max);
// An amount whose precision depends on the currency it is in. The number of decimal places is
// checked by the service layer against that currency, which is the only place that knows it.
const amount = z.number().finite().min(0).max(1e11);
const optionalText = max => z.string().trim().max(max).default('');
export const uuid = z.string().uuid();
// The refinement must never throw on malformed input: every other check in the object
// still runs after a failed regex, so it has to tolerate whatever arrived.
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
  .refine(v => { const date = new Date(`${v}T00:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v; }, 'That calendar date does not exist');
const optionalDate = z.union([isoDate, z.literal('')]).default('');

const decimals = (value, places) => Math.abs(value * 10 ** places - Math.round(value * 10 ** places)) < 1e-6;
export const peso = z.number().finite().nonnegative().max(1e11)
  .refine(v => decimals(v, 2), 'Use at most two decimal places');
export const positivePeso = peso.refine(v => v > 0, 'Enter an amount greater than zero');
const quantity = z.number().finite().positive('Enter a quantity greater than zero').max(1e6).refine(v => decimals(v, 3), 'Use at most three decimal places for quantity');

export const lineSchema = z.object({
  particulars: text(300),
  quantity,
  unitAmount: positivePeso,
  categoryId: uuid,
}).strict();

export const requestSchema = z.object({
  dateRequested: isoDate,
  requestedBy: text(160),
  payee: optionalText(160),
  purpose: optionalText(2000),
  finalApprover: text(120),
  lines: z.array(lineSchema).max(100).default([]),
}).strict();

export const createRequestSchema = requestSchema.extend({ kind: z.enum(KINDS) });

export const decisionSchema = z.object({ remarks: optionalText(2000) }).strict();
export const commentSchema = z.object({ text: text(2000).refine(v => v.length >= 3, 'Write a comment of at least three characters') }).strict();
export const cancelSchema = z.object({ reason: text(2000).refine(v => v.length >= 5, 'Give a cancellation reason of at least five characters') }).strict();

// Releasing a payment captures the check or transfer details and the release together.
export const releaseSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  bank: optionalText(160),
  checkNumber: optionalText(60),
  checkDate: optionalDate,
  amount: positivePeso,
  payee: text(160),
  datePrepared: isoDate,
  dateReleased: isoDate,
  receivedBy: text(160),
  remarks: optionalText(2000),
}).strict().refine(v => v.method !== 'Check' || (v.checkNumber && v.checkDate), 'A check payment needs a check number and check date.');

export const disburseSchema = z.object({
  entryDate: isoDate,
  receivedBy: text(160),
  remarks: optionalText(2000),
}).strict();

export const returnSchema = z.object({
  entryDate: isoDate,
  amount: positivePeso,
  reason: text(2000),
}).strict();

export const adjustmentSchema = z.object({
  entryDate: isoDate,
  amount: positivePeso,
  reason: text(2000),
  direction: z.enum(['in', 'out']),
}).strict();

export const replenishmentSchema = z.object({
  entryDate: isoDate,
  amount: positivePeso,
  source: optionalText(160),
  remarks: optionalText(2000),
}).strict();

export const fundingSchema = z.object({ entryDate: isoDate, remarks: optionalText(2000) }).strict();

// A passbook line carries a withdrawal or a deposit, never both. No balance is entered here:
// the running balance is the system's arithmetic from the account's beginning balance.
export const bankRecordSchema = z.object({
  accountId: uuid,
  entryDate: isoDate,
  reference: optionalText(80),
  type: z.enum(BANK_TRANSACTION_TYPES),
  description: text(400),
  debit: amount.default(0),
  credit: amount.default(0),
  remarks: optionalText(2000),
}).strict()
  .refine(v => v.debit > 0 || v.credit > 0, 'Enter either a withdrawal or a deposit amount.')
  .refine(v => !(v.debit > 0 && v.credit > 0), 'A passbook line is either a withdrawal or a deposit, not both.');

// The beginning balance an account starts from. Entered once; every later balance follows
// from it, so it is the only balance figure anyone types.
export const bankOpeningSchema = z.object({
  accountId: uuid,
  entryDate: isoDate,
  balance: amount,
  remarks: optionalText(2000),
}).strict();

// ---------------------------------------------------------------- banks and accounts
//
// Nothing here names a bank or a currency. A currency code is any three to six letters, so a
// company can record an account in something this system has never heard of.
export const currencySchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/, 'Use a short currency code such as PHP, USD or AED'),
  name: text(80),
  symbol: optionalText(6),
  decimals: z.number().int().min(0).max(6).default(2),
  active: z.boolean().default(true),
}).strict();

export const currencyUpdateSchema = currencySchema.omit({ code: true });

export const bankSchema = z.object({
  name: text(160),
  shortName: optionalText(40),
  country: optionalText(80),
  active: z.boolean().default(true),
}).strict();

export const bankAccountSchema = z.object({
  bankId: uuid,
  accountName: text(160),
  accountNumber: optionalText(60),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/, 'Choose a currency'),
  accountType: optionalText(60),
  description: optionalText(400),
  active: z.boolean().default(true),
}).strict();

export const bankVoidSchema = z.object({ reason: text(2000).refine(v => v.length >= 5, 'Give a reason of at least five characters') }).strict();

export const categorySchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/, 'Use letters, numbers, spaces and - . _ / only'),
  name: text(120),
  active: z.boolean().default(true),
}).strict();

// The registered email address is the account's identity for sign-in and for password
// resets. Only an administrator sets it, and nobody can self-register.
export const email = z.string().trim().toLowerCase().max(200)
  .refine(v => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(v), 'Enter a valid email address');

export const username = z.string().trim().regex(/^[A-Za-z0-9_.@-]{3,80}$/, 'Usernames use letters, numbers and _ . @ - only, at least three characters');

export const userSchema = z.object({
  username,
  fullName: text(160),
  email,
  password: z.string().min(12, 'Use a password of at least 12 characters').max(200),
  role: z.enum(ROLES),
}).strict();

export const userUpdateSchema = z.object({ username, fullName: text(160), email, role: z.enum(ROLES) }).strict();
export const resetRequestSchema = z.object({ identifier: z.string().trim().min(1).max(200) }).strict();
export const resetRedeemSchema = z.object({
  token: z.string().trim().regex(/^[a-f0-9]{64}$/, 'That reset link is not valid.'),
  password: z.string().min(12, 'Use a password of at least 12 characters').max(200),
}).strict();

export const loginSchema = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(200) }).strict();
export const passwordSchema = z.object({ currentPassword: z.string().max(200), newPassword: z.string().min(12).max(200) }).strict();

export const configSchema = z.object({
  companyName: text(160).optional(),
  paymentNumberFormat: z.string().trim().max(60).optional(),
  pettyCashNumberFormat: z.string().trim().max(60).optional(),
  replenishmentNumberFormat: z.string().trim().max(60).optional(),
  finalApprovers: z.array(text(120)).min(1).max(20).optional(),
  defaultFinalApprover: text(120).optional(),
  currencySymbol: z.string().trim().min(1).max(4).optional(),
  // The kinds of bank account on offer, and the currency a new account is offered first.
  // Both are lists an administrator maintains rather than anything the system fixes.
  accountTypes: z.array(text(60)).max(40).optional(),
  baseCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/, 'Use a currency code such as PHP').optional(),
}).strict();

export const documentSchema = z.object({
  name: text(200),
  mime: z.string().trim().regex(/^[-\w.+]+\/[-\w.+]+$/, 'Unsupported file type').max(120),
  content: z.string().max(9_500_000), // base64
}).strict();

export const searchSchema = z.object({
  kind: z.enum(KINDS).optional(),
  status: z.string().trim().max(40).optional(),
  number: z.string().trim().max(60).optional(),
  requester: z.string().trim().max(160).optional(),
  payee: z.string().trim().max(160).optional(),
  categoryId: uuid.optional(),
  approver: z.string().trim().max(160).optional(),
  checkNumber: z.string().trim().max(60).optional(),
  paymentStatus: z.enum(['paid', 'unpaid']).optional(),
  from: optionalDate,
  to: optionalDate,
  minAmount: peso.optional(),
  maxAmount: peso.optional(),
  text: z.string().trim().max(160).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict();

export const zodMessage = error => error.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
