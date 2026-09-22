import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { newStore, actors, demoBankAccount } from './helpers.mjs';
import { bankImportTemplate, previewBankImport, commitBankImport } from '../src/bank-import.mjs';
import { openBankAccount, listBankRecords } from '../src/bank.mjs';
import { buildWorkbook, readWorkbook, serialToDate } from '../src/xlsx.mjs';

const HEAD = ['Account', 'Date', 'Check No.', 'Particulars', 'Type', 'Debit', 'Credit', 'Remarks'];
const OPEN_HEAD = ['Account', 'As of date', 'Beginning balance', 'Remarks'];

// A filled-in copy of the template, as the person uploading one would have.
const workbook = ({ lines = [], openings = [] } = {}) => buildWorkbook([
  { name: 'Transactions', rows: [{ cells: HEAD }, ...lines.map(cells => ({ cells }))] },
  { name: 'Beginning Balances', rows: [{ cells: OPEN_HEAD }, ...openings.map(cells => ({ cells }))] },
]);

const upload = (parts, name = 'passbook.xlsx') => ({ name, content: workbook(parts).toString('base64') });

const account = store => demoBankAccount(store, { bankName: 'BDO Unibank', accountNumber: '0123-4567-89' });

test('the template is generated from this database, so it can only offer real accounts', () => {
  const store = newStore();
  const first = account(store);
  demoBankAccount(store, { bankName: 'HSBC', accountNumber: '801-224466', accountName: 'USD Savings', currency: 'USD' });

  const sheets = readWorkbook(bankImportTemplate(store, actors.maker));
  assert.deepEqual([...sheets.keys()], ['Transactions', 'Beginning Balances', 'Accounts', 'How to use']);
  assert.deepEqual(sheets.get('Transactions')[0].map(cell => cell.value), HEAD, 'the passbook columns, and no Balance column');
  assert.deepEqual(sheets.get('Beginning Balances')[0].map(cell => cell.value), OPEN_HEAD);

  const listed = sheets.get('Accounts').slice(1).map(row => row.map(cell => cell?.value ?? ''));
  assert.deepEqual(listed.map(row => row[0]), ['BDO Unibank 0123-4567-89', 'HSBC 801-224466']);
  assert.equal(listed[0][4], 'PHP');
  assert.equal(listed[1][4], 'USD');
  assert.equal(listed[0][5], 'still needed', 'and it says which accounts still need a beginning balance');

  openBankAccount(store, actors.maker, { accountId: first.id, entryDate: '2026-09-01', balance: 1000, remarks: '' });
  const again = readWorkbook(bankImportTemplate(store, actors.maker));
  assert.equal(again.get('Accounts')[1][5].value, 'already entered');
  store.close();
});

test('a template cannot be taken before there is an account to import against', () => {
  const store = newStore();
  assert.throws(() => bankImportTemplate(store, actors.admin), /no bank accounts to import against/);
  assert.throws(() => bankImportTemplate(store, actors.viewer), /permission/);
  store.close();
});

test('a filled workbook opens the account and encodes its passbook, balances worked out', () => {
  const store = newStore();
  const id = account(store).account ?? '';
  const label = 'BDO Unibank 0123-4567-89';
  const file = upload({
    openings: [[label, '2026-09-01', 162500, 'Carried forward from August']],
    lines: [
      [label, '2026-09-02', 'DEP-00918', 'Collection deposit', 'Deposit', 0, 250000],
      [label, '2026-09-10', 'CHK-0012345', 'Check 0012345 - Metro Office Depot', 'Check Payment', 3200, 0],
      [label, '2026-09-18', 'WD-00231', 'Petty cash replenishment', 'Withdrawal', 5000, 0],
      [label, '2026-09-30', '', 'Monthly service charge', 'Bank Charge', 300, 0],
    ],
  });

  const plan = previewBankImport(store, actors.maker, file);
  assert.equal(plan.ready, true);
  assert.equal(plan.lines, 4);
  assert.equal(plan.openings, 1);
  assert.deepEqual(plan.problems, []);
  assert.equal(listBankRecords(store, actors.admin, {}).rows.length, 0, 'a preview writes nothing');

  const [summary] = plan.summary;
  assert.equal(summary.account, label);
  assert.equal(summary.opening, 162500);
  assert.equal(summary.lines, 4);
  assert.equal(summary.from, '2026-09-02');
  assert.equal(summary.to, '2026-09-30');
  assert.equal(summary.debit, 8500);
  assert.equal(summary.credit, 250000);

  const result = commitBankImport(store, actors.maker, file);
  assert.equal(result.lines, 4);
  assert.deepEqual(result.accounts, [{ account: label, currency: 'PHP', balance: 404000 }]);

  const rows = listBankRecords(store, actors.admin, {}).rows;
  assert.deepEqual(rows.map(row => [row.entryDate, row.balance]), [
    ['2026-09-30', 404000], ['2026-09-18', 404300], ['2026-09-10', 409300], ['2026-09-02', 412500], ['2026-09-01', 162500],
  ], '162,500 + 250,000 - 3,200 - 5,000 - 300');
  assert.equal(rows[0].encodedBy, 'Ana Maker');
  assert.match(store.history('bank', rows[0].id)[0].detail, /Imported from passbook\.xlsx/);
  assert.equal(store.all("SELECT * FROM audit WHERE action = 'import'").length, 1, 'and the batch itself is on file');
  assert.ok(id !== undefined);
  store.close();
});

