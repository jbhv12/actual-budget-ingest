import * as actual from '@actual-app/api';

export const BUDGET_CATEGORIES = ['Food', 'General', 'Bills', 'Bills (Flexible)', 'Savings'];

let cache = null;

export async function ensureCategories() {
  if (cache) return cache;
  const existing = await actual.getCategories();
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  const resolved = {};
  for (const name of BUDGET_CATEGORIES) {
    const id = byName.get(name.toLowerCase());
    if (id) resolved[name] = id;
  }
  cache = resolved;
  return resolved;
}
