# Live Google OAuth e2e demo — provisioned domain

**Issue:** #110 — infra(demo): live Google end-to-end on the provisioned domain

This runbook covers the one-time Google Cloud Console configuration, the
pre-flight infrastructure smoke test, and the manual acceptance walkthrough.

---

## Prerequisites (cross-track joins)

| Dependency | Issue | Status gating |
|---|---|---|
| EC2 + EIP running `docker compose` | #105 | Instance reachable, compose up |
| Route53 A record + Caddy ACME TLS | #104 | `https://<domain>` serves HSTS response |
| Control-plane OIDC callback (#96/#97) | #97 | `/v1/auth/google/callback` returns 401 on bad code |
| Web BFF OIDC relay (#100) | #100 | `/auth/google/callback` route present |
| SSM parameters populated | #104 | `REPLACE_ME` values overwritten with real secrets |

---

## 1. Populate SSM parameters (one-time, out-of-band)

All secrets are SSM SecureStrings.  The Terraform `apply` creates the paths with
placeholder values; **real values must be written before the first `compose up`.**

```bash
DOMAIN=app.example.com        # your real registered domain
ENV=poc                        # or staging / prod
REGION=us-east-1

# Google OAuth credentials — from the Google Cloud Console (see §2 below).
aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/oauth/google/client_id" \
  --type SecureString --value "YOUR_GOOGLE_CLIENT_ID"

aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/oauth/google/client_secret" \
  --type SecureString --value "YOUR_GOOGLE_CLIENT_SECRET"

# Auth / session keys — generate strong random values.
aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/auth/jwt_signing_key" \
  --type SecureString --value "$(openssl rand -base64 48)"

aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/auth/refresh_token_pepper" \
  --type SecureString --value "$(openssl rand -base64 32)"

aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/web/cookie_seal_key" \
  --type SecureString --value "$(openssl rand -base64 32)"

# Backing-store passwords — set to strong random values.
aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/postgres/password" \
  --type SecureString --value "$(openssl rand -base64 32)"

aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/redis/password" \
  --type SecureString --value "$(openssl rand -base64 32)"

aws ssm put-parameter --overwrite --region "$REGION" \
  --name "/logalot/$ENV/rabbitmq/password" \
  --type SecureString --value "$(openssl rand -base64 32)"
```

---

## 2. Register the Google OAuth redirect URI

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Navigate to **APIs & Services → Credentials**.
2. Open (or create) the OAuth 2.0 Client ID for the logalot project.
3. Under **Authorized redirect URIs**, add exactly:

   ```
   https://<LOGALOT_DOMAIN>/auth/google/callback
   ```

   Replace `<LOGALOT_DOMAIN>` with the value of `var.domain_name` in your
   `poc.tfvars`.  The URI must match character-for-character — no trailing slash,
   no port, HTTPS only (R16).

4. Save.  Propagation takes up to a few minutes.

> **Why this exact path?**  The web BFF mounts the callback route at
> `/auth/google/callback` (TanStack Start route `routes/auth/google/callback.tsx`).
> Caddy forwards all non-`/v1/*` traffic to `web:3000`, so the BFF handles the
> callback directly.  The control-plane OIDC callback is called server-side by
> the BFF over the compose network — the browser never reaches the control-plane
> directly.

---

## 3. Provision a test user (invite-only guard)

Google sign-in is **invite-only**: only users whose Google email is in the
`users` table (linked via `oauth_identities`) may authenticate.

Seed a test user after the stack is up:

```bash
# SSH / SSM into the EC2 instance.
cd /home/ec2-user/logalot

# Exec into postgres.
docker compose -f docker-compose.aws.yml exec postgres \
  psql -U logalot_app -d logalot

-- Inside psql:
-- 1. Find or create the tenant.
SELECT id, slug FROM tenants WHERE slug = 'acme';

-- 2. Insert the provisioned user.
INSERT INTO users (id, tenant_id, email, display_name, role)
VALUES (
  gen_random_uuid(),
  '<tenant-uuid>',              -- from step 1
  'yourname@gmail.com',         -- the Google account to provision
  'Your Name',
  'member'
);

-- 3. Link the Google identity (google_sub = the "sub" claim in the Google id_token).
--    Leave google_sub NULL for now; it will be auto-populated on first sign-in
--    by the control-plane account-linking flow (#97).
\q
```

---

## 4. Terraform apply — inject domain into user-data

Ensure `poc.tfvars` (or your env tfvars) has the real values:

```hcl
domain_name = "app.example.com"   # must match the Google Console redirect URI
alert_email = "ops@example.com"   # used for LOGALOT_TLS_EMAIL + budget alerts
```

Apply:

```bash
cd infra/aws
terraform apply -var-file=poc.tfvars
```

The user-data template now injects `LOGALOT_DOMAIN`, `LOGALOT_TLS_EMAIL`, and
`GOOGLE_OIDC_REDIRECT_URI` directly from Terraform variables — no manual `.env`
edit is required after `apply`.

---

## 5. Run the infrastructure smoke test

```bash
LOGALOT_DOMAIN=app.example.com bash scripts/google-auth-smoke.sh
```

All 6 checks must pass before proceeding to the browser walkthrough.

---

## 6. Browser walkthrough (acceptance criteria)

### AC #1 — Provisioned user signs in, gets lg_at / lg_rt

1. Open a fresh private browser window and navigate to
   `https://<LOGALOT_DOMAIN>/login` (or the workspace login page).
2. Click **Sign in with Google**.
3. Complete Google sign-in with the provisioned account (`yourname@gmail.com`).
4. Verify you land on the dashboard/authenticated page.
5. Inspect cookies: `lg_at` and `lg_rt` must be present, `HttpOnly`, `Secure`,
   `SameSite=Lax`.

```
Developer Tools → Application → Cookies → https://<LOGALOT_DOMAIN>
  lg_at   HttpOnly  Secure  SameSite=Lax  ✓
  lg_rt   HttpOnly  Secure  SameSite=Lax  ✓
```

### AC #2 — Unprovisioned Google user is rejected (401 / invite-only)

1. Open a fresh private browser window.
2. Navigate to `https://<LOGALOT_DOMAIN>/login`.
3. Click **Sign in with Google**.
4. Sign in with a Google account that is **not** in the `users` table.
5. Verify the browser returns to the login page with a generic error message
   (no email enumeration — the error must not name the specific account).

### AC #3 — Transport HTTPS-only (R16)

1. Navigate to `http://<LOGALOT_DOMAIN>/` (plain HTTP).
2. Verify the browser is redirected to `https://<LOGALOT_DOMAIN>/` with `301`.
3. Verify `Strict-Transport-Security` header is present in the HTTPS response.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` from Google | URI in Console doesn't match `GOOGLE_OIDC_REDIRECT_URI` | Re-check both values match exactly |
| `401 unauthorized` on sign-in with provisioned account | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` not in control-plane env | Verify SSM params are non-`REPLACE_ME`; check `docker compose logs control-plane` |
| Caddy returns 502 | control-plane or web container not healthy | `docker compose ps` on the EC2 instance |
| Let's Encrypt rate-limit | Too many certificate requests for the domain | Wait 1 h; use staging ACME endpoint for dev |
| `google_sub` not linked after first sign-in | OAuth identity linking failed | Check `docker compose logs control-plane` for `oidc.account_link.*` audit event |
