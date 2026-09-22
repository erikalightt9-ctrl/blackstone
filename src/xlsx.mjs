import { crc32, inflateRawSync } from 'node:zlib';
import { AppError } from './errors.mjs';

// A small XLSX reader and writer, written here for the same reason as the PDF writer: the
// system takes no dependencies, and a spreadsheet is a zip of XML documents.
//
// Reading is the risky half, because the file comes from whoever is importing. Everything is
// bounded - the number of entries, the size of each one, the size of the whole - and only the
// few entries the workbook actually names are ever decompressed. The XML is scanned for the
// handful of elements SpreadsheetML uses for cells rather than parsed as general XML, so there
// is no entity expansion and nothing external is ever fetched.

const MAX_ENTRIES = 64;
const MAX_ENTRY_BYTES = 8_000_000;
const MAX_TOTAL_BYTES = 16_000_000;

// ---------------------------------------------------------------- zip

const dosTime = () => 0; // A fixed timestamp keeps a generated template byte-for-byte stable.

function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt16LE(dosTime(), 10); header.writeUInt16LE(dosTime(), 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8); entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(dosTime(), 12); entry.writeUInt16LE(dosTime(), 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function unzip(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new AppError('That is not an Excel workbook. Save the file as .xlsx and try again.');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new AppError('That workbook looks damaged - its index could not be read. Open it in Excel, save it again, and retry.');
  const count = buffer.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new AppError('That workbook contains too many parts to be a records template.');

  const entries = new Map();
  let cursor = buffer.readUInt32LE(end + 16), total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new AppError('That workbook looks damaged and could not be read.');
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (size > MAX_ENTRY_BYTES) throw new AppError('That workbook is too large to import. Split it into smaller files.', 413);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new AppError('That workbook is too large to import. Split it into smaller files.', 413);
    entries.set(name, { method, offset, size });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  // Only the parts the workbook names are ever decompressed.
  return name => {
    const entry = entries.get(name);
    if (!entry) return null;
    const start = entry.offset;
    if (start + 30 > buffer.length || buffer.readUInt32LE(start) !== 0x04034b50) throw new AppError('That workbook looks damaged and could not be read.');
    const from = start + 30 + buffer.readUInt16LE(start + 26) + buffer.readUInt16LE(start + 28);
    const compressed = buffer.readUInt32LE(start + 18) || entry.size;
    const slice = buffer.subarray(from, from + compressed);
    if (entry.method === 0) return slice.toString('utf8');
    if (entry.method !== 8) throw new AppError('That workbook uses a compression method this system cannot read. Save it again from Excel as .xlsx.');
    try {
      return inflateRawSync(slice, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    } catch (error) {
      // A truncated or tampered entry, or one that expands past the cap. Either way it is the
      // file that is wrong, not the system, so it is reported as such rather than as a fault.
      throw new AppError(/maxOutputLength|buffer/i.test(error.message)
        ? 'That workbook expands to more than this system will read in one file. Split the passbook into smaller files.'
        : 'That workbook is damaged and could not be unpacked. Open it in Excel, save it again, and retry.', 413);
    }
  };
}

// ---------------------------------------------------------------- xml

const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const unescapeXml = value => value
  .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d{1,7});/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

export function columnName(index) {
  let name = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
}

const columnIndex = reference => {
  let index = 0;
  for (const character of reference.replace(/\d+$/, '')) index = index * 26 + (character.toUpperCase().charCodeAt(0) - 64);
  return index - 1;
};

// ---------------------------------------------------------------- dates

// Excel keeps a date as a day count. 1899-12-30 is the base that makes the sheet's own
// numbering line up, including its inherited belief that 1900 was a leap year.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const EXCEL_EPOCH_1904 = Date.UTC(1904, 0, 1);

export function serialToDate(serial, use1904 = false) {
  if (!Number.isFinite(serial)) return '';
  const days = Math.floor(serial);
  if (days < 1 || days > 400_000) return '';
  const date = new Date((use1904 ? EXCEL_EPOCH_1904 : EXCEL_EPOCH) + days * 86_400_000);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- writing

const STYLE = { plain: 0, header: 1, date: 2, money: 3, note: 4, title: 5 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FFB00020"/><name val="Calibri"/></font>
</fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFB00020"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs></styleSheet>`;

const cell = (reference, value, style) => {
  if (value === null || value === undefined || value === '') return style ? `<c r="${reference}" s="${style}"/>` : '';
  const attributes = `r="${reference}"${style ? ` s="${style}"` : ''}`;
  if (typeof value === 'number') return `<c ${attributes}><v>${value}</v></c>`;
  return `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
};

function sheetXml({ rows = [], columns = [], freeze = 0, validation = null }) {
  const cols = columns.length
    ? `<cols>${columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width || 16}" customWidth="1"${column.style ? ` style="${column.style}"` : ''}/>`).join('')}</cols>`
    : '';
  const body = rows.map((row, rowIndex) => {
    const cells = (row.cells || []).map((value, columnIndex_) => {
      const style = Array.isArray(row.styles) ? row.styles[columnIndex_] : row.style;
      return cell(`${columnName(columnIndex_)}${rowIndex + 1}`, value, style);
    }).join('');
    return cells ? `<row r="${rowIndex + 1}"${row.height ? ` ht="${row.height}" customHeight="1"` : ''}>${cells}</row>` : '';
  }).join('');
  const panes = freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
  // A dropdown is either a short inline list or a reference to a range on another sheet.
  // Inline lists are capped by Excel at around 255 characters, so anything open-ended - the
  // list of bank accounts, for one - points at a range instead.
  const validations = validation
    ? `<dataValidations count="${validation.length ?? 1}">${[].concat(validation).map(rule =>
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${rule.range}"><formula1>${
        rule.formula ? escapeXml(rule.formula) : `"${rule.values.join(',')}"`}</formula1></dataValidation>`).join('')}</dataValidations>`
    : '';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${panes}${cols}<sheetData>${body}</sheetData>${validations}</worksheet>`, 'utf8');
}

