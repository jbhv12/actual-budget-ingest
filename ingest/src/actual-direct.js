// Direct push to the Actual Budget sync server using @actual-app/api.
// Used in production (on Fly) so we don't need a separate actual_api service.
// Local docker-compose still uses the REST wrapper for curl-friendly dev.

import * as actual from '@actual-app/api';
import fs from 'node:fs';

let initialized = false;

async function ensureInit({ serverURL, password, syncId, dataDir }) {
  if (initialized) return;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  await actual.init({ dataDir, serverURL, password });
  await actual.downloadBudget(syncId);
  initialized = true;
}

export async function pushDirect({
  accountId,
  transactions,
  env = process.env,
}) {
  const serverURL = env.ACTUAL_SERVER_URL;
  const password = env.ACTUAL_PASSWORD;
  const syncId = env.ACTUAL_SYNC_ID;
  const dataDir = env.ACTUAL_DATA_DIR || '/data/budget-cache';

  if (!serverURL || !password || !syncId) {
    throw new Error('ACTUAL_SERVER_URL, ACTUAL_PASSWORD and ACTUAL_SYNC_ID are required for direct mode');
  }

  await ensureInit({ serverURL, password, syncId, dataDir });
  const result = await actual.addTransactions(accountId, transactions);
  await actual.sync();
  return result;
}

export async function shutdownDirect() {
  if (initialized) {
    await actual.shutdown();
    initialized = false;
  }
}

export async function listAccountsDirect({ env = process.env } = {}) {
  const serverURL = env.ACTUAL_SERVER_URL;
  const password = env.ACTUAL_PASSWORD;
  const syncId = env.ACTUAL_SYNC_ID;
  const dataDir = env.ACTUAL_DATA_DIR || '/data/budget-cache';
  await ensureInit({ serverURL, password, syncId, dataDir });
  return actual.getAccounts();
}