test('one unreadable row refuses the whole file', () => {
  const store = newStore();
  account(store);
  const label = 'BDO Unibank 0123-4567-89';
  const file = upload({
    openings: [[label, '2026-09-01', 1000, '']],
    lines: [
      [label, '2026-09-02', 'A', 'Good line', 'Deposit', 0, 100],
      [label, '2026-09-03', 'B', 'Both columns filled', 'Deposit', 50, 50],
      [label, '2026-09-04', 'C', '', 'Deposit', 0, 100],
      ['Nowhere Bank', '2026-09-05', 'D', 'Unknown account', 'Deposit', 0, 100],
    ],
  });

  const plan = previewBankImport(store, actors.maker, file);
  assert.equal(plan.ready, false);
  assert.equal(plan.problemCount, 3);
  assert.deepEqual(plan.problems.map(problem => [problem.row, problem.message.slice(0, 40)]), [
    [3, 'A passbook line is either a debit or a c'],
    [4, 'Particulars is empty. Copy the descripti'],
    [5, 'No bank account matches "Nowhere Bank". '],
  ]);

  assert.throws(() => commitBankImport(store, actors.maker, file), /3 rows could not be read, so nothing was imported/);
  assert.equal(listBankRecords(store, actors.admin, {}).rows.length, 0, 'not even the good rows');
  store.close();
});

test('an account with no beginning balance, in the file or the system, is refused', () => {
  const store = newStore();
  account(store);
  const label = 'BDO Unibank 0123-4567-89';
  const plan = previewBankImport(store, actors.maker, upload({ lines: [[label, '2026-09-02', '', 'Deposit', 'Deposit', 0, 100]] }));
  assert.equal(plan.ready, false);
  assert.match(plan.problems[0].message, /has no beginning balance/);

  // And a line cannot predate the opening figure it is supposed to follow.
  const dated = previewBankImport(store, actors.maker, upload({
    openings: [[label, '2026-09-10', 1000, '']],
    lines: [[label, '2026-09-02', '', 'Too early', 'Deposit', 0, 100]],
  }));
  assert.match(dated.problems[0].message, /is before the beginning balance/);
  store.close();
});

test('an account already open cannot be opened again by the file', () => {
  const store = newStore();
  const opened = account(store);
  openBankAccount(store, actors.maker, { accountId: opened.id, entryDate: '2026-09-01', balance: 500, remarks: '' });
  const label = 'BDO Unibank 0123-4567-89';
  const plan = previewBankImport(store, actors.maker, upload({
    openings: [[label, '2026-09-01', 1000, '']],
    lines: [[label, '2026-09-02', '', 'Deposit', 'Deposit', 0, 100]],
  }));
  assert.match(plan.problems[0].message, /already has a beginning balance in the system/);

  // On its own, the transaction imports against the balance already entered.
  const fine = previewBankImport(store, actors.maker, upload({ lines: [[label, '2026-09-02', '', 'Deposit', 'Deposit', 0, 100]] }));
  assert.equal(fine.ready, true);
  assert.equal(commitBankImport(store, actors.maker, upload({ lines: [[label, '2026-09-02', '', 'Deposit', 'Deposit', 0, 100]] })).lines, 1);
  store.close();
});

