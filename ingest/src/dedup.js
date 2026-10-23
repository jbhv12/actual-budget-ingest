import { createHash } from 'node:crypto';

export function importedId({ bank, account_last4, date, amount_paise, reference, balance_paise, description }) {
  let fingerprint;
  let tier;
  if (reference && reference.trim()) {
    fingerprint = reference.trim().toLowerCase();
    tier = 'reference';
  } else if (balance_paise != null) {
    fingerprint = `bal:${balance_paise}`;
    tier = 'balance';
  } else {
    fingerprint = (description || '').slice(0, 40).toLowerCase().replace(/\s+/g, ' ').trim();
    tier = 'description';
  }
  const id = createHash('sha256')
    .update(`${bank}|${account_last4}|${date}|${amount_paise}|${fingerprint}`)
    .digest('hex')
    .slice(0, 24);
  return { id, tier };
}

export function reconcile({ opening_balance_paise, closing_balance_paise, transactions }) {
  const sum = transactions.reduce((acc, t) => acc + t.amount_paise, 0);
  const expected = closing_balance_paise;
  const actual = opening_balance_paise + sum;
  return { ok: actual === expected, expected, actual, diff: actual - expected };
}
