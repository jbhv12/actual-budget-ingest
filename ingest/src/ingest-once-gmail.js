#!/usr/bin/env node
// One-shot Gmail poll: list messages with the ingest label, process each
// PDF attachment through ingestBuffer(), ack via label change. Exits when
// done — suitable for a cron / Fly scheduled machine.

import { ingestBuffer } from './pipeline.js';
import {
  createGmailClient,
  ensureLabels,
  listPendingMessages,
  fetchPdfAttachments,
  markDone,
  markFailed,
} from './sources/gmail.js';

const env = process.env;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const BASE_LABEL = env.GMAIL_LABEL || 'actual-ingest';

async function main() {
  const gmail = createGmailClient({
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    refreshToken: env.GMAIL_REFRESH_TOKEN,
  });

  console.log(`[gmail] ensuring labels under "${BASE_LABEL}"`);
  const labels = await ensureLabels(gmail, { base: BASE_LABEL });

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for await (const messageId of listPendingMessages(gmail, { baseLabelId: labels.base })) {
    console.log(`[gmail] message ${messageId}`);
    let anyPdf = false;
    let anyFailed = false;

    try {
      const { attachments } = await fetchPdfAttachments(gmail, messageId);
      if (attachments.length === 0) {
        console.warn(`[gmail] ${messageId}: no PDF attachments; marking failed`);
        if (!DRY_RUN) await markFailed(gmail, messageId, labels);
        failed++;
        continue;
      }

      for (const att of attachments) {
        anyPdf = true;
        try {
          const result = await ingestBuffer(att.buffer, {
            env,
            dryRun: DRY_RUN,
            force: FORCE,
            filenameHint: att.filename,
          });
          console.log(`[gmail] ${messageId}/${att.filename}: ok bank=${result.bank} txns=${result.count} pushed=${result.pushed}`);
        } catch (err) {
          anyFailed = true;
          console.error(`[gmail] ${messageId}/${att.filename}: FAILED (${err.code || 'unknown'}): ${err.message}`);
        }
      }
    } catch (err) {
      anyFailed = true;
      console.error(`[gmail] ${messageId}: fetch failed: ${err.message}`);
    }

    if (DRY_RUN) {
      skipped++;
      continue;
    }

    if (anyFailed || !anyPdf) {
      await markFailed(gmail, messageId, labels);
      failed++;
    } else {
      await markDone(gmail, messageId, labels);
      processed++;
    }
  }

  console.log(`[gmail] done: processed=${processed} failed=${failed} skipped=${skipped}`);
  return failed;
}

try {
  const failed = await main();
  try {
    const { shutdownDirect } = await import('./actual-direct.js');
    await shutdownDirect();
  } catch { /* only loaded if direct mode was used */ }
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('[gmail] fatal:', err);
  process.exit(1);
}
