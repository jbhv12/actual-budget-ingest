# Personal Banking Ingestion Pipeline — Design

Automated pipeline that pulls password-protected **HDFC** bank statement PDFs,
extracts transactions via Gemini, and pushes them into a local Actual Budget
server. ICICI and Standard Chartered are explicitly out of scope for v1 (same
architecture, add later via `banks.yaml`).

Built to run **entirely locally via docker-compose**. Fly deployment is a
follow-up (section 7); nothing in the core design depends on Fly.

---

## 1. Decisions already made

| Area | Decision | Rationale |
|---|---|---|
| PDF → transactions | **Gemini LLM extraction** | One prompt handles all 3 banks + future ones; resilient to layout changes. Trade-off: per-run cost + nondeterminism, mitigated by validation + dedup. |
| Local test input | **`./fixtures/pdfs/` folder** | Drop PDFs in, pipeline picks them up. No Gmail dependency for dev. Gmail connector added later behind a flag. |
| PDF passwords | **`.env` per bank** | `HDFC_PDF_PASSWORD`, `ICICI_PDF_PASSWORD`, `STANC_PDF_PASSWORD`. Gitignored. Maps cleanly to `fly secrets set` later. |
| Transaction dedup | **Actual's `imported_id`** | Hash of `(bank + account_last4 + date + amount + description)`. Actual natively dedupes. No separate state store needed. |

---

## 2. Architecture

```
                   ./fixtures/pdfs/              (dev)
                        │                         ─── or ───
                   Gmail IMAP/API                 (prod, future)
                        │
                        ▼
                 ┌───────────────┐
                 │   ingest      │   actual_ingest service
                 │   worker      │   • bank detection
                 │               │   • qpdf --decrypt
                 │               │   • pdf-parse → text
                 │               │   • Gemini → structured txns
                 │               │   • validate (zod)
                 │               │   • compute imported_id
                 └───────┬───────┘
                         │   HTTP POST /transactions
                         ▼
                 ┌───────────────┐
                 │  actual_api   │   REST wrapper over
                 │   (:5007)     │   @actual-app/api
                 └───────┬───────┘
                         │   sync
                         ▼
                 ┌───────────────┐
                 │ actual_server │   Actual Budget UI
                 │   (:5006)     │
                 └───────────────┘
```

Everything above the dashed line is pluggable: swap `fixtures/pdfs/` for Gmail
without touching the rest. The ingest worker exposes one input interface
(`ingestPdf(buffer, hints)`) and one output interface (POST to actual_api).

---

## 3. Components

### 3.1 `actual_ingest` service (new)

A new container in `docker-compose.yml`. Node 22 + Alpine.

Dependencies:
- `pdf-parse` — text extraction
- `qpdf` (apt/apk) — PDF decryption shelled out as a subprocess (pdf-lib's
  decryption is unreliable for AES-256 PDFs; qpdf handles everything)
- `@google/generative-ai` — Gemini SDK
- `zod` — schema validation for Gemini output
- `chokidar` — watch `fixtures/pdfs/` in dev
- No framework. Plain scripts invoked by `docker compose run` or a cron.

Entry points:
- `ingest-watch.js` — long-running watcher (dev loop)
- `ingest-once.js <pdf-path>` — one-shot for CI / manual runs
- `ingest-gmail.js` — Gmail poller (phase 2, stubbed in v1)

### 3.2 Bank detection

A PDF's bank is inferred from:
1. **Filename convention**: `hdfc_*.pdf`, `icici_*.pdf`, `stanc_*.pdf`. First-pass.
2. **PDF metadata/text sniff**: unlock with each candidate password until one works;
   first page text matches a bank marker (e.g. "HDFC Bank Ltd", "ICICI Bank").

Account identification (which Actual account to push to) comes from a config file:

```yaml
# ingest/banks.yaml
banks:
  hdfc:
    password_env: HDFC_PDF_PASSWORD
    account_markers: ["HDFC Bank Ltd"]
    accounts:
      - last4: "1234"
        actual_account_id: "e4823a6c-..."
  icici:
    password_env: ICICI_PDF_PASSWORD
    account_markers: ["ICICI Bank"]
    accounts:
      - last4: "5678"
        actual_account_id: "..."
  stanc:
    password_env: STANC_PDF_PASSWORD
    account_markers: ["Standard Chartered"]
    accounts:
      - last4: "9012"
        actual_account_id: "..."
```

