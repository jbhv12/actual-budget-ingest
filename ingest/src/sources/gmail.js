import { google } from 'googleapis';

export class GmailError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function createGmailClient({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new GmailError(
      'GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN are all required',
      'missing-creds',
    );
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

async function listLabels(gmail) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  return data.labels || [];
}

async function createLabel(gmail, name) {
  const { data } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  return data;
}

export async function ensureLabels(gmail, { base }) {
  const want = [base, `${base}/done`, `${base}/failed`];
  const existing = await listLabels(gmail);
  const byName = new Map(existing.map((l) => [l.name, l]));

  const resolved = {};
  for (const name of want) {
    let label = byName.get(name);
    if (!label) label = await createLabel(gmail, name);
    resolved[name] = label.id;
  }
  return {
    base: resolved[base],
    done: resolved[`${base}/done`],
    failed: resolved[`${base}/failed`],
  };
}

export async function* listPendingMessages(gmail, { baseLabelId, maxResults = 50 }) {
  let pageToken;
  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      labelIds: [baseLabelId],
      maxResults,
      pageToken,
    });
    for (const m of data.messages || []) yield m.id;
    pageToken = data.nextPageToken;
  } while (pageToken);
}

function collectParts(payload, out = []) {
  if (!payload) return out;
  if (payload.parts) for (const p of payload.parts) collectParts(p, out);
  else out.push(payload);
  return out;
}

export async function fetchPdfAttachments(gmail, messageId) {
  const { data: message } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  const parts = collectParts(message.payload);
  const attachments = [];
  for (const part of parts) {
    const isPdf = part.mimeType === 'application/pdf'
      || /\.pdf$/i.test(part.filename || '');
    if (!isPdf || !part.body?.attachmentId) continue;
    const { data } = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: part.body.attachmentId,
    });
    const buf = Buffer.from(data.data, 'base64url');
    attachments.push({
      filename: part.filename || `${messageId}.pdf`,
      buffer: buf,
    });
  }
  return { message, attachments };
}

export async function markDone(gmail, messageId, labels) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labels.done],
      removeLabelIds: [labels.base, 'UNREAD'],
    },
  });
}

export async function markFailed(gmail, messageId, labels) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labels.failed],
      removeLabelIds: [labels.base],
    },
  });
}
