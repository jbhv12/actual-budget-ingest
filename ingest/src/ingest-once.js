#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ingestPdf, moveToFailed, moveToProcessed } from './pipeline.js';

function parseArgs(argv) {
  const flags = { dryRun: false, force: false, all: false };
  const positional = [];
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--all') flags.all = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

async function processOne(pdfPath, flags) {
  const baseDir = path.dirname(pdfPath);
  console.log(`[ingest] ${pdfPath}`);
  try {
    const result = await ingestPdf(pdfPath, { dryRun: flags.dryRun, force: flags.force });
    console.log(`[ingest] ok: bank=${result.bank} account=${result.accountId} txns=${result.count} pushed=${result.pushed}`);
    if (flags.dryRun) {
      console.log(JSON.stringify(result.transactions, null, 2));
    } else {
      const moved = await moveToProcessed(pdfPath, baseDir, result);
      console.log(`[ingest] moved to ${moved}`);
    }
    return { pdfPath, ok: true };
  } catch (err) {
    console.error(`[ingest] FAILED ${pdfPath}: ${err.message}`);
    if (!flags.dryRun) {
      try {
        const { target, sidecar } = await moveToFailed(pdfPath, baseDir, err);
        console.error(`[ingest] moved to ${target}; sidecar: ${sidecar}`);
      } catch (moveErr) {
        console.error(`[ingest] additionally failed to move: ${moveErr.message}`);
      }
    }
    return { pdfPath, ok: false, err };
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv);
  const watchDir = process.env.INGEST_WATCH_DIR || '/data/pdfs';

  let targets = [];
  if (flags.all) {
    const entries = await readdir(watchDir);
    for (const name of entries) {
      const p = path.join(watchDir, name);
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      const s = await stat(p).catch(() => null);
      if (s?.isFile()) targets.push(p);
    }
  } else if (positional.length) {
    targets = positional;
  } else {
    console.error('usage: ingest-once.js [--dry-run] [--force] <path.pdf> [...] | --all');
    process.exit(2);
  }

  if (targets.length === 0) {
    console.log('[ingest] no PDFs to process');
    return;
  }

  let failures = 0;
  for (const t of targets) {
    const r = await processOne(t, flags);
    if (!r.ok) failures++;
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
