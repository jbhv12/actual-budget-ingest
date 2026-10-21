#!/usr/bin/env bash
set -euo pipefail

: "${GMAIL_CLIENT_ID:?export GMAIL_CLIENT_ID}"
: "${GMAIL_CLIENT_SECRET:?export GMAIL_CLIENT_SECRET}"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/ingest"

[[ -d node_modules/googleapis ]] || npm install >/dev/null

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
      // Google only returns refresh_token on first consent; revoke at
      // https://myaccount.google.com/permissions and re-run if needed.
      console.error('ERROR: no refresh_token returned. Revoke prior grant and re-run.');
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