export function buildWorkbook(sheets) {
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) })),
  ];
  return zip(files);
}

export { STYLE };

// ---------------------------------------------------------------- reading

// Attribute names are fixed, so the patterns are built once rather than per cell.
const ATTRIBUTE = new Map();
const attribute = (tag, name) => {
  if (!ATTRIBUTE.has(name)) ATTRIBUTE.set(name, new RegExp(`\\s${name}="([^"]*)"`));
  const match = tag.match(ATTRIBUTE.get(name));
  return match ? match[1] : '';
};

// Walks the elements of one tag name, linearly.
//
// This is deliberately not a regular expression. A lazy `[\s\S]*?` between an opening and a
// closing tag is quadratic on input that never closes: the engine rescans to the end of the
// document once per opening tag, so a few hundred kilobytes of "<row" with no "</row>" takes
// seconds and a few megabytes takes minutes. Since the file comes from whoever is importing,
// and this server answers every request on one thread, that is a denial of service that
// compresses down to a very small upload. indexOf only ever moves forward, so the work is
// proportional to the size of the document and nothing else.
//
// SpreadsheetML never nests these elements inside themselves, which is what makes a scan for
// the next closing tag correct as well as fast.
function* elements(xml, tag, limit = 200_000) {
  const open = `<${tag}`, close = `</${tag}>`;
  let at = 0, seen = 0;
  while (at < xml.length && seen < limit) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    const after = start + open.length;
    // "<c" must not match "<col"; only a space, a slash or the end of the tag may follow.
    const next = xml[after];
    if (next !== ' ' && next !== '>' && next !== '/' && next !== '\t' && next !== '\n' && next !== '\r') { at = after; continue; }
    const gt = xml.indexOf('>', after);
    if (gt < 0) return;
    seen++;
    if (xml[gt - 1] === '/') { yield { attributes: xml.slice(after, gt - 1), inner: '' }; at = gt + 1; continue; }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return; // An unclosed element ends the scan rather than restarting it.
    yield { attributes: xml.slice(after, gt), inner: xml.slice(gt + 1, end) };
    at = end + close.length;
  }
}

