import { AppError, permit } from './errors.mjs';
import { buildWorkbook, readWorkbook, cellText, cellDate, cellNumber, STYLE } from './xlsx.mjs';
import { bankAccounts, importBankRows } from './bank.mjs';
import { isoDate } from './schema.mjs';
import { BANK_RECORD_ROLES, BANK_TRANSACTION_TYPES, BANK_OPENING_TYPE } from './defaults.mjs';

// Bulk encoding of a historical passbook from a spreadsheet.
//
// The template is generated rather than shipped, so the account list, the transaction types
// and the currencies in it are always the ones this database actually holds - a dropdown
// cannot offer an account that does not exist.
//
// Nothing is written until the person has seen what would be written. An upload is read,
// matched, validated and summarised into a plan; only a second, explicit call commits it. One
// unusable row refuses the whole file, and the reasons are reported by sheet and row number
// so a 400-line passbook can be fixed in the spreadsheet rather than guessed at.

const TRANSACTIONS = 'Transactions';
const OPENINGS = 'Beginning Balances';
const ACCOUNTS = 'Accounts';
const GUIDE = 'How to use';

const MAX_ROWS = 5000;
const MAX_BYTES = 6_000_000;

// The columns, in the order the passbook reads. No balance column: the running balance is
// worked out from the movements and is not something the file gets to state.
const COLUMNS = [
  ['Account', 30],
  ['Date', 14, STYLE.date],
  ['Check No.', 16],
  ['Particulars', 44],
  ['Type', 18],
  ['Debit', 16, STYLE.money],
  ['Credit', 16, STYLE.money],
  ['Remarks', 30],
];

const OPENING_COLUMNS = [
  ['Account', 30],
  ['As of date', 14, STYLE.date],
  ['Beginning balance', 20, STYLE.money],
  ['Remarks', 30],
];

const GUIDE_LINES = [
  ['Bulk encoding of bank records', STYLE.title],
  [''],
  ['Fill in the two sheets in this workbook and upload it under Bank Records > Import from Excel.'],
  [''],
  ['1. Beginning Balances', STYLE.title],
  ['An account cannot hold transactions until its beginning balance has been entered. If the'],
  ['account is already open in the system, leave it off this sheet. If it is not, put one row'],
  ['here: the account, the date the figure is as of, and the balance the passbook shows before'],
  ['the first transaction you are about to encode.'],
  [''],
  ['2. Transactions', STYLE.title],
  ['One row per passbook line. Pick the account from the dropdown, then enter the date, the'],
  ['check number if the line has one, the particulars as the passbook prints them, the type,'],
  ['and the amount in EITHER Debit or Credit - never both, never neither.'],
  [''],
  ['There is deliberately no Balance column.', STYLE.title],
  ['The running balance is worked out by the system: previous balance, plus the credit, less'],
  ['the debit. That is why the column cannot disagree with the movements. The only balance'],
  ['anyone ever enters is the beginning balance on the first sheet.'],
  [''],
  ['Dates', STYLE.title],
  ['Format the Date column as a date and Excel will handle it. Typed text works too, as long'],
  ['as it is unambiguous: 2026-09-30 always reads correctly, and 30/09/2026 does because 30'],
  ['cannot be a month. 09/03/2026 is rejected rather than guessed at.'],
  [''],
  ['Amounts', STYLE.title],
  ['Enter the amount in the currency of the account on that row - the Accounts sheet lists'],
  ['each one. Most currencies take two decimal places; some, such as the yen, take none and'],
  ['are entered as whole numbers.'],
  [''],
  ['Nothing is imported until every row is valid.', STYLE.title],
  ['The file is checked first and you are shown exactly what would be added. If any row cannot'],
  ['be read, nothing at all is imported and every problem is listed with its row number, so a'],
  ['half-loaded passbook can never happen.'],
  [''],
  ['After importing', STYLE.title],
  ['Imported lines behave exactly like hand-encoded ones: each carries who imported it and'],
  ['when, each can be corrected, and none can ever be deleted - a wrong line is voided and'],
  ['stays on file.'],
];

