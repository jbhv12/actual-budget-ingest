import * as actual from '@actual-app/api';
import fs from 'node:fs';

let initialized = false;

async function discoverSyncId({ serverURL, password }) {
  const loginResp = await fetch(`${serverURL.replace(/\/$/, '')}/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const loginBody = await loginResp.json();
  const token = loginBody?.data?.token;
  if (!token) throw new Error(`login to ${serverURL} failed: ${JSON.stringify(loginBody)}`);
  const filesResp = await fetch(`${serverURL.replace(/\/$/, '')}/sync/list-user-files`, {
    headers: { 'x-actual-token': token },
  });
  const filesBody = await filesResp.json();
  const files = filesBody?.data || [];
  if (files.length === 0) {
    throw new Error(
      `no budget on ${serverURL}. Visit the UI and click "Create new file", then re-run.`,
    );
  }
  return files[0].groupId;
}

export async function initDirect({ env = process.env } = {}) {
  if (initialized) return;
  const serverURL = env.ACTUAL_SERVER_URL;
  const password = env.ACTUAL_PASSWORD;
  const dataDir = env.ACTUAL_DATA_DIR || '/data/budget-cache';
  if (!serverURL || !password) {
    throw new Error('ACTUAL_SERVER_URL and ACTUAL_PASSWORD are required for direct mode');
  }
  const syncId = env.ACTUAL_SYNC_ID || (await discoverSyncId({ serverURL, password }));
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  await actual.init({ dataDir, serverURL, password });
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
