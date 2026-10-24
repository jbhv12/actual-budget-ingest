import * as actual from '@actual-app/api';
import fs from 'node:fs';

let initialized = false;

async function ensureBootstrapped({ serverURL, password }) {
  const base = serverURL.replace(/\/$/, '');
  const resp = await fetch(`${base}/account/needs-bootstrap`);
  const body = await resp.json();
  if (body?.data?.bootstrapped === false) {
    const bootResp = await fetch(`${base}/account/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const bootBody = await bootResp.json();
    if (bootBody?.status !== 'ok') throw new Error(`bootstrap failed: ${JSON.stringify(bootBody)}`);
  }
}

async function listRemoteBudgets({ serverURL, password }) {
  const base = serverURL.replace(/\/$/, '');
  const loginResp = await fetch(`${base}/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const loginBody = await loginResp.json();
  const token = loginBody?.data?.token;
  if (!token) throw new Error(`login to ${serverURL} failed: ${JSON.stringify(loginBody)}`);
  const filesResp = await fetch(`${base}/sync/list-user-files`, {
    headers: { 'x-actual-token': token },
  });
  return (await filesResp.json())?.data || [];
}

export async function initDirect({ env = process.env } = {}) {
  if (initialized) return;
  const serverURL = env.ACTUAL_SERVER_URL;
  const password = env.ACTUAL_PASSWORD;
  const dataDir = env.ACTUAL_DATA_DIR || '/data/budget-cache';
  if (!serverURL || !password) {
    throw new Error('ACTUAL_SERVER_URL and ACTUAL_PASSWORD are required for direct mode');
  }
  await ensureBootstrapped({ serverURL, password });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  await actual.init({ dataDir, serverURL, password });
  let syncId = env.ACTUAL_SYNC_ID;
  if (!syncId) {
    const budgets = await listRemoteBudgets({ serverURL, password });
    if (budgets.length === 0) {
      await actual.runImport('Finances', async () => {});
      const after = await listRemoteBudgets({ serverURL, password });
      if (after.length === 0) throw new Error('runImport did not create a remote budget');
      syncId = after[0].groupId;
    } else {
      syncId = budgets[0].groupId;
    }
  }
  await actual.downloadBudget(syncId);
  initialized = true;
}

export async function pushDirect({ accountId, transactions, env = process.env }) {
  await initDirect({ env });
  const result = await actual.importTransactions(accountId, transactions);
  await actual.sync();
  return result;
}

export async function shutdownDirect() {
  if (!initialized) return;
  await actual.shutdown();
  initialized = false;
}

export async function resolveOrCreateAccount({ name, env = process.env }) {
  await initDirect({ env });
  const accounts = await actual.getAccounts();
  const existing = accounts.find((a) => a.name === name);
  if (existing) return existing.id;
  const id = await actual.createAccount({ name, offbudget: false });
  await actual.sync();
  return id;
}

export async function listAccountsDirect({ env = process.env } = {}) {
  await initDirect({ env });
  return actual.getAccounts();
}

const PENDING_PAYEE_NAME = 'Self Transfer (unmatched)';

async function getPendingPayeeIdDirect() {
  const payees = await actual.getPayees();
  const existing = payees.find((p) => p.name === PENDING_PAYEE_NAME);
  if (existing) return existing.id;
  return actual.createPayee({ name: PENDING_PAYEE_NAME });
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

async function findMirrorDirect({ otherAccountId, date, amount, pendingPayeeId, windowDays = 2 }) {
  const d = new Date(date + 'T00:00:00Z');
  const from = new Date(d); from.setUTCDate(d.getUTCDate() - windowDays);
  const to = new Date(d); to.setUTCDate(d.getUTCDate() + windowDays);
  const candidates = await actual.getTransactions(otherAccountId, iso(from), iso(to));
  return candidates.find((t) => t.amount === -amount && t.payee === pendingPayeeId) || null;
}

export async function pushSelfTransfersDirect({ accountId, transactions, env = process.env }) {
  await initDirect({ env });
  await actual.sync();
  const pendingPayeeId = await getPendingPayeeIdDirect();
  const payees = await actual.getPayees();
  const accounts = await actual.getAccounts();
  const otherAccountIds = accounts.map((a) => a.id).filter((id) => id !== accountId);

  const results = [];
  for (const t of transactions) {
    let mirror = null;
    let mirrorAccountId = null;
    for (const otherId of otherAccountIds) {
      mirror = await findMirrorDirect({ otherAccountId: otherId, date: t.date, amount: t.amount, pendingPayeeId });
      if (mirror) { mirrorAccountId = otherId; break; }
    }

    if (mirror) {
      const otherTransferPayeeId = payees.find((p) => p.transfer_acct === mirrorAccountId)?.id;
      await actual.deleteTransaction(mirror.id);
      await actual.importTransactions(accountId, [{
        date: t.date,
        amount: t.amount,
        payee: otherTransferPayeeId,
        notes: t.notes,
        imported_id: t.imported_id,
        cleared: true,
      }]);
      results.push({ imported_id: t.imported_id, linked: true, with_account: mirrorAccountId });
    } else {
      await actual.importTransactions(accountId, [{
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
  return results;
}
