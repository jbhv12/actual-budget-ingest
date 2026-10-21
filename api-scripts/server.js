import * as actual from '@actual-app/api';
import express from 'express';
import fs from 'fs';

const {
  ACTUAL_SERVER_URL = 'http://actual_server:5006',
  ACTUAL_PASSWORD,
  ACTUAL_SYNC_ID,
  PORT = 5007,
} = process.env;

for (const [k, v] of Object.entries({ ACTUAL_PASSWORD, ACTUAL_SYNC_ID })) {
  if (!v) {
    console.error(`${k} env var is required`);
    process.exit(1);
  }
}

const DATA_DIR = '/data/budget-cache';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

console.log('Initializing Actual client...');
await actual.init({
  dataDir: DATA_DIR,
  serverURL: ACTUAL_SERVER_URL,
  password: ACTUAL_PASSWORD,
});
await actual.downloadBudget(ACTUAL_SYNC_ID);
console.log('Budget loaded.');

const app = express();
app.use(express.json());

app.get('/accounts', async (_req, res) => {
  await actual.sync();
  const accounts = await actual.getAccounts();
  res.json(accounts);
});

app.get('/categories', async (_req, res) => {
  const categories = await actual.getCategories();
  res.json(categories);
});

app.post('/transactions', async (req, res) => {
  try {
    const { account_id, transactions } = req.body;
    if (!account_id || !Array.isArray(transactions)) {
      return res.status(400).json({ error: 'need account_id and transactions[]' });
    }
    const ids = await actual.addTransactions(account_id, transactions);
    await actual.sync();
    res.json({ ok: true, ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/transactions', async (req, res) => {
  const { account_id, start = '1970-01-01', end = '2099-12-31' } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id required' });
  await actual.sync();
  const txns = await actual.getTransactions(account_id, start, end);
  res.json(txns);
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

const shutdown = async () => {
  console.log('Shutting down...');
  await actual.shutdown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
