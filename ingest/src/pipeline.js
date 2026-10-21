import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { extractText, PdfError } from './pdf.js';
import { parseStatement, GeminiError } from './gemini.js';
import { importedId, reconcile } from './dedup.js';
import { loadBanksConfig, resolveAccount, interpolateEnv } from './config.js';
import { postTransactions, ActualError } from './actual.js';

function pushMode(env) {
  return env.ACTUAL_PUSH_MODE || (env.ACTUAL_API_URL ? 'rest' : 'direct');
}

async function categoryMapIfDirect(env) {
  if (pushMode(env) !== 'direct') return null;
  const [{ initDirect }, { ensureCategories }] = await Promise.all([
    import('./actual-direct.js'),
    import('./categories.js'),
  ]);
  await initDirect({ env });
  return ensureCategories();
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

function detectBank(text) {
  if (/HDFC Bank/i.test(text)) return 'hdfc';
  return null;
}

function bankFromFilename(filename) {
  if (!filename) return null;
  const base = path.basename(filename);
  return /^(hdfc|icici|stanc)/i.exec(base)?.[1]?.toLowerCase() || null;
}

export async function ingestBuffer(buf, {
  env = process.env,
  dryRun = false,
  force = false,
  banksConfigPath,
  filenameHint = null,
} = {}) {
  const banksRaw = await loadBanksConfig(banksConfigPath);
  const banksConfig = interpolateEnv(banksRaw, env);

  const bankByFilename = bankFromFilename(filenameHint);
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
      const sniff = detectBank(out.text);
      if (sniff && sniff !== candidate) {
        lastErr = new Error(`decrypt succeeded with ${candidate} password but PDF looks like ${sniff}`);
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

  const statement = await parseStatement(text, { apiKey: env.GEMINI_API_KEY });

  const rec = reconcile(statement);
  if (!rec.ok && !force) {
    const err = new Error(
      `balance reconciliation failed: opening ${statement.opening_balance_paise} + sum(${rec.actual - statement.opening_balance_paise}) = ${rec.actual}, expected closing ${rec.expected} (diff ${rec.diff}). Use --force to override.`,
    );
    err.code = 'reconcile-failed';
    err.reconcile = rec;
    throw err;
  }

  const accountId = resolveAccount(banksConfig, bank, statement.account_last4);
  const categoryMap = dryRun ? null : await categoryMapIfDirect(env);

  const payload = statement.transactions.map((t) => {
    const txn = {
      date: t.date,
      amount: t.amount_paise,
      payee_name: t.payee_clean,
      notes: t.description,
      imported_id: importedId({
        bank,
        account_last4: statement.account_last4,
        date: t.date,
        amount_paise: t.amount_paise,
        reference: t.reference,
        description: t.description,
      }),
      cleared: true,
    };
    if (categoryMap && t.category && t.category !== 'Unknown') {
      const id = categoryMap[t.category];
      if (id) txn.category = id;
    }
    return txn;
  });

  if (dryRun) {
    return { bank, accountId, statement, count: payload.length, reconcile: rec, transactions: payload, pushed: false };
  }

  await pushTransactions({ env, accountId, transactions: payload });

  return { bank, accountId, statement, count: payload.length, reconcile: rec, pushed: true };
}

export async function ingestPdf(pdfPath, opts = {}) {
  const buf = await readFile(pdfPath);
  return ingestBuffer(buf, { ...opts, filenameHint: opts.filenameHint ?? pdfPath });
}

export async function moveToProcessed(pdfPath, baseDir, period) {
  const month = period?.to?.slice(0, 7) || 'unknown';
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
