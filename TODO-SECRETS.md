# Secrets setup checklist

Steps you run from a shell. Nothing here is committed. Requires `gh`, `fly`,
`gcloud`, `jq`, `openssl` installed and logged in.

## 0. Shared variables

```bash
export GCP_PROJECT_ID="actual-ingest-$USER"
export FLY_APP_PREFIX="$USER-actual"
export GITHUB_REPO="$USER/actual-ingest"
```

## 1. Local `.env`

```bash
cp .env.example .env
# Fill in ACTUAL_PASSWORD, GEMINI_API_KEY, HDFC_PDF_PASSWORD.
# ACTUAL_SYNC_ID + HDFC_SAVINGS_ACCOUNT_ID come later (steps 4+5).
```

## 2. GCP + Gmail OAuth

Only needed for `INGEST_SOURCE=gmail`. Skip to section 4 if you'll test with
the folder source first.

```bash
./scripts/bootstrap-gcp.sh
```

Follow the printed console link to create the OAuth consent screen (user
type: Internal) and OAuth 2.0 Client ID (type: Desktop app). Then:

```bash
export GMAIL_CLIENT_ID='<from console>'
export GMAIL_CLIENT_SECRET='<from console>'
export GMAIL_REFRESH_TOKEN="$(./scripts/get-gmail-refresh-token.sh)"
```

## 3. GitHub secrets

```bash
fly tokens create deploy -x 999999h > /tmp/fly-token
gh secret set FLY_API_TOKEN --repo "$GITHUB_REPO" < /tmp/fly-token
rm /tmp/fly-token

gh variable set FLY_APP_PREFIX --repo "$GITHUB_REPO" --body "$FLY_APP_PREFIX"
```

## 4. Fly apps + first server deploy

```bash
./scripts/bootstrap-fly.sh                        # creates 2 apps + volume

ACTUAL_PASSWORD=$(openssl rand -hex 24)
echo "ACTUAL_PASSWORD=$ACTUAL_PASSWORD" >> .env

fly secrets set --app "$FLY_APP_PREFIX-server" ACTUAL_PASSWORD="$ACTUAL_PASSWORD"
fly deploy --remote-only \
  -c deploy/fly/actual-server/fly.toml \
  --app "$FLY_APP_PREFIX-server"
```

Open `https://$FLY_APP_PREFIX-server.fly.dev`, create your budget + HDFC
account in the UI, then grab the sync id and account id:

```bash
APP_URL="https://$FLY_APP_PREFIX-server.fly.dev"
TOKEN=$(curl -s -X POST "$APP_URL/account/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ACTUAL_PASSWORD\"}" | jq -r .data.token)
ACTUAL_SYNC_ID=$(curl -s "$APP_URL/sync/list-user-files" \
  -H "x-actual-token: $TOKEN" | jq -r '.data[0].groupId')
echo "ACTUAL_SYNC_ID=$ACTUAL_SYNC_ID" >> .env
```

Account id (easiest: via local `actual_api` wrapper after local sync):

```bash
docker compose up -d actual_api
HDFC_SAVINGS_ACCOUNT_ID=$(curl -s http://localhost:5007/accounts \
  | jq -r '.[] | select(.name == "HDFC Savings") | .id')
echo "HDFC_SAVINGS_ACCOUNT_ID=$HDFC_SAVINGS_ACCOUNT_ID" >> .env
```

Update `ingest/banks.yaml`:

```yaml
banks:
  hdfc:
    password_env: HDFC_PDF_PASSWORD
    markers: ["HDFC Bank"]
    accounts:
      - last4: "1234"
        actual_account_id: "${HDFC_SAVINGS_ACCOUNT_ID}"
```

The UUID stays in env — safe to commit this file.

## 5. Fly secrets for ingest

```bash
fly secrets set --app "$FLY_APP_PREFIX-ingest" \
  ACTUAL_SERVER_URL="http://${FLY_APP_PREFIX}-server.internal:5006" \
  ACTUAL_PASSWORD="$ACTUAL_PASSWORD" \
  ACTUAL_SYNC_ID="$ACTUAL_SYNC_ID" \
  HDFC_SAVINGS_ACCOUNT_ID="$HDFC_SAVINGS_ACCOUNT_ID" \
  GEMINI_API_KEY="<from aistudio.google.com/apikey>" \
  HDFC_PDF_PASSWORD="<your HDFC PDF password>" \
  GMAIL_CLIENT_ID="$GMAIL_CLIENT_ID" \
  GMAIL_CLIENT_SECRET="$GMAIL_CLIENT_SECRET" \
  GMAIL_REFRESH_TOKEN="$GMAIL_REFRESH_TOKEN"
```

## 6. Push + first CI deploy

```bash
git remote add origin "git@github.com:$GITHUB_REPO.git"
git push -u origin main
gh run watch --repo "$GITHUB_REPO"
```

## 7. Convert ingest to a scheduled machine (monthly)

```bash
MACHINE_ID=$(fly machines list --app "$FLY_APP_PREFIX-ingest" --json \
  | jq -r '.[0].id')
fly machine update "$MACHINE_ID" --schedule monthly \
  --app "$FLY_APP_PREFIX-ingest"
```

After this: machine starts on the 1st of each month, polls Gmail, exits.
Zero cost between runs. `actual-server` scale-to-zero is baked in and wakes
on first UI request (~5-10s).

## Rotation

| Secret | Rotate via |
|---|---|
| `ACTUAL_PASSWORD` | `fly secrets set` on `-server` and `-ingest`; redeploy |
| `GEMINI_API_KEY` | `fly secrets set` on `-ingest` |
| `HDFC_PDF_PASSWORD` | `fly secrets set` on `-ingest` |
| `GMAIL_REFRESH_TOKEN` | rerun `scripts/get-gmail-refresh-token.sh` + `fly secrets set` |
| `FLY_API_TOKEN` | `fly tokens create` + `gh secret set` |
