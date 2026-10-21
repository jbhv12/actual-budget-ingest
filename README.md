# actual-ingest

Self-hosted [Actual Budget](https://actualbudget.org/) + an automated ingestion
pipeline that pulls password-protected HDFC bank statement PDFs, extracts
transactions with Gemini, and pushes them straight into your budget.

Designed to run **locally with `docker compose`** or on **Fly.io** via the
same codebase. Fully IaC — the only unavoidable manual step is a one-time
GCP Console click to create the Gmail OAuth client (section below).

See [`PIPELINE.md`](./PIPELINE.md) for the full design.

## Repo layout

```
.
├── docker-compose.yml           three services: actual_server, actual_api, actual_ingest
├── api-scripts/                 REST wrapper around @actual-app/api
├── ingest/                      PDF -> Gemini -> Actual pipeline
├── deploy/fly/                  per-app fly.toml for cloud deployment
├── scripts/                     bootstrap-gcp.sh, bootstrap-fly.sh, get-gmail-refresh-token.sh
├── .github/workflows/           CI (lint + gitleaks), deploy (fly), daily secret scan
├── fixtures/pdfs/               drop PDFs here for local ingest (gitignored)
├── PIPELINE.md                  design doc
└── TODO-SECRETS.md              post-clone commands to populate secrets
```

## Quickstart — local

```bash
git clone <this repo>
cd actual
cp .env.example .env             # fill in: ACTUAL_PASSWORD, GEMINI_API_KEY, HDFC_PDF_PASSWORD
docker compose up -d actual_server

# Open http://localhost:5006, create a budget, create an account (e.g. "HDFC Savings").
# Grab the sync id (= groupId) and your account id:
TOKEN=$(curl -s -X POST http://localhost:5006/account/login \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$(grep ACTUAL_PASSWORD .env | cut -d= -f2)\"}" | jq -r .data.token)
curl -s http://localhost:5006/sync/list-user-files -H "x-actual-token: $TOKEN" | jq
# -> paste the groupId into .env as ACTUAL_SYNC_ID

docker compose up -d actual_api
curl http://localhost:5007/accounts
# -> paste the account id into ingest/banks.yaml under hdfc.accounts[0].actual_account_id

docker compose up -d actual_ingest
cp ~/Downloads/hdfc_oct_2026.pdf fixtures/pdfs/
docker compose logs -f actual_ingest    # watch extraction + push
```

Transactions land in Actual within ~30s. Re-running the same PDF produces zero
duplicates (dedup via `imported_id`).

## Dev loop

Two input sources, pick via `INGEST_SOURCE` in `.env`:

### Folder mode (default) — no OAuth needed

- Drop PDFs in `fixtures/pdfs/` — the watcher picks them up automatically.
- Successful PDFs move to `fixtures/pdfs/processed/<YYYY-MM>/`.
- Failed PDFs move to `fixtures/pdfs/failed/` with a sibling `.err.json`.
- For one-off runs:

  ```bash
  docker compose run --rm actual_ingest node src/ingest-once.js --dry-run /data/pdfs/foo.pdf
  ```

Flags on `ingest-once.js`:
- `--dry-run` — print parsed transactions, don't push, don't move the file
- `--force` — ignore opening/closing balance reconciliation failure
- `--all` — process every `*.pdf` in `fixtures/pdfs/`

### Gmail mode — same locally as in production

1. Finish the GCP + OAuth setup (see `TODO-SECRETS.md` sections 2+3).
2. Set in `.env`:

   ```
   INGEST_SOURCE=gmail
   GMAIL_CLIENT_ID=...
   GMAIL_CLIENT_SECRET=...
   GMAIL_REFRESH_TOKEN=...
   GMAIL_POLL_INTERVAL_SEC=60     # shorter for dev
   ```

3. In Gmail, create a filter: `from:alerts@hdfcbank.net has:attachment` →
   apply label `actual-ingest`. (Also manually apply the label to a real
   past statement email for your first test.)

4. Run:

   ```bash
   docker compose up -d actual_ingest
   docker compose logs -f actual_ingest
   ```

   The container polls every `GMAIL_POLL_INTERVAL_SEC` seconds. For a
   one-shot test instead:

   ```bash
   docker compose run --rm actual_ingest node src/ingest-once-gmail.js --dry-run
   ```

Successful messages get the `actual-ingest/done` label; failed ones get
`actual-ingest/failed`. The base `actual-ingest` label is removed either
way, so re-running processes only new emails.

## Deploy to Fly.io

Full step-by-step with every command: [`TODO-SECRETS.md`](./TODO-SECRETS.md).
High-level flow:

```bash
# 1. GCP (once per Google account) — needed for Gmail connector
export GCP_PROJECT_ID=actual-ingest-$USER
./scripts/bootstrap-gcp.sh
# -> prints the one unavoidable 2-minute GCP Console step
#    (OAuth consent screen + OAuth 2.0 Client ID)

export GMAIL_CLIENT_ID=...
export GMAIL_CLIENT_SECRET=...
./scripts/get-gmail-refresh-token.sh    # browser OAuth, prints refresh_token

# 2. Fly (once per account)
export FLY_APP_PREFIX=$USER-actual
./scripts/bootstrap-fly.sh

# 3. Set secrets (fly secrets set + gh secret set FLY_API_TOKEN)
# 4. First deploy happens automatically on next push to main
# 5. Convert ingest to scheduled machine:
fly machine update <id> --schedule hourly --app $FLY_APP_PREFIX-ingest
```

## Public repo safety

- `.gitignore` excludes `.env`, `actual-data/`, `api-scripts/budget-cache/`,
  `fixtures/pdfs/*.pdf`, and OAuth tokens.
- `banks.yaml` can leave `actual_account_id` as `${HDFC_SAVINGS_ACCOUNT_ID}`
  so account UUIDs are env-interpolated at runtime.
- CI runs `gitleaks` on every PR and daily full-history.
- Secrets live in `.env` (local, gitignored) and in `fly secrets` / GitHub
  Actions secrets (prod). Never in the repo.