Last-4 is read from the statement header text (LLM also returns it as a
sanity-check field).

### 3.3 LLM extraction

Prompt skeleton (Gemini `gemini-1.5-pro` or `gemini-2.5-flash`):

```
System: You are a bank statement parser. Return STRICT JSON matching this schema:
{
  "account_last4": "string, 4 digits",
  "statement_period": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"},
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "string, cleaned",
      "amount_paise": "integer, negative=debit, positive=credit",
      "balance_paise": "integer or null",
      "reference": "string or null"
    }
  ]
}

User: <extracted PDF text>
```

Validation with zod. If parse fails or schema violates, mark the PDF as failed
and move to `fixtures/pdfs/failed/` with a `.err.json` sidecar.

### 3.4 Dedup via `imported_id`

```js
function importedId({ bank, account_last4, date, amount_paise, description }) {
  const norm = description.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto
    .createHash('sha256')
    .update(`${bank}|${account_last4}|${date}|${amount_paise}|${norm}`)
    .digest('hex')
    .slice(0, 24);
}
```

Pass this as `imported_id` on each transaction. Actual's `addTransactions` already
skips existing imported_ids within the same account. Two statements that overlap
(the common case) deduplicate automatically.

### 3.5 `actual_api` changes

Current wrapper accepts `imported_id` already because it forwards arbitrary
fields to `@actual-app/api`. One small addition: a `/accounts/by-name` convenience
endpoint so banks.yaml can reference accounts by name instead of brittle UUIDs.

---

## 4. Local development loop

```bash
# One-time
cp .env.example .env            # fill in GEMINI_API_KEY, bank passwords
docker compose up -d --build

# Add a statement
cp ~/Downloads/hdfc_oct_2026.pdf fixtures/pdfs/
# ingest watcher picks it up, logs show extraction + push

# Reprocess everything
docker compose run --rm actual_ingest node ingest-once.js --all

# Dry run (parse only, don't push)
docker compose run --rm actual_ingest node ingest-once.js fixtures/pdfs/foo.pdf --dry-run
```

Successful PDFs move to `fixtures/pdfs/processed/<YYYY-MM>/`. Failures go to
`fixtures/pdfs/failed/` with a sibling `.err.json` describing what broke.

---

## 5. File layout

```
.
├── docker-compose.yml                 (existing, adds actual_ingest)
├── .env.example                       (new)
├── PIPELINE.md                        (this file)
├── actual-data/                       (existing, server data)
├── api-scripts/                       (existing, actual_api service)
├── ingest/                            (new)
│   ├── Dockerfile
│   ├── package.json
│   ├── banks.yaml
│   ├── src/
│   │   ├── ingest-watch.js
│   │   ├── ingest-once.js
│   │   ├── pdf.js                     (decrypt + text extract)
│   │   ├── gemini.js                  (LLM call + schema)
│   │   ├── dedup.js                   (imported_id)
│   │   ├── actual.js                  (POST to actual_api)
│   │   └── config.js                  (banks.yaml loader)
│   └── test/
│       └── fixtures/                  (anonymized sample PDFs for CI)
└── fixtures/
    └── pdfs/
        ├── <drop PDFs here>
        ├── processed/
        └── failed/
```

---

## 6. Resolved gaps (locked for v1)

| # | Gap | Resolution |
|---|---|---|
| 1 | Multi-bank support | **HDFC only** in v1. `banks.yaml` has one entry; ICICI/StanC added later with no architectural change. |
| 2 | Payee normalization | Gemini returns a `payee_clean` field alongside raw `description`. We push `payee_clean` as the Actual payee; raw description goes to `notes` for audit. |
| 3 | Balance reconciliation | Pipeline rejects a PDF if `opening_paise + Σ amount_paise ≠ closing_paise`. Rejected PDFs land in `fixtures/pdfs/failed/` with sidecar `.err.json`. Override via `--force` flag on `ingest-once.js`. |
| 4 | `imported_id` stability under LLM nondeterminism | Hash is computed from **structural fields only**: `sha256(bank + account_last4 + date + amount_paise + reference_or_firstN_of_description).slice(0,24)`. The LLM-rewritten `payee_clean` is **not** part of the hash. |
| 5 | Multi-currency | **INR only.** Any transaction Gemini returns with a non-INR hint causes the whole PDF to fail with a currency error. |
| 6 | Observability | **stdout logs only** for v1. No status endpoint, no Slack notifier. `docker compose logs -f actual_ingest` is the observability surface. |

