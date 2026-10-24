import * as actual from '@actual-app/api';
import express from 'express';
import fs from 'fs';

const {
  ACTUAL_SERVER_URL = 'http://actual_server:5006',
  ACTUAL_PASSWORD,
  ACTUAL_SYNC_ID,
  PORT = 5007,
} = process.env;

if (!ACTUAL_PASSWORD) {
  console.error('ACTUAL_PASSWORD env var is required');
  process.exit(1);
}

async function discoverSyncId() {
  const base = ACTUAL_SERVER_URL.replace(/\/$/, '');
  const loginResp = await fetch(`${base}/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ACTUAL_PASSWORD }),
  });
  const loginBody = await loginResp.json();
  const token = loginBody?.data?.token;
  if (!token) throw new Error(`login failed: ${JSON.stringify(loginBody)}`);
  const filesResp = await fetch(`${base}/sync/list-user-files`, {
    headers: { 'x-actual-token': token },
  });
  const filesBody = await filesResp.json();
  const files = filesBody?.data || [];
  if (files.length === 0) {
    throw new Error(
      `No budget on ${ACTUAL_SERVER_URL}. Visit the UI, click "Create new file", then restart this service.`,
    );
  }
  return files[0].groupId;
}

const syncId = ACTUAL_SYNC_ID || await discoverSyncId();

const DATA_DIR = '/data/budget-cache';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

console.log(`Initializing Actual client (syncId=${syncId})...`);
await actual.init({ dataDir: DATA_DIR, serverURL: ACTUAL_SERVER_URL, password: ACTUAL_PASSWORD });
await actual.downloadBudget(syncId);
console.log('Budget loaded.');

const app = express();
app.use(express.json());

app.get('/accounts', async (_req, res) => {
  await actual.sync();
  res.json(await actual.getAccounts());
});

app.post('/accounts/resolve', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    await actual.sync();
    const existing = (await actual.getAccounts()).find((a) => a.name === name);
    if (existing) return res.json({ id: existing.id, created: false });
    const id = await actual.createAccount({ name, offbudget: false });
    await actual.sync();
    res.json({ id, created: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/categories', async (_req, res) => {
  res.json(await actual.getCategories());
});

app.post('/categories/ensure', async (req, res) => {
  try {
    const { group = 'Spending', names } = req.body;
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'names[] required' });
    }
    const groups = await actual.getCategoryGroups();
    let g = groups.find((x) => x.name === group && !x.is_income);
    if (!g) {
      const id = await actual.createCategoryGroup({ name: group, is_income: false });
      g = { id, name: group };
    }
    const existing = await actual.getCategories();
    const byName = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
    const out = {};
    for (const name of names) {
      const match = byName.get(name.toLowerCase());
      out[name] = match ? match.id : await actual.createCategory({ name, group_id: g.id });
    }
    await actual.sync();
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/transactions', async (req, res) => {
  try {
    const { account_id, transactions } = req.body;
    if (!account_id || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'need account_id and transactions[]' });
    }
    const result = await actual.importTransactions(account_id, transactions);
    await actual.sync();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/transactions', async (req, res) => {
  const { account_id, start = '1970-01-01', end = '2099-12-31' } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id required' });
  await actual.sync();
  res.json(await actual.getTransactions(account_id, start, end));
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

const shutdown = async () => {
  await actual.shutdown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
