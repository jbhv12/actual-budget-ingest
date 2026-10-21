import { createHash } from 'node:crypto';

export function importedId({ bank, account_last4, date, amount_paise, reference, description }) {
  const refOrDesc = (reference && reference.trim()) || (description || '').slice(0, 40);
  const normalized = refOrDesc.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update(`${bank}|${account_last4}|${date}|${amount_paise}|${normalized}`)
    .digest('hex')
    .slice(0, 24);
}

export function reconcile({ opening_balance_paise, closing_balance_paise, transactions }) {
  const sum = transactions.reduce((acc, t) => acc + t.amount_paise, 0);
  const expected = closing_balance_paise;
  const actual = opening_balance_paise + sum;
  return { ok: actual === expected, expected, actual, diff: actual - expected };
}
