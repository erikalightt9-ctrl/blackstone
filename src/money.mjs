// All money is held as integer centavos. Pesos exist only at the API, PDF and UI edges,
// so no running balance is ever the product of repeated floating point addition.
export const CENTAVOS = 100;
export const MAX_CENTAVOS = 1e13; // PHP 100 billion: far above any real request, below Number.MAX_SAFE_INTEGER.

export function toCentavos(peso) {
  if (typeof peso !== 'number' || !Number.isFinite(peso)) throw new RangeError('Amount must be a finite number.');
  const cents = Math.round(peso * CENTAVOS);
  if (Math.abs(peso * CENTAVOS - cents) > 0.000001) throw new RangeError('Use at most two decimal places.');
  if (Math.abs(cents) > MAX_CENTAVOS) throw new RangeError('Amount is out of range.');
  return cents;
}
export const toPeso = cents => Math.round(Number(cents || 0)) / CENTAVOS;

// Quantity carries up to three decimals (hours, kilos, partial units); the line amount is
// rounded once, to the centavo, so line totals and the request total always reconcile.
export function lineAmountCentavos(quantity, unitCentavos) {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) throw new RangeError('Quantity must be greater than zero.');
  const amount = Math.round(quantity * unitCentavos);
  if (Math.abs(amount) > MAX_CENTAVOS) throw new RangeError('Line amount is out of range.');
  return amount;
}
export const sumCentavos = values => values.reduce((total, value) => total + Math.round(Number(value || 0)), 0);
export const formatPeso = (cents, symbol = '₱') => `${symbol}${toPeso(cents).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------- currencies
//
// The helpers above are the two-decimal peso path the requests and the petty cash fund are
// kept in. A bank account carries its own currency, and how many minor units that currency
// has is data on the currency row - two for the peso and the dollar, none for the yen - so
// these take the precision rather than assuming it.

export const minorUnits = decimals => 10 ** Math.max(0, Math.min(6, Math.trunc(decimals ?? 2)));

export function toMinor(amount, decimals = 2) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new RangeError('Amount must be a finite number.');
  const factor = minorUnits(decimals);
  const minor = Math.round(amount * factor);
  if (Math.abs(amount * factor - minor) > 0.000001) {
    throw new RangeError(decimals > 0 ? `Use at most ${decimals} decimal place${decimals === 1 ? '' : 's'}.` : 'This currency has no decimal places, so enter a whole amount.');
  }
  if (Math.abs(minor) > MAX_CENTAVOS) throw new RangeError('Amount is out of range.');
  return minor;
}

export const fromMinor = (minor, decimals = 2) => Math.round(Number(minor || 0)) / minorUnits(decimals);

export const formatMoney = (minor, symbol = '', decimals = 2) =>
  `${symbol}${fromMinor(minor, decimals).toLocaleString('en-PH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