export function bankImportTemplate(store, actor) {
  permit(actor, BANK_RECORD_ROLES);
  const accounts = bankAccounts(store).filter(account => account.active);
  if (!accounts.length) throw new AppError('There are no bank accounts to import against yet. Add a bank and an account under Bank Accounts first.', 409);

  const header = columns => ({ cells: columns.map(([label]) => label), styles: columns.map(() => STYLE.header), height: 22 });
  const widths = columns => columns.map(([, width, style]) => ({ width, style }));
  // The account dropdown points at a range rather than an inline list, which Excel caps at
  // around 255 characters - a company with a dozen accounts would silently lose the list.
  const accountList = { range: 'A2:A5000', formula: `${ACCOUNTS}!$A$2:$A$${accounts.length + 1}` };

  return buildWorkbook([
    {
      name: TRANSACTIONS,
      freeze: 1,
      columns: widths(COLUMNS),
      rows: [header(COLUMNS)],
      validation: [accountList, { range: 'E2:E5000', values: BANK_TRANSACTION_TYPES }],
    },
    {
      name: OPENINGS,
      freeze: 1,
      columns: widths(OPENING_COLUMNS),
      rows: [header(OPENING_COLUMNS)],
      validation: [accountList],
    },
    {
      name: ACCOUNTS,
      freeze: 1,
      columns: [{ width: 30 }, { width: 24 }, { width: 22 }, { width: 20 }, { width: 10 }, { width: 22 }],
      rows: [
        header([['Account', 30], ['Bank', 24], ['Account name', 22], ['Number', 20], ['Currency', 10], ['Beginning balance', 22]]),
        ...accounts.map(account => ({
          cells: [account.account, account.bankName, account.accountName, account.accountNumber, account.currency,
            account.opened ? 'already entered' : 'still needed'],
        })),
      ],
    },
    {
      name: GUIDE,
      columns: [{ width: 96 }],
      rows: GUIDE_LINES.map(([text, style]) => ({ cells: [text], style: style ?? STYLE.plain })),
    },
  ]);
}

// ---------------------------------------------------------------- reading

// An account is named by its label, its number, or "bank - account name". Whichever the
// person used, it has to resolve to exactly one account or the row is refused by name.
function accountIndex(accounts) {
  const index = new Map();
  const add = (key, account) => {
    if (!key) return;
    const normalised = key.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalised) return;
    const existing = index.get(normalised);
    if (existing && existing.id !== account.id) index.set(normalised, { ambiguous: true });
    else if (!existing) index.set(normalised, account);
  };
  for (const account of accounts) {
    add(account.account, account);
    add(account.accountNumber, account);
    add(`${account.bankName} ${account.accountName}`, account);
    add(`${account.bankName} - ${account.accountName}`, account);
    add(account.accountName, account);
  }
  return index;
}

const rowsOf = (sheets, name) => sheets.get(name) || [];

// A sheet row is blank when every cell in it is. Excel leaves plenty of these behind.
const blank = row => !row || row.every(cell => !cell || cellText(cell) === '');

