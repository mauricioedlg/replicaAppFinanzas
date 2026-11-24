export const maxMoney = 999999999999999999n;

export function parseDecimal(value, scale, maxDigits) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (text.length > 1000) return null;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;

  const [, sign, whole, fraction = '', exponent = '0'] = match;
  if (!whole && !fraction) return null;
  const digits = (whole + fraction).replace(/^0+(?=\d)/, '');
  const places = fraction.length - Number(exponent);
  const wholeDigits = Math.max(0, digits.length - places);
  if (!Number.isSafeInteger(places) || places > scale || wholeDigits > maxDigits - scale) return null;

  const units = BigInt(digits) * (10n ** BigInt(scale - places));
  return sign === '-' ? -units : units;
}

export function readDecimal(value, scale) {
  const units = parseDecimal(value, scale, 38);
  if (units === null) throw new TypeError('La base de datos devolvió un decimal inválido.');
  return units;
}

export function formatDecimal(units, scale) {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  if (scale === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function roundDivision(numerator, denominator) {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}
