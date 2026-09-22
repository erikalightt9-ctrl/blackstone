// Reference numbers. Payment Requests, Petty Cash Requests and replenishments each keep an
// independent sequence, and the format is configuration rather than code.
//
//   PR-{YYYY}-{SEQ:6}  ->  PR-2026-000001
//
// Supported tokens: {YYYY} {YY} {MM} {SEQ:n}. A series is scoped to everything in the format
// that precedes and follows the sequence once the date tokens are resolved, so changing
// "PR-" to "PV-", or rolling into a new year, starts a fresh series without touching history.
const SEQ = /\{SEQ:(\d)\}/;

export class NumberingError extends Error { constructor(message) { super(message); this.status = 400; } }

export function validateFormat(format) {
  if (typeof format !== 'string' || !format.trim()) throw new NumberingError('A numbering format is required.');
  if (format.length > 60) throw new NumberingError('Numbering format is too long.');
  const matches = format.match(/\{SEQ:\d\}/g);
  if (!matches || matches.length !== 1) throw new NumberingError('A numbering format needs exactly one {SEQ:n} placeholder, for example PR-{YYYY}-{SEQ:6}.');
  const leftovers = format.replace(/\{(YYYY|YY|MM|SEQ:\d)\}/g, '');
  if (/[{}]/.test(leftovers)) throw new NumberingError('Unknown placeholder. Use {YYYY}, {YY}, {MM} and {SEQ:n} only.');
  return format;
}

export function resolveDateTokens(format, date) {
  const [year, month] = String(date).split('-');
  if (!/^\d{4}$/.test(year || '') || !/^\d{2}$/.test(month || '')) throw new NumberingError('A valid request date is required to build a reference number.');
  return { resolved: format.replaceAll('{YYYY}', year).replaceAll('{YY}', year.slice(2)).replaceAll('{MM}', month), year: Number(year) };
}

export const formatNumber = (format, date, sequence) => {
  const { resolved } = resolveDateTokens(validateFormat(format), date);
  const width = Number(resolved.match(SEQ)[1]);
  return resolved.replace(SEQ, String(sequence).padStart(width, '0'));
};

// Allocates the next number in the series. Call inside a transaction: the caller's row and its
// sequence advance together, so a rolled-back request never burns a reference number.
export function nextNumber(store, format, date) {
  const { resolved, year } = resolveDateTokens(validateFormat(format), date);
  const series = resolved.replace(SEQ, '{SEQ}');
  const row = store.get('INSERT INTO sequences(prefix, year, next) VALUES(?, ?, 2) ON CONFLICT(prefix, year) DO UPDATE SET next = next + 1 RETURNING next', series, year);
  const sequence = row.next - 1;
  const width = Number(resolved.match(SEQ)[1]);
  if (String(sequence).length > width) throw new NumberingError(`The ${series} series is full. Widen the {SEQ:${width}} placeholder in the numbering format.`);
  return { number: resolved.replace(SEQ, String(sequence).padStart(width, '0')), sequence, series, year };
}

export const peekSequence = (store, format, date) => {
  const { resolved, year } = resolveDateTokens(validateFormat(format), date);
  return store.get('SELECT next FROM sequences WHERE prefix = ? AND year = ?', resolved.replace(SEQ, '{SEQ}'), year)?.next ?? 1;
};