test('dates arrive as Excel serials, as text, or not at all', () => {
  const store = newStore();
  account(store);
  const label = 'BDO Unibank 0123-4567-89';
  // 46266 is 2026-09-01 in Excel's own numbering.
  assert.equal(serialToDate(46266), '2026-09-01');
  const plan = previewBankImport(store, actors.maker, upload({
    openings: [[label, 46266, 1000, '']],
    lines: [
      [label, 46270, 'serial', 'From a date cell', 'Deposit', 0, 10],
      [label, '2026-09-08', 'iso', 'Typed as text', 'Deposit', 0, 10],
      [label, '30/09/2026', 'unambiguous', 'Day cannot be a month', 'Deposit', 0, 10],
      [label, '09/03/2026', 'ambiguous', 'Could be March or September', 'Deposit', 0, 10],
      [label, '', 'missing', 'No date at all', 'Deposit', 0, 10],
    ],
  }));
  assert.equal(plan.problemCount, 2);
  assert.match(plan.problems[0].message, /could not be read as a date/);
  assert.match(plan.problems[1].message, /Date is missing/);

  const good = previewBankImport(store, actors.maker, upload({
    openings: [[label, 46266, 1000, '']],
    lines: [
      [label, 46270, 'serial', 'From a date cell', 'Deposit', 0, 10],
      [label, '2026-09-08', 'iso', 'Typed as text', 'Deposit', 0, 10],
      [label, '30/09/2026', 'unambiguous', 'Day cannot be a month', 'Deposit', 0, 10],
    ],
  }));
  assert.equal(good.ready, true);
  assert.equal(good.summary[0].openingDate, '2026-09-01');
  assert.equal(good.summary[0].from, '2026-09-05');
  assert.equal(good.summary[0].to, '2026-09-30');
  store.close();
});

test('an account is found by its label, its number, or bank and name', () => {
  const store = newStore();
  account(store);
  for (const naming of ['BDO Unibank 0123-4567-89', '0123-4567-89', 'BDO Unibank - Operating Account', 'bdo unibank 0123-4567-89']) {
    const plan = previewBankImport(store, actors.maker, upload({ openings: [[naming, '2026-09-01', 1, '']] }));
    assert.equal(plan.ready, true, naming);
  }
  store.close();
});

test('a row already on file is reported, not refused', () => {
  const store = newStore();
  account(store);
  const label = 'BDO Unibank 0123-4567-89';
  const first = upload({
    openings: [[label, '2026-09-01', 1000, '']],
    lines: [[label, '2026-09-02', 'DEP-1', 'Collection deposit', 'Deposit', 0, 500]],
  });
  commitBankImport(store, actors.maker, first);

  const again = previewBankImport(store, actors.maker, upload({ lines: [[label, '2026-09-02', 'DEP-1', 'Collection deposit', 'Deposit', 0, 500]] }));
  assert.equal(again.ready, true, 'a passbook may legitimately repeat a line, so it is not refused');
  assert.equal(again.duplicates.length, 1);
  assert.equal(again.duplicates[0].reference, 'DEP-1');
  store.close();
});

test('the type may be left out and is read from the amount', () => {
  const store = newStore();
  account(store);
  const label = 'BDO Unibank 0123-4567-89';
  commitBankImport(store, actors.maker, upload({
    openings: [[label, '2026-09-01', 1000, '']],
    lines: [
      [label, '2026-09-02', '', 'No type, money in', '', 0, 500],
      [label, '2026-09-03', '', 'No type, money out', '', 200, 0],
    ],
  }));
  const rows = listBankRecords(store, actors.admin, {}).rows;
  assert.deepEqual(rows.map(row => row.type), ['Withdrawal', 'Deposit', 'Opening Balance']);

  const bad = previewBankImport(store, actors.maker, upload({ lines: [[label, '2026-09-04', '', 'Nonsense type', 'Telepathy', 0, 1]] }));
  assert.match(bad.problems[0].message, /Type "Telepathy" is not one of/);
  const opening = previewBankImport(store, actors.maker, upload({ lines: [[label, '2026-09-04', '', 'Wrong sheet', 'Opening Balance', 0, 1]] }));
  assert.match(opening.problems[0].message, /not a transaction. Put it on the "Beginning Balances" sheet/);
  store.close();
});

