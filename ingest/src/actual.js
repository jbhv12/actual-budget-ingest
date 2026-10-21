export class ActualError extends Error {
  constructor(message, code, body) {
    super(message);
    this.code = code;
    this.body = body;
  }
}

export async function postTransactions({ apiUrl, accountId, transactions }) {
  const resp = await fetch(`${apiUrl.replace(/\/$/, '')}/transactions`, {
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
  const resp = await fetch(`${apiUrl.replace(/\/$/, '')}/accounts`);
  if (!resp.ok) throw new ActualError(`actual_api GET /accounts failed: ${resp.status}`, 'list-failed');
  return resp.json();
}
