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

async function ensureBootstrapped() {
  const base = ACTUAL_SERVER_URL.replace(/\/$/, '');
  const resp = await fetch(`${base}/account/needs-bootstrap`);
  const body = await resp.json();
  if (body?.data?.bootstrapped === false) {
    console.log('server not bootstrapped; posting /account/bootstrap');
    const bootResp = await fetch(`${base}/account/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ACTUAL_PASSWORD }),
    });
    const bootBody = await bootResp.json();
    if (bootBody?.status !== 'ok') throw new Error(`bootstrap failed: ${JSON.stringify(bootBody)}`);
  }
}

async function serverLogin() {
  await ensureBootstrapped();
  const base = ACTUAL_SERVER_URL.replace(/\/$/, '');
  for (let attempt = 0; attempt < 12; attempt++) {
    const resp = await fetch(`${base}/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ACTUAL_PASSWORD }),
    });
    const body = await resp.json().catch(() => ({}));
    if (body?.data?.token) return body.data.token;
    if (resp.status === 429 || body?.reason === 'too-many-requests') {
      const wait = Math.min(60, 5 * (attempt + 1));
      console.log(`login rate-limited; retry in ${wait}s (attempt ${attempt + 1}/12)`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`login failed: ${JSON.stringify(body)}`);
  }
  throw new Error('login still rate-limited after 12 attempts');
}

async function listRemoteBudgets() {
  const base = ACTUAL_SERVER_URL.replace(/\/$/, '');
  const token = await serverLogin();
  const filesResp = await fetch(`${base}/sync/list-user-files`, {
    headers: { 'x-actual-token': token },
  });
  return (await filesResp.json())?.data || [];
}

const DATA_DIR = '/data/budget-cache';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

console.log('Initializing Actual client...');
await ensureBootstrapped();
async function initWithRetry() {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await actual.init({ dataDir: DATA_DIR, serverURL: ACTUAL_SERVER_URL, password: ACTUAL_PASSWORD });
      return;
    } catch (err) {
      if (err?.code === 'too-many-requests') {
        const wait = Math.min(60, 5 * (attempt + 1));
        console.log(`login rate-limited; retry in ${wait}s (attempt ${attempt + 1}/12)`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('login still rate-limited after 12 attempts');
}
await initWithRetry();

let syncId = ACTUAL_SYNC_ID;
if (!syncId) {
  const budgets = await listRemoteBudgets();
  if (budgets.length === 0) {
    console.log('No budget on server. Creating "Finances"...');
    await actual.runImport('Finances', async () => {});
    const after = await listRemoteBudgets();
    if (after.length === 0) throw new Error('runImport did not create a remote budget');
    syncId = after[0].groupId;
  } else {
    syncId = budgets[0].groupId;
  }
}

console.log(`Loading budget (syncId=${syncId})...`);
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

const PENDING_PAYEE_NAME = 'Self Transfer (unmatched)';

async function getPendingPayeeId() {
  const payees = await actual.getPayees();
  const existing = payees.find((p) => p.name === PENDING_PAYEE_NAME);
  if (existing) return existing.id;
  return actual.createPayee({ name: PENDING_PAYEE_NAME });
}

function transferPayeeForAccount(payees, accountId) {
  return payees.find((p) => p.transfer_acct === accountId)?.id || null;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

async function findMirror({ otherAccountId, date, amount, pendingPayeeId, windowDays = 2 }) {
  const d = new Date(date + 'T00:00:00Z');
  const from = new Date(d);
  from.setUTCDate(d.getUTCDate() - windowDays);
  const to = new Date(d);
  to.setUTCDate(d.getUTCDate() + windowDays);
  const candidates = await actual.getTransactions(otherAccountId, iso(from), iso(to));
  return candidates.find((t) => t.amount === -amount && t.payee === pendingPayeeId) || null;
}

app.post('/transfers/push', async (req, res) => {
  try {
    const { account_id, transactions } = req.body;
    if (!account_id || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'need account_id and transactions[]' });
    }
    await actual.sync();
    const pendingPayeeId = await getPendingPayeeId();
    const payees = await actual.getPayees();
    const accounts = await actual.getAccounts();
    const otherAccountIds = accounts.map((a) => a.id).filter((id) => id !== account_id);

    const results = [];
    for (const t of transactions) {
      let mirror = null;
      let mirrorAccountId = null;
      for (const otherId of otherAccountIds) {
        mirror = await findMirror({
          otherAccountId: otherId,
          date: t.date,
          amount: t.amount,
          pendingPayeeId,
        });
        if (mirror) { mirrorAccountId = otherId; break; }
      }

      if (mirror) {
        const otherTransferPayeeId = transferPayeeForAccount(payees, mirrorAccountId);
        await actual.deleteTransaction(mirror.id);
        await actual.importTransactions(account_id, [{
          date: t.date,
          amount: t.amount,
          payee: otherTransferPayeeId,
          notes: t.notes,
          imported_id: t.imported_id,
          cleared: true,
        }]);
        results.push({ imported_id: t.imported_id, linked: true, with_account: mirrorAccountId });
      } else {
        await actual.importTransactions(account_id, [{
          date: t.date,
          amount: t.amount,
          payee: pendingPayeeId,
          notes: t.notes,
          imported_id: t.imported_id,
          cleared: true,
        }]);
        results.push({ imported_id: t.imported_id, linked: false });
      }
    }
    await actual.sync();
    res.json({ ok: true, results });
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
