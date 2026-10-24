import * as actual from '@actual-app/api';

export const BUDGET_CATEGORIES = [
  'Essentials',
  'Leisure & Trips',
  'Wealth & Savings',
  'True Expenses',
];
export const CATEGORY_GROUP = 'Spending';

let cache = null;

export async function ensureCategories() {
  if (cache) return cache;

  const groups = await actual.getCategoryGroups();
  let group = groups.find((g) => g.name === CATEGORY_GROUP && !g.is_income);
  if (!group) {
    const id = await actual.createCategoryGroup({ name: CATEGORY_GROUP, is_income: false });
    group = { id, name: CATEGORY_GROUP };
  }

  const existing = await actual.getCategories();
  const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));

  const resolved = {};
  for (const name of BUDGET_CATEGORIES) {
    const found = byName.get(name.toLowerCase());
    if (found) {
      resolved[name] = found.id;
    } else {
      resolved[name] = await actual.createCategory({ name, group_id: group.id });
    }
  }
  cache = resolved;
  return resolved;
}

export function resolveCategoryId(categoryMap, llmLabel) {
  if (!llmLabel) return null;
  const normalized = llmLabel.trim().toLowerCase();
  for (const [name, id] of Object.entries(categoryMap)) {
    if (name.toLowerCase() === normalized) return id;
  }
  return null;
}
