#!/usr/bin/env bash
# get-gmail-refresh-token.sh — one-time OAuth 2.0 installed-app flow.
#
# Opens the Google consent page, you click Allow, and this prints the
# refresh token to stdout. Paste into .env locally and `fly secrets set`
# in prod.
#
# Requires GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET from the Desktop OAuth
# client you created at the end of bootstrap-gcp.sh.

set -euo pipefail

: "${GMAIL_CLIENT_ID:?export GMAIL_CLIENT_ID}"
: "${GMAIL_CLIENT_SECRET:?export GMAIL_CLIENT_SECRET}"

SCOPE="https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/ingest"

# Reuse the ingest service's node_modules (googleapis isn't a runtime dep
# so we install it on-demand here).
if ! node -e "import('googleapis').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "==> Installing googleapis (one-time)"
  npm install --no-save googleapis >/dev/null
fi

node - <<'EOF'
import http from 'node:http';
import { google } from 'googleapis';
import { URL } from 'node:url';

const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
];

const oauth2 = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  REDIRECT_URI,
);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.error(`\nOpen this URL in your browser:\n\n${authUrl}\n`);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const code = url.searchParams.get('code');
    const { tokens } = await oauth2.getToken(code);
    res.end('Authorized. You can close this tab.');
    if (!tokens.refresh_token) {
      console.error('ERROR: no refresh_token returned. If you have authorized this client before, revoke the previous grant at https://myaccount.google.com/permissions and re-run.');
      process.exit(1);
    }
    console.log(tokens.refresh_token);
    setTimeout(() => process.exit(0), 100);
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error(err);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1');
EOF
