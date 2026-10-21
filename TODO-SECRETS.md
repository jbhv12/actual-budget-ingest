# Secrets setup checklist

The things you (the human) run from a shell. Nothing here goes into git.
Everything is CLI; no console except where Google forces it (section 2).

Assumes you have `gh`, `fly`, `gcloud`, `jq` installed and logged in.

---

## 0. Variables used throughout

```bash
export GCP_PROJECT_ID="actual-ingest-$USER"
export FLY_APP_PREFIX="$USER-actual"            # used for all 3 fly apps
export GITHUB_REPO="$USER/actual-ingest"        # owner/name of your public repo
```

---

## 1. Local dev secrets (`.env`)

```bash
cp .env.example .env
# Edit .env — fill in:
#   ACTUAL_PASSWORD        (pick a strong password; used by server + API wrapper)
#   ACTUAL_SYNC_ID         (filled in after step 4 below)
#   GEMINI_API_KEY         (https://aistudio.google.com/apikey)
#   HDFC_PDF_PASSWORD      (HDFC statement password; convention: first 4 letters
#                           of name uppercase + DDMM of DOB, e.g. JOHN0105)
```

`.env` is gitignored. Never commit it.

---

## 2. GCP + Gmail OAuth (one-time, needed for v2 Gmail connector only)

```bash
./scripts/bootstrap-gcp.sh
```

This creates the project and enables Gmail API. It will then print the
**one unavoidable manual step** — about 2 minutes in the GCP Console to
create the OAuth consent screen (user type: Internal) and OAuth 2.0
Client ID (type: Desktop app). Follow the printed URL.

After the console step, copy the client id and secret, then:

```bash
export GMAIL_CLIENT_ID='<from console>'
export GMAIL_CLIENT_SECRET='<from console>'
./scripts/get-gmail-refresh-token.sh    # opens browser, writes refresh token to stdout
# -> copy the printed refresh token
```

---

## 3. GitHub Actions secrets (for CI/CD deploys)

Only one is strictly required: `FLY_API_TOKEN`. Everything else lives in
Fly secrets, not GitHub, so the deploy workflow never sees them.

```bash
# Generate a scoped Fly API token for CI
fly tokens create deploy -x 999999h > /tmp/fly-token
gh secret set FLY_API_TOKEN --repo "$GITHUB_REPO" < /tmp/fly-token
rm /tmp/fly-token

# Non-secret variable (interpolated into fly.toml app names)
gh variable set FLY_APP_PREFIX --repo "$GITHUB_REPO" --body "$FLY_APP_PREFIX"
```

---

## 4. Fly apps + volume (one-time)

```bash
./scripts/bootstrap-fly.sh
```

Creates `$FLY_APP_PREFIX-server`, `-api`, `-ingest`, plus a 1GB volume
for the server's `/data`.

Then do the first server deploy (needed before you can create a budget
and know the sync id):

```bash
fly deploy --remote-only \
  -c deploy/fly/actual-server/fly.toml \
  --app "$FLY_APP_PREFIX-server"
```

Create a strong password and set it:

```bash
ACTUAL_PASSWORD=$(openssl rand -hex 24)
echo "ACTUAL_PASSWORD=$ACTUAL_PASSWORD" >> .env     # also store locally
printf '%s' "$ACTUAL_PASSWORD" | fly secrets set --app "$FLY_APP_PREFIX-server" ACTUAL_PASSWORD=- --stage
fly deploy --remote-only -c deploy/fly/actual-server/fly.toml --app "$FLY_APP_PREFIX-server"
```

Now open the server, create your budget + HDFC account, then grab the sync id:

```bash
APP_URL="https://$FLY_APP_PREFIX-server.fly.dev"
TOKEN=$(curl -s -X POST "$APP_URL/account/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ACTUAL_PASSWORD\"}" | jq -r .data.token)
ACTUAL_SYNC_ID=$(curl -s "$APP_URL/sync/list-user-files" \
  -H "x-actual-token: $TOKEN" | jq -r '.data[0].groupId')
echo "ACTUAL_SYNC_ID=$ACTUAL_SYNC_ID" >> .env
```