test('an amount must fit its account\'s currency, and cannot be negative', () => {
  const store = newStore();
  const yen = demoBankAccount(store, { bankName: 'MUFG', accountNumber: '77', accountName: 'Yen', currency: 'JPY' });
  const label = 'MUFG 77';
  const negative = previewBankImport(store, actors.maker, upload({
    openings: [[label, '2026-09-01', 1000, '']],
    lines: [[label, '2026-09-02', '', 'Negative', 'Deposit', 0, -5]],
  }));
  assert.match(negative.problems[0].message, /cannot be negative/);

  // The currency's own precision is enforced when the rows are written.
  assert.throws(() => commitBankImport(store, actors.maker, upload({
    openings: [[label, '2026-09-01', 1000, '']],
    lines: [[label, '2026-09-02', '', 'Fractional yen', 'Deposit', 0, 10.5]],
  })), /JPY has no decimal places/);
  assert.equal(listBankRecords(store, actors.admin, {}).rows.length, 0, 'and the opening did not land either');
  assert.ok(yen.id);
  store.close();
});

test('only those who keep the passbook may import, and a viewer may not', () => {
  const store = newStore();
  account(store);
  const file = upload({ openings: [['BDO Unibank 0123-4567-89', '2026-09-01', 1, '']] });
  assert.throws(() => previewBankImport(store, actors.viewer, file), /permission/);
  assert.throws(() => commitBankImport(store, actors.viewer, file), /permission/);
  for (const actor of [actors.maker, actors.approver, actors.admin]) {
    assert.equal(previewBankImport(store, actor, file).ready, true, actor.role);
  }
  store.close();
});

test('a file that is not a workbook, or is empty, is refused by name', () => {
  const store = newStore();
  account(store);
  assert.throws(() => previewBankImport(store, actors.maker, { name: 'x.xlsx', content: '' }), /No file was uploaded/);
  assert.throws(() => previewBankImport(store, actors.maker, { name: 'x.xlsx', content: Buffer.from('not a zip at all').toString('base64') }), /not an Excel workbook/);
  assert.throws(() => previewBankImport(store, actors.maker, {
    name: 'x.xlsx', content: buildWorkbook([{ name: 'Sheet1', rows: [{ cells: ['nothing useful'] }] }]).toString('base64'),
  }), /has no "Transactions" sheet/);
  assert.throws(() => previewBankImport(store, actors.maker, { name: 'x.xlsx', content: workbook().toString('base64') }), /no rows to import/);
  store.close();
});

// ---------------------------------------------------------------- real Excel output
//
// Excel deflates its parts and keeps the text in a shared string table rather than inline,
// which is the path a file from a real spreadsheet takes through the reader.
function excelLikeWorkbook(rows) {
  const strings = [];
  const intern = value => {
    const at = strings.indexOf(value);
    return at >= 0 ? at : strings.push(value) - 1;
  };
  const body = rows.map((cells, r) => `<row r="${r + 1}">${cells.map((value, c) => {
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
    return `<c r="${ref}" t="s"><v>${intern(String(value))}</v></c>`;
  }).join('')}</row>`).join('');

  const parts = [
    ['[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Transactions" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`],
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(value => `<si><t>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`],
  ];

  const locals = [], central = [];
  let offset = 0;
  for (const [name, xml] of parts) {
    const raw = Buffer.from(xml, 'utf8');
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(sum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    locals.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(sum, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('a workbook as Excel writes one - deflated, with a shared string table - reads correctly', () => {
  const store = newStore();
  const opened = account(store);
  openBankAccount(store, actors.maker, { accountId: opened.id, entryDate: '2026-09-01', balance: 1000, remarks: '' });
  const label = 'BDO Unibank 0123-4567-89';

  const content = excelLikeWorkbook([
    HEAD,
    [label, 46270, 'DEP-1', 'Deposit & change <check>', 'Deposit', 0, 250],
    [label, 46271, 'WD-1', 'Withdrawal', 'Withdrawal', 100, 0],
  ]).toString('base64');

  const plan = previewBankImport(store, actors.maker, { name: 'from-excel.xlsx', content });
  assert.equal(plan.ready, true, JSON.stringify(plan.problems));
  assert.equal(plan.lines, 2);
  const result = commitBankImport(store, actors.maker, { name: 'from-excel.xlsx', content });
  assert.equal(result.lines, 2);
  const rows = listBankRecords(store, actors.admin, {}).rows;
  assert.equal(rows[0].balance, 1150, '1,000 + 250 - 100');
  assert.equal(rows[1].description, 'Deposit & change <check>', 'and the escaping survives the round trip');
  store.close();
});