### Still-open (deferred to v2, not blocking v1)

- **Category inference.** Transactions land uncategorized. User categorizes in UI.
- **Gmail connector.** Design placeholder in section 3.1; v1 reads from
  `./fixtures/pdfs/` only.
- **Account-to-ID bootstrap.** User creates one HDFC account manually in the UI,
  then edits `banks.yaml` with the UUID from `curl :5007/accounts`. An `ingest init`
  command could automate this but is not v1.
- **Retention policy.** Processed PDFs stay in `processed/<YYYY-MM>/` indefinitely.
  Housekeeping is manual.
- **"Serverless" terminology.** For Fly: `actual_ingest` becomes a scheduled Fly
  machine, not FaaS. v1 runs as a long-lived container; the pipeline function is
  the same.

---

## 7. Fly deployment (future — not part of v1)

Deliberately out of scope for v1 implementation but **informs v1 architecture**
because section 9 (IaC + public repo) requires it.

- `actual_server` → Fly app with a persistent volume for `/data`.
- `actual_api` → Fly app on an internal 6PN hostname (no public port).
- `actual_ingest` → Fly scheduled machine (hourly or daily), reads from Gmail,
  pushes to `actual_api` internal URL.
- Secrets via `fly secrets set` (never committed).
- Nothing in sections 1–6 changes; only the hostnames + the input source.

---

## 8. v1 implementation plan (local only)

Ordered so each step is independently testable.

1. **Add `actual_ingest` service to `docker-compose.yml`**, empty Dockerfile that
   just sleeps. Confirm it builds and starts.
2. **`pdf.js`** — decrypt + text extract. Test by passing a sample PDF, inspect
   stdout for raw text.
3. **`gemini.js`** — call Gemini with the text, print parsed JSON. Validate
   with zod. Test with 2–3 PDFs per bank.
4. **`dedup.js` + `actual.js`** — hash + POST. Test idempotency by running the
   same PDF twice; second run should produce zero new rows.
5. **`banks.yaml` + config loader** — plug in real account IDs. Confirm
   transactions land in the correct Actual account.
6. **`ingest-watch.js`** — chokidar watcher on `fixtures/pdfs/`. Drop a PDF,
   watch it process end-to-end.
7. **`ingest-once.js --dry-run` and `--all`** — ergonomics for manual reruns.
8. **Error paths** — move failing PDFs to `failed/` with sidecar JSON. Test by
   feeding a corrupt PDF and a wrong-password PDF.

Done = you can drop a real HDFC statement in `fixtures/pdfs/` and see the
transactions appear in the Actual UI within ~30 seconds, with reruns producing
no duplicates.

---

## 9. IaC + public-GitHub strategy

**Goal.** Everything in this repo is reproducible from `git clone` + a short
list of `cli` commands. No console clicks except one unavoidable Google step.
Repo is public; secrets live only in `.env` (local) / `fly secrets` (prod).

### 9.1 What's fully IaC

| Component | Tool |
|---|---|
| Local dev stack (actual_server, actual_api, actual_ingest) | `docker-compose.yml` |
| GCP project | `gcloud projects create` or Terraform `google_project` |
| Enable Gmail API | `gcloud services enable gmail.googleapis.com` |
| Fly apps + volumes + regions | `fly.toml` per app, `fly deploy` |
| Fly secrets | `fly secrets set` |
| Fly scheduled machines (for ingest cron) | `fly machine run --schedule=` |
| GitHub Actions secrets | `gh secret set` |
| CI/CD (lint, test, deploy) | `.github/workflows/*.yml` |
| Secret-scan protection | `gitleaks` GitHub Action |

### 9.2 The unavoidable console step

**Google OAuth 2.0 user-consent clients cannot be created via API, CLI, or
Terraform.** This is a Google platform limitation, not something we can code
around. (Terraform's `google_iap_client` is a *different* thing — IAP, not
general-purpose OAuth.)