// The text of an element's <t> runs, concatenated.
const textOf = xml => {
  let text = '';
  for (const run of elements(xml, 't', 4096)) text += unescapeXml(run.inner);
  return text;
};

function sharedStrings(read) {
  const xml = read('xl/sharedStrings.xml');
  if (!xml) return [];
  // Each <si> is one string, possibly split across runs; the runs are concatenated.
  return [...elements(xml, 'si')].map(entry => textOf(entry.inner));
}

const MAX_ROWS_PER_SHEET = 100_000;
const MAX_COLUMNS = 256;

// Returns the sheet as an array of rows, each row an array of { value, type } by column.
function readSheet(xml, strings, use1904) {
  const rows = [];
  for (const row of elements(xml, 'row', MAX_ROWS_PER_SHEET)) {
    const number = Number(attribute(row.attributes, 'r')) || rows.length + 1;
    if (number < 1 || number > MAX_ROWS_PER_SHEET) continue;
    const cells = [];
    for (const cell of elements(row.inner, 'c', MAX_COLUMNS)) {
      const reference = attribute(cell.attributes, 'r');
      const index = reference ? columnIndex(reference) : cells.length;
      const type = attribute(cell.attributes, 't');
      const style = attribute(cell.attributes, 's');
      let value = '';
      if (type === 'inlineStr') {
        value = textOf(cell.inner);
      } else {
        const [first] = elements(cell.inner, 'v', 1);
        const text = first ? unescapeXml(first.inner) : '';
        value = type === 's' ? strings[Number(text)] ?? '' : text;
      }
      if (index >= 0 && index < MAX_COLUMNS) cells[index] = { value, type, style, use1904 };
    }
    rows[number - 1] = cells;
  }
  return rows;
}

// Opens a workbook and returns its sheets by name, each as rows of cells.
export function readWorkbook(buffer) {
  const read = unzip(buffer);
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new AppError('That file is not an Excel workbook. Download the template and fill that in.');
  const use1904 = /date1904="(1|true)"/.test(workbook);
  const relationships = new Map([...(read('xl/_rels/workbook.xml.rels') || '')
    .matchAll(/<Relationship([^>]*)\/>/g)].map(([, attributes]) => [attribute(attributes, 'Id'), attribute(attributes, 'Target')]));
  const strings = sharedStrings(read);

  const sheets = new Map();
  for (const [, attributes] of workbook.matchAll(/<sheet([^>]*)\/>/g)) {
    const name = unescapeXml(attribute(attributes, 'name'));
    const target = relationships.get(attribute(attributes, 'r:id')) || '';
    if (!target) continue;
    const path = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = read(`xl/${path}`);
    if (xml) sheets.set(name, readSheet(xml, strings, use1904));
  }
  if (!sheets.size) throw new AppError('That workbook has no readable sheets.');
  return sheets;
}

// ---------------------------------------------------------------- cell values

// A cell holding a date can arrive as Excel's day count or as text somebody typed. Both are
// accepted; anything else is left for the caller to reject by name.
export function cellDate(cell_) {
  if (!cell_ || cell_.value === '') return '';
  const text = String(cell_.value).trim();
  if (/^\d+(\.\d+)?$/.test(text) && !cell_.type) return serialToDate(Number(text), cell_.use1904);
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  // Day-first and month-first are ambiguous, so only an unambiguous day is accepted.
  const slashed = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (slashed) {
    const [, a, b, year] = slashed;
    if (Number(a) > 12 && Number(b) <= 12) return `${year}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (Number(b) > 12 && Number(a) <= 12) return `${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
    return '';
  }
  return '';
}

export function cellText(cell_) {
  return cell_ && cell_.value !== undefined ? String(cell_.value).trim() : '';
}

export function cellNumber(cell_) {
  const text = cellText(cell_).replace(/[,\s ]/g, '').replace(/^[^\d.\-(]+/, '').replace(/[()]/g, '');
  if (!text) return 0;
  const value = Number(text);
  return Number.isFinite(value) ? value : NaN;
}
