import * as actual from '@actual-app/api';
import fs from 'node:fs';

let initialized = false;

export async function initDirect({ env = process.env } = {}) {
  if (initialized) return;
  const serverURL = env.ACTUAL_SERVER_URL;
  const password = env.ACTUAL_PASSWORD;
  const syncId = env.ACTUAL_SYNC_ID;
  const dataDir = env.ACTUAL_DATA_DIR || '/data/budget-cache';
  if (!serverURL || !password || !syncId) {
    throw new Error('ACTUAL_SERVER_URL, ACTUAL_PASSWORD and ACTUAL_SYNC_ID are required for direct mode');
  }
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  await actual.init({ dataDir, serverURL, password });
  await actual.downloadBudget(syncId);
  initialized = true;
}

export async function pushDirect({ accountId, transactions, env = process.env }) {
  await initDirect({ env });
  const result = await actual.addTransactions(accountId, transactions);
  await actual.sync();
  return result;
}

export async function shutdownDirect() {
  if (!initialized) return;
  await actual.shutdown();
  initialized = false;
}

export async function listAccountsDirect({ env = process.env } = {}) {
  await initDirect({ env });
  return actual.getAccounts();
}
