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

- Drop PDFs in `fixtures/pdfs/` — the watcher picks them up automatically.
- Successful PDFs move to `fixtures/pdfs/processed/<YYYY-MM>/`.
- Failed PDFs move to `fixtures/pdfs/failed/` with a sibling `.err.json`.
- For one-off runs: `docker compose run --rm actual_ingest node src/ingest-once.js --dry-run /data/pdfs/foo.pdf`

Flags on `ingest-once.js`:
- `--dry-run` — print parsed transactions, don't push, don't move the file
- `--force` — ignore opening/closing balance reconciliation failure
- `--all` — process every `*.pdf` in `fixtures/pdfs/`

## Deploy to Fly.io

See [`TODO-SECRETS.md`](./TODO-SECRETS.md) for the exact `gh secret set` and
`fly secrets set` commands. The high-level flow:

```bash
# 1. GCP (once per Google account)
export GCP_PROJECT_ID=actual-ingest-$USER
./scripts/bootstrap-gcp.sh
# -> prints the one 2-minute GCP Console step (OAuth client creation)

export GMAIL_CLIENT_ID=...
export GMAIL_CLIENT_SECRET=...
./scripts/get-gmail-refresh-token.sh > gmail-token.json    # browser OAuth

# 2. Fly (once per account)
export FLY_APP_PREFIX=$USER-actual
./scripts/bootstrap-fly.sh

# 3. Secrets (see TODO-SECRETS.md)
# 4. First deploy — happens automatically on next push to main via GitHub Actions
```

## Public repo safety

- `.gitignore` excludes `.env`, `actual-data/`, `api-scripts/budget-cache/`,
  `fixtures/pdfs/*.pdf`, and OAuth tokens.
- `banks.yaml` can leave `actual_account_id` as `${HDFC_SAVINGS_ACCOUNT_ID}`
  so account UUIDs are env-interpolated at runtime.
- CI runs `gitleaks` on every PR and daily full-history.
- Secrets live in `.env` (local, gitignored) and in `fly secrets` / GitHub
  Actions secrets (prod). Never in the repo.
