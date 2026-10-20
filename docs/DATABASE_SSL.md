# CA-verified database connections

The scripts that connect straight to a database (staging tools, production preflight, migration runner) always use TLS. **Verifying** the server's certificate, which proves you're talking to Supabase rather than something in between, needs the project's CA certificate. Without it the connection is encrypted but unverified, and the staging tools print `! STAGING_DB_SSL_CA not set`.

## What the server presents (staging, checked 2026-10-20)

```
*.pooler.supabase.com            (host certificate; matches aws-0-us-east-1.pooler.supabase.com)
  └─ Supabase Intermediate 2021 CA
       └─ Supabase Root 2021 CA   (self-signed root, valid until 2031-04-26)
```

The root is Supabase's own, not a public CA, so Node and `psql` can't verify it unless you give them the CA file. A verified connection was tested on staging, with a negative check: a wrong CA is refused with `SELF_SIGNED_CERT_IN_CHAIN`.

## Get the CA certificate (once per project)

1. Supabase dashboard → the project → **Project Settings → Database → SSL Configuration → Download certificate**. The file is usually named `prod-ca-2021.crt`.
   Supabase also publishes the same CA over HTTPS at `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`.
   **Staging (2026-10-20)** uses that published copy, saved as `certs/supabase-ca-2021.crt`. Its SHA-256 matched the root the staging server presents, so two independent channels agree.
2. For production, download it from the dashboard and confirm the fingerprint matches before relying on it. Never trust *only* the copy the server sends during the handshake: that would verify the server against itself.
3. Optional cross-check: `openssl x509 -in prod-ca-2021.crt -noout -subject -enddate -fingerprint -sha256` should show `CN=Supabase Root 2021 CA`. On staging the server's chain ends in a root with SHA-256 fingerprint `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.

The certificate is public (it isn't a secret), but keep it out of git anyway, so each environment's file is chosen deliberately. `certs/` is the suggested place (add it to `.gitignore` first).

## Staging tools

In `.env.staging.local`:

```
STAGING_DB_SSL_CA=certs/supabase-ca-2021.crt
```

The path is relative to the repository, or absolute. Every staging script (`staging:snapshot`, `staging:migrate`, `staging:test-db`, …) then verifies the server and stops printing the warning. A wrong or missing file stops the script.

## Production preflight

```
PREFLIGHT_DB_URL='postgresql://…' PREFLIGHT_DB_SSL_CA=certs/supabase-prod-ca.crt node scripts/production/preflight.mjs
```

The preflight **refuses to connect** without `PREFLIGHT_DB_SSL_CA`. `PREFLIGHT_ALLOW_UNVERIFIED_TLS=1` overrides that, and the report then says `NOT verified`. Its first line reports `Connection security: encrypted, server certificate verified`.

## psql and other clients

```
psql "postgresql://…@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=certs/supabase-prod-ca.crt"
```

Use `verify-full`, which checks the chain **and** the host name. `require` encrypts but verifies nothing.

## Notes

- **Pooler host vs direct host:** connections through the pooler (`aws-0-<region>.pooler.supabase.com`) match the `*.pooler.supabase.com` certificate. The direct host (`db.<ref>.supabase.co`) is signed by the same CA.
- **`sslmode` in the URL:** the scripts strip any `sslmode=` from the URL so it can't silently override verification.
- **When the CA changes:** Supabase rotates CAs rarely and announces it in advance. If verification starts failing after a rotation, download the new certificate. Don't switch verification off.