export function readBankImport(store, actor, input) {
  permit(actor, BANK_RECORD_ROLES);
  const fileName = String(input?.name || 'spreadsheet').slice(0, 200);
  const content = String(input?.content || '');
  if (!content) throw new AppError('No file was uploaded.');
  const buffer = Buffer.from(content, 'base64');
  if (!buffer.length) throw new AppError('That file is empty.');
  if (buffer.length > MAX_BYTES) throw new AppError(`That file is ${(buffer.length / 1_000_000).toFixed(1)} MB. Imports are limited to ${MAX_BYTES / 1_000_000} MB - split the passbook into smaller files.`, 413);

  const sheets = readWorkbook(buffer);
  if (!sheets.has(TRANSACTIONS) && !sheets.has(OPENINGS)) {
    throw new AppError(`That workbook has no "${TRANSACTIONS}" sheet. Download the template and fill that in, or rename your sheet to ${TRANSACTIONS}.`);
  }

  const accounts = bankAccounts(store);
  const index = accountIndex(accounts);
  const problems = [];
  const fail = (sheet, row, message) => problems.push({ sheet, row, message });

  const resolve = (sheet, rowNumber, text) => {
    if (!text) { fail(sheet, rowNumber, 'No account named.'); return null; }
    const match = index.get(text.trim().toLowerCase().replace(/\s+/g, ' '));
    if (!match) { fail(sheet, rowNumber, `No bank account matches "${text}". Pick one from the dropdown on the Accounts sheet.`); return null; }
    if (match.ambiguous) { fail(sheet, rowNumber, `"${text}" matches more than one account. Use the full label from the Accounts sheet.`); return null; }
    if (!match.active) { fail(sheet, rowNumber, `${match.account} is not in use, so nothing can be encoded against it.`); return null; }
    return match;
  };

  const readDate = (sheet, rowNumber, cell, label) => {
    const value = cellDate(cell);
    if (!value) {
      fail(sheet, rowNumber, cellText(cell)
        ? `${label} "${cellText(cell)}" could not be read as a date. Use a real date cell, or write it as 2026-09-30.`
        : `${label} is missing.`);
      return '';
    }
    const parsed = isoDate.safeParse(value);
    if (!parsed.success) { fail(sheet, rowNumber, `${label} "${value}" is not a calendar date.`); return ''; }
    return value;
  };

  const readAmount = (sheet, rowNumber, cell, label) => {
    const value = cellNumber(cell);
    if (Number.isNaN(value)) { fail(sheet, rowNumber, `${label} "${cellText(cell)}" is not a number.`); return 0; }
    if (value < 0) { fail(sheet, rowNumber, `${label} cannot be negative. A withdrawal goes in Debit and a deposit in Credit.`); return 0; }
    return value;
  };

  // ---- beginning balances
  const openings = [];
  const openingRows = rowsOf(sheets, OPENINGS);
  for (let i = 1; i < openingRows.length; i++) {
    const row = openingRows[i];
    if (blank(row)) continue;
    const rowNumber = i + 1;
    const account = resolve(OPENINGS, rowNumber, cellText(row[0]));
    const entryDate = readDate(OPENINGS, rowNumber, row[1], 'As of date');
    const balance = readAmount(OPENINGS, rowNumber, row[2], 'Beginning balance');
    if (!account) continue;
    if (account.opened) {
      fail(OPENINGS, rowNumber, `${account.account} already has a beginning balance in the system. Remove this row - its transactions can be imported on their own.`);
      continue;
    }
    if (openings.some(opening => opening.accountId === account.id)) {
      fail(OPENINGS, rowNumber, `${account.account} appears twice on this sheet. An account has one beginning balance.`);
      continue;
    }
    openings.push({ accountId: account.id, account: account.account, currency: account.currency, entryDate, balance, remarks: cellText(row[3]).slice(0, 2000) });
  }

  // ---- transactions
  const lines = [];
  const transactionRows = rowsOf(sheets, TRANSACTIONS);
  if (transactionRows.length - 1 > MAX_ROWS) {
    throw new AppError(`That sheet has ${transactionRows.length - 1} rows. Imports are limited to ${MAX_ROWS} at a time - split the passbook by month or by year.`, 413);
  }
  for (let i = 1; i < transactionRows.length; i++) {
    const row = transactionRows[i];
    if (blank(row)) continue;
    const rowNumber = i + 1;
    const account = resolve(TRANSACTIONS, rowNumber, cellText(row[0]));
    const entryDate = readDate(TRANSACTIONS, rowNumber, row[1], 'Date');
    const description = cellText(row[3]);
    const typeText = cellText(row[4]);
    const debit = readAmount(TRANSACTIONS, rowNumber, row[5], 'Debit');
    const credit = readAmount(TRANSACTIONS, rowNumber, row[6], 'Credit');

    if (!description) fail(TRANSACTIONS, rowNumber, 'Particulars is empty. Copy the description the passbook prints.');
    if (debit > 0 && credit > 0) fail(TRANSACTIONS, rowNumber, 'A passbook line is either a debit or a credit, not both.');
    if (!debit && !credit) fail(TRANSACTIONS, rowNumber, 'Enter the amount in either Debit or Credit.');

    // The type is a convenience, not a gate: a row that omits it is read from the amount.
    let type = BANK_TRANSACTION_TYPES.find(known => known.toLowerCase() === typeText.toLowerCase());
    if (typeText.toLowerCase() === BANK_OPENING_TYPE.toLowerCase()) {
      // Worth its own message: this is a person putting the opening figure on the wrong
      // sheet, not a person inventing a transaction type.
      fail(TRANSACTIONS, rowNumber, `A beginning balance is not a transaction. Put it on the "${OPENINGS}" sheet instead.`);
    } else if (!type && typeText) {
      fail(TRANSACTIONS, rowNumber, `Type "${typeText}" is not one of: ${BANK_TRANSACTION_TYPES.join(', ')}.`);
    } else if (!type) {
      type = debit > 0 ? 'Withdrawal' : 'Deposit';
    }
    if (!account) continue;

    lines.push({
      row: rowNumber, accountId: account.id, account: account.account, currency: account.currency,
      entryDate, reference: cellText(row[2]).slice(0, 80), description: description.slice(0, 400),
      type, debit, credit, remarks: cellText(row[7]).slice(0, 2000),
    });
  }

  if (!openings.length && !lines.length && !problems.length) {
    throw new AppError('That workbook has no rows to import. Fill in the Transactions sheet and try again.');
  }

  // An account that is not open, is not being opened by this file, and has lines in it.
  for (const accountId of new Set(lines.map(line => line.accountId))) {
    const account = accounts.find(item => item.id === accountId);
    if (account.opened || openings.some(opening => opening.accountId === accountId)) continue;
    const first = lines.find(line => line.accountId === accountId);
    fail(TRANSACTIONS, first.row, `${account.account} has no beginning balance. Add one row for it on the "${OPENINGS}" sheet, or enter the beginning balance in the system first.`);
  }

  // A line dated before the figure it is supposed to follow.
  for (const line of lines) {
    const opening = openings.find(item => item.accountId === line.accountId);
    const openedOn = opening ? opening.entryDate : accounts.find(item => item.id === line.accountId)?.openedOn;
    if (openedOn && line.entryDate && line.entryDate < openedOn) {
      fail(TRANSACTIONS, line.row, `${line.entryDate} is before the beginning balance of ${line.account} (${openedOn}). A transaction cannot predate the opening figure.`);
    }
  }

  return { fileName, openings, lines, problems, accounts };
}

