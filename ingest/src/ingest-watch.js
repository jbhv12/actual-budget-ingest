#!/usr/bin/env node
import chokidar from 'chokidar';
import path from 'node:path';
import { ingestPdf, moveToFailed, moveToProcessed } from './pipeline.js';

const WATCH_DIR = process.env.INGEST_WATCH_DIR || '/data/pdfs';
const SOURCE = process.env.INGEST_SOURCE || 'folder';

if (SOURCE === 'gmail') {
  console.error('[watch] INGEST_SOURCE=gmail is a v2 feature and not yet implemented. Set INGEST_SOURCE=folder.');
  process.exit(1);
}

console.log(`[watch] source=${SOURCE} dir=${WATCH_DIR}`);

async function handle(pdfPath) {
  console.log(`[watch] ${pdfPath}`);
  try {
    const result = await ingestPdf(pdfPath);
    console.log(`[watch] ok: bank=${result.bank} txns=${result.count}`);
    const moved = await moveToProcessed(pdfPath, WATCH_DIR, result);
    console.log(`[watch] -> ${moved}`);
  } catch (err) {
    console.error(`[watch] FAILED ${pdfPath}: ${err.message}`);
    try {
      const { target, sidecar } = await moveToFailed(pdfPath, WATCH_DIR, err);
      console.error(`[watch] -> ${target} (sidecar: ${sidecar})`);
    } catch (moveErr) {
      console.error(`[watch] additionally failed to move: ${moveErr.message}`);
    }
  }
}

const watcher = chokidar.watch(WATCH_DIR, {
  depth: 0,
  ignoreInitial: false,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  ignored: (p) => /\/(processed|failed)\//.test(p),
});

watcher.on('add', (p) => {
  if (p.toLowerCase().endsWith('.pdf')) handle(p);
});

watcher.on('error', (err) => console.error(`[watch] error: ${err.message}`));

const shutdown = () => {
  console.log('[watch] shutting down');
  watcher.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