---

## 5. Fly secrets for the API wrapper

```bash
fly secrets set --app "$FLY_APP_PREFIX-api" \
  ACTUAL_PASSWORD="$ACTUAL_PASSWORD" \
  ACTUAL_SYNC_ID="$ACTUAL_SYNC_ID" \
  ACTUAL_SERVER_URL="http://${FLY_APP_PREFIX}-server.internal:5006"
```

Then deploy:

```bash
fly deploy --remote-only \
  -c deploy/fly/actual-api/fly.toml \
  --app "$FLY_APP_PREFIX-api" \
  --dockerfile api-scripts/Dockerfile \
  api-scripts
```

Grab the HDFC Actual account id (from the UI you'll create it there, or
query the API):

```bash
HDFC_ACCOUNT_ID=$(fly ssh console --app "$FLY_APP_PREFIX-api" \
  --command "wget -qO- http://localhost:5007/accounts" | jq -r '.[0].id')
echo "HDFC_SAVINGS_ACCOUNT_ID=$HDFC_ACCOUNT_ID" >> .env
```

Update `ingest/banks.yaml`:

```yaml
banks:
  hdfc:
    password_env: HDFC_PDF_PASSWORD
    markers: ["HDFC Bank"]
    accounts:
      - last4: "1234"                                            # your HDFC last 4
        actual_account_id: "${HDFC_SAVINGS_ACCOUNT_ID}"           # env-interpolated
```

Commit the `banks.yaml` change (safe — the UUID is only in env).

---

## 6. Fly secrets for the ingest worker

```bash
fly secrets set --app "$FLY_APP_PREFIX-ingest" \
  ACTUAL_API_URL="http://${FLY_APP_PREFIX}-api.internal:5007" \
  GEMINI_API_KEY="<your Gemini key>" \
  HDFC_PDF_PASSWORD="<your HDFC statement password>" \
  HDFC_SAVINGS_ACCOUNT_ID="$HDFC_ACCOUNT_ID" \
  GMAIL_CLIENT_ID="$GMAIL_CLIENT_ID" \
  GMAIL_CLIENT_SECRET="$GMAIL_CLIENT_SECRET" \
  GMAIL_REFRESH_TOKEN="<from step 2>"
```

---

## 7. First deploy from GitHub

Everything above is one-time. After this, pushing to `main` triggers the
deploy workflow and reconciles all three apps.

```bash
git remote add origin "git@github.com:$GITHUB_REPO.git"
git push -u origin main
```

Watch the first deploy:

```bash
gh run watch --repo "$GITHUB_REPO"
```

---

## 8. Convert ingest to a scheduled machine (post-v2 Gmail wiring)

Once the Gmail connector lands, you want `actual_ingest` to run on a
schedule, not continuously:

```bash
# List current machines, pick the ingest one
fly machines list --app "$FLY_APP_PREFIX-ingest"
# Update its schedule
fly machine update <machine-id> \
  --schedule hourly \
  --app "$FLY_APP_PREFIX-ingest"
```

---

## Secret rotation

| Secret | How to rotate |
|---|---|
| `ACTUAL_PASSWORD` | `fly secrets set` on both `-server` and `-api`; redeploy |
| `GEMINI_API_KEY` | Rotate in AI Studio, `fly secrets set` on `-ingest`, redeploy |
| `HDFC_PDF_PASSWORD` | Just update `fly secrets set` on `-ingest`; no redeploy needed |
| `GMAIL_REFRESH_TOKEN` | Rerun `scripts/get-gmail-refresh-token.sh`, `fly secrets set` |
| `FLY_API_TOKEN` | `fly tokens create` + `gh secret set` |

Rotation of any secret is just the matching `fly secrets set` line above —
nothing else to change in the repo.
