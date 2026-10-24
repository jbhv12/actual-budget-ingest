export class ActualError extends Error {
  constructor(message, code, body) {
    super(message);
    this.code = code;
    this.body = body;
  }
}

function base(apiUrl) {
  return apiUrl.replace(/\/$/, '');
}

export async function postTransactions({ apiUrl, accountId, transactions }) {
  const resp = await fetch(`${base(apiUrl)}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, transactions }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body.error) {
    throw new ActualError(
      `actual_api POST /transactions failed: ${resp.status} ${body.error || ''}`,
      'push-failed',
      body,
    );
  }
  return body;
}

export async function listAccounts({ apiUrl }) {
  const resp = await fetch(`${base(apiUrl)}/accounts`);
  if (!resp.ok) throw new ActualError(`actual_api GET /accounts failed: ${resp.status}`, 'list-failed');
  return resp.json();
}

export async function pushSelfTransfersRest({ apiUrl, accountId, transactions }) {
  const resp = await fetch(`${base(apiUrl)}/transfers/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, transactions }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body.error) {
    throw new ActualError(
      `actual_api POST /transfers/push failed: ${resp.status} ${body.error || ''}`,
      'self-transfer-push-failed',
      body,
    );
  }
  return body;
}

export async function resolveOrCreateAccountRest({ apiUrl, name }) {
  const resp = await fetch(`${base(apiUrl)}/accounts/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || body.error) {
    throw new ActualError(
      `actual_api POST /accounts/resolve failed: ${resp.status} ${body.error || ''}`,
      'resolve-failed',
      body,
    );
  }
  return body.id;
}