The one-time console step:
1. GCP Console → APIs & Services → OAuth consent screen → user type **Internal**
   (Workspace only; skips Google's verification).
2. Credentials → Create OAuth client ID → **Desktop app**.
3. Download JSON; the `client_id` is public, the `client_secret` goes in
   `.env` locally and `fly secrets set` in prod.

Everything else (API enablement, project creation, filter rules in Gmail,
secret storage, deployment) is CLI/IaC.

### 9.3 Alternative paths (all have one console step somewhere)

| Path | Console step | Suitability |
|---|---|---|
| **A. OAuth user-consent (recommended)** | GCP Console once, create OAuth client | Default. Works on Workspace or personal Gmail. |
| B. IMAP + App Password | Google account settings: enable 2FA + App Password | Blocked by many Workspace admins |
| C. Service Account + Domain-Wide Delegation | Workspace Admin Console: authorize client ID | Requires admin access to the Workspace |
| D. Forward to a personal Gmail you control | GCP Console (on that account) once | Decouples from Workspace policy; still one click |

v1 is folder-based (section 4) so none of this is on the critical path. v2
Gmail connector defaults to **Path A**.

### 9.4 Bootstrap flow (someone cloning this repo on a new laptop)

```bash
git clone <this repo>
cd actual
cp .env.example .env                        # fill in locally
# ─── local dev ────────────────────────────────────────────
docker compose up -d                        # done, see fixtures/pdfs/
# ─── prod deploy (future) ─────────────────────────────────
./scripts/bootstrap-gcp.sh                  # gcloud create project + enable Gmail API
# ⚠  one manual: GCP Console → OAuth client → paste client_id/secret into prompts
./scripts/bootstrap-fly.sh                  # fly launch for each of 3 apps
./scripts/get-gmail-refresh-token.sh        # opens browser, writes token to stdout
fly secrets set --app actual-ingest \
   GEMINI_API_KEY=... \
   HDFC_PDF_PASSWORD=... \
   GMAIL_CLIENT_ID=... \
   GMAIL_CLIENT_SECRET=... \
   GMAIL_REFRESH_TOKEN=...
fly deploy --app actual-server
fly deploy --app actual-api
fly deploy --app actual-ingest
```

Everything is checked in except `.env`. Secret values flow:
`.env` (local) → `fly secrets set` (CLI, interactive paste) → Fly runtime env.

### 9.5 Public-repo hygiene

**Must be gitignored** (already in `.gitignore`):
- `.env`
- `actual-data/` — contains the sqlite with password hashes
- `api-scripts/budget-cache/` — contains downloaded budget data
- `ingest/node_modules/`, `api-scripts/node_modules/`
- `fixtures/pdfs/*.pdf` — any real statement PDF
- `fixtures/pdfs/processed/`, `fixtures/pdfs/failed/`

**Safe to commit:**
- OAuth client ID (public by design)
- GCP project ID, Fly app names
- `banks.yaml` *schema* — but redact the `actual_account_id` UUIDs if the repo is
  truly public (they're not secrets, but they reveal your account structure)

**CI protection:**
- `gitleaks` action on every PR + push
- A pre-commit hook running `gitleaks protect --staged` locally
- Branch protection: no direct pushes to `main`

### 9.6 CI/CD

`.github/workflows/`:
- `ci.yml` — on PR: lint, unit tests (ingest parsers against synthetic fixture PDFs
  in `ingest/test/fixtures/`), `docker compose build` smoke test, `gitleaks`
- `deploy.yml` — on push to `main`: `fly deploy` for each app (secrets injected
  via `FLY_API_TOKEN` GitHub secret)
- `secret-scan.yml` — scheduled daily full-history gitleaks scan

Secrets stored in GitHub repo settings via `gh secret set`:
- `FLY_API_TOKEN` — the only one GitHub Actions needs

Everything else lives in `fly secrets` and never touches GitHub.

### 9.7 Decisions to lock before v2 (Gmail connector)

- Workspace OAuth user type: **Internal** (requires owning the Workspace) or
  Google-verified **External** (requires app verification process — slow).
  Default: Internal.
- Service Account + DWD path: deferred unless Internal OAuth is blocked.
- Pub/Sub push notifications: rejected (needs public endpoint, 7-day watch
  renewal). Polling cron is enough.
