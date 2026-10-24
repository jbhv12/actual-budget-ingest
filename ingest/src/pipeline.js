import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { extractText, PdfError } from './pdf.js';
import { parseStatement, GeminiError } from './gemini.js';
import { importedId, reconcile } from './dedup.js';
import { loadBanksConfig, accountNameFor, interpolateEnv, isSelfTransfer } from './config.js';
import { postTransactions, resolveOrCreateAccountRest, pushSelfTransfersRest, ActualError } from './actual.js';

function pushMode(env) {
  return env.ACTUAL_PUSH_MODE || (env.ACTUAL_API_URL ? 'rest' : 'direct');
}

async function resolveAccountId({ env, name }) {
  if (pushMode(env) === 'direct') {
    const { resolveOrCreateAccount } = await import('./actual-direct.js');
    return resolveOrCreateAccount({ env, name });
  }
  return resolveOrCreateAccountRest({ apiUrl: env.ACTUAL_API_URL, name });
}

async function categoryMap(env) {
  const { BUDGET_CATEGORIES } = await import('./categories.js');
  if (pushMode(env) === 'direct') {
    const [{ initDirect }, { ensureCategories }] = await Promise.all([
      import('./actual-direct.js'),
      import('./categories.js'),
    ]);
    await initDirect({ env });
    return ensureCategories();
  }
  const apiUrl = (env.ACTUAL_API_URL || 'http://actual_api:5007').replace(/\/$/, '');
  const resp = await fetch(`${apiUrl}/categories/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group: 'Spending', names: BUDGET_CATEGORIES }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`categories/ensure failed: ${resp.status} ${body}`);
  }
  return resp.json();
}

async function pushTransactions({ env, accountId, transactions }) {
  if (pushMode(env) === 'direct') {
    const { pushDirect } = await import('./actual-direct.js');
    return pushDirect({ env, accountId, transactions });
  }
  return postTransactions({
    apiUrl: env.ACTUAL_API_URL || 'http://actual_api:5007',
    accountId,
    transactions,
  });
}

async function pushSelfTransfers({ env, accountId, transactions }) {
  if (pushMode(env) === 'direct') {
    const { pushSelfTransfersDirect } = await import('./actual-direct.js');
    return pushSelfTransfersDirect({ env, accountId, transactions });
  }
  return pushSelfTransfersRest({
    apiUrl: env.ACTUAL_API_URL || 'http://actual_api:5007',
    accountId,
    transactions,
  });
}

function detectBankFromText(banksConfig, text) {
  for (const [key, cfg] of Object.entries(banksConfig)) {
    for (const marker of (cfg.markers || [])) {
      if (new RegExp(marker, 'i').test(text)) return key;
    }
  }
  return null;
}

function bankFromFilename(banksConfig, filename) {
  if (!filename) return null;
  const base = path.basename(filename).toLowerCase();
  for (const key of Object.keys(banksConfig)) {
    if (base.startsWith(key.replace(/_/g, '')) || base.startsWith(key)) return key;
  }
  return null;
}

export async function ingestBuffer(buf, {
  env = process.env,
  dryRun = false,
  force = false,
  banksConfigPath,
  filenameHint = null,
} = {}) {
  const { banks: banksRaw, owner } = await loadBanksConfig(banksConfigPath);
  const banksConfig = interpolateEnv(banksRaw, env);
  const ownerTokens = owner?.name_tokens || [];

  const bankByFilename = bankFromFilename(banksConfig, filenameHint);
  const guesses = bankByFilename
    ? [bankByFilename, ...Object.keys(banksConfig).filter((b) => b !== bankByFilename)]
    : Object.keys(banksConfig);

  let text;
  let bank;
  let lastErr;
  for (const candidate of guesses) {
    const cfg = banksConfig[candidate];
    if (!cfg) continue;
    const password = env[cfg.password_env];
    if (!password) {
      lastErr = new Error(`env var ${cfg.password_env} is empty; cannot decrypt ${candidate} PDF`);
      continue;
    }
    try {
      const out = await extractText(buf, { password });
      const sniff = detectBankFromText(banksConfig, out.text);
      if (sniff && sniff !== candidate) {
        lastErr = new Error(`decrypt succeeded with ${candidate} password but PDF text matched ${sniff}`);
        continue;
      }
      if (!sniff && Object.keys(banksConfig).length > 1) {
        lastErr = new Error(`decrypted with ${candidate} password but no bank marker matched the PDF text`);
        continue;
      }
      text = out.text;
      bank = candidate;
      break;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof PdfError) || err.code !== 'wrong-password') throw err;
    }
  }
  if (!bank) throw lastErr || new Error('could not identify bank or decrypt PDF');

  const bankCfg = banksConfig[bank];
  const statement = await parseStatement(text, {
    apiKey: env.GEMINI_API_KEY,
    bankLabel: bankCfg.label || bank,
    bankKind: bankCfg.kind || 'savings',
  });

  const rec = reconcile(statement);
  if (!rec.ok && !force) {
    const err = new Error(
      `balance reconciliation failed: opening ${statement.opening_balance_paise} + sum(${rec.actual - statement.opening_balance_paise}) = ${rec.actual}, expected closing ${rec.expected} (diff ${rec.diff}). Use --force to override.`,
    );
    err.code = 'reconcile-failed';
    err.reconcile = rec;
    throw err;
  }

  const accountName = accountNameFor(banksConfig, bank);
  const accountId = dryRun ? null : await resolveAccountId({ env, name: accountName });
  const cats = dryRun ? null : await categoryMap(env);

  let weakHashRows = 0;
  const regular = [];
  const selfTransfers = [];
  for (const t of statement.transactions) {
    const self = isSelfTransfer({
      ownerTokens,
      payeeClean: t.payee_clean,
      description: t.description,
    });
    const { id, tier } = importedId({
      bank,
      date: t.date,
      amount_paise: t.amount_paise,
      reference: t.reference,
      balance_paise: t.balance_paise,
      description: t.description,
    });
    if (tier === 'description') weakHashRows++;
    const txn = {
      date: t.date,
      amount: t.amount_paise,
      payee_name: t.payee_clean,
      notes: t.description,
      imported_id: id,
      cleared: true,
    };
    if (self) {
      selfTransfers.push(txn);
      continue;
    }
    if (cats && t.category && t.category !== 'Unknown') {
      const cid = cats[t.category];
      if (cid) txn.category = cid;
    }
    regular.push(txn);
  }
  if (weakHashRows > 0) {
    console.warn(`[pipeline] ${weakHashRows}/${statement.transactions.length} rows use description-only hash fallback; dedup is LLM-sensitive for those`);
  }

  if (dryRun) {
    return { bank, accountName, statement, count: regular.length + selfTransfers.length, selfTransfers: selfTransfers.length, reconcile: rec, transactions: [...regular, ...selfTransfers], pushed: false };
  }

  if (regular.length > 0) {
    await pushTransactions({ env, accountId, transactions: regular });
  }
  if (selfTransfers.length > 0) {
    await pushSelfTransfers({ env, accountId, transactions: selfTransfers });
  }

  return { bank, accountName, accountId, statement, count: regular.length + selfTransfers.length, selfTransfers: selfTransfers.length, reconcile: rec, pushed: true };
}

export async function ingestPdf(pdfPath, opts = {}) {
  const buf = await readFile(pdfPath);
  return ingestBuffer(buf, { ...opts, filenameHint: opts.filenameHint ?? pdfPath });
}

export async function moveToProcessed(pdfPath, baseDir, result) {
  const month = result?.statement?.statement_period?.to?.slice(0, 7) || 'unknown';
  const dest = path.join(baseDir, 'processed', month);
  await mkdir(dest, { recursive: true });
  const target = path.join(dest, path.basename(pdfPath));
  await rename(pdfPath, target);
  return target;
}

export async function moveToFailed(pdfPath, baseDir, err) {
  const dest = path.join(baseDir, 'failed');
  await mkdir(dest, { recursive: true });
  const target = path.join(dest, path.basename(pdfPath));
  await rename(pdfPath, target);
  const sidecar = target.replace(/\.pdf$/i, '.err.json');
  await writeFile(sidecar, JSON.stringify({
    message: err.message,
    code: err.code,
    reconcile: err.reconcile,
    raw: err.raw,
  }, null, 2));
  return { target, sidecar };
}

export { PdfError, GeminiError, ActualError };