// ---------------------------------------------------------------- preview

// What the import would do, per account, and anything about it worth a second look.
export function previewBankImport(store, actor, input) {
  const { fileName, openings, lines, problems, accounts } = readBankImport(store, actor, input);

  const summary = [];
  for (const accountId of new Set([...openings.map(o => o.accountId), ...lines.map(l => l.accountId)])) {
    const account = accounts.find(item => item.id === accountId);
    const own = lines.filter(line => line.accountId === accountId);
    const dates = own.map(line => line.entryDate).filter(Boolean).sort();
    const opening = openings.find(item => item.accountId === accountId);
    const debit = own.reduce((total, line) => total + line.debit, 0);
    const credit = own.reduce((total, line) => total + line.credit, 0);
    summary.push({
      accountId, account: account.account, bankName: account.bankName,
      currency: account.currency, symbol: account.currencySymbol, decimals: account.currencyDecimals,
      opening: opening ? opening.balance : null, openingDate: opening ? opening.entryDate : '',
      alreadyOpen: account.opened, lines: own.length,
      from: dates[0] || '', to: dates.at(-1) || '', debit, credit,
    });
  }

  // Re-importing the same file is an easy mistake to make, and a passbook can legitimately
  // repeat a line, so this is reported rather than refused.
  const duplicates = [];
  const existing = store.db.prepare(`SELECT COUNT(*) AS n FROM bank_records
    WHERE account_id = ? AND entry_date = ? AND reference = ? AND debit_cents = ? AND credit_cents = ? AND voided = 0`);
  for (const line of lines) {
    const account = accounts.find(item => item.id === line.accountId);
    const factor = 10 ** (account.currencyDecimals ?? 2);
    const hit = existing.get(line.accountId, line.entryDate, line.reference,
      Math.round(line.debit * factor), Math.round(line.credit * factor));
    if (hit.n) duplicates.push({ row: line.row, account: line.account, entryDate: line.entryDate, reference: line.reference, description: line.description });
  }

  return {
    fileName, summary, duplicates,
    openings: openings.length, lines: lines.length,
    problems: problems.slice(0, 200), problemCount: problems.length,
    ready: problems.length === 0,
  };
}

export function commitBankImport(store, actor, input) {
  const { fileName, openings, lines, problems } = readBankImport(store, actor, input);
  if (problems.length) {
    throw new AppError(`${problems.length} row${problems.length === 1 ? '' : 's'} could not be read, so nothing was imported. ${problems.slice(0, 3).map(p => `${p.sheet} row ${p.row}: ${p.message}`).join(' ')}`, 422);
  }
  return importBankRows(store, actor, { openings, lines, fileName });
}
