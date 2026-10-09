# Deploying ORGAMIND on Dokploy

This guide deploys the full ORGAMIND stack (web, api, worker, postgres, redis,
evolution-api) as a single Docker Compose application on a Dokploy server.

## Prerequisites

- A Dokploy server (https://dokploy.com).
- DNS for the public domain (or use Dokploy's auto-generated `*.traefik.me`
  subdomain for staging).
- The `institutoidasam/orgamind-ia` GitHub repository accessible to Dokploy (private
  repo: add a deploy key in Dokploy → Settings → Git Providers).

## 1. Create the Compose application

1. Dokploy UI → **Projects** → **Create Project** (e.g. `orgamind`).
2. Inside the project → **Create Service** → **Compose**.
3. **Source** → Git → paste the repo URL and select branch `main`.
4. **Compose Path**: `docker-compose.prod.yml`
5. Leave **Compose Type** as `Docker Compose` (not Swarm).

## 2. Configure the domain

In the **Domains** tab, click **Add Domain** once — only the `web` service
needs a public domain. The browser hits `web` (nginx), which proxies `/api/*`
to the internal `api` service over Docker DNS.

| Service | Host                       | Path | Port | HTTPS  |
|---------|----------------------------|------|------|--------|
| `web`   | `picoa-web-xyz.traefik.me` | `/`  | `80` | Lets Encrypt |

Dokploy automatically injects the Traefik labels and attaches `web` to
`dokploy-network` at deploy time. `api`, `worker`, `postgres`, `redis`, and
`evolution-api` stay internal — they talk to each other on the default
compose network using service names (`postgres`, `redis`, `api`, etc.).

## 3. Configure environment variables

In the **Environment** tab, paste the contents of
[`.env.prod.example`](./.env.prod.example), filling in:

- `APP_BASE_URL` / `CORS_ORIGIN` — the domain Dokploy generated in step 2
- `JWT_SECRET` — `openssl rand -base64 48`
- `POSTGRES_PASSWORD` — `openssl rand -base64 32`
- `EVOLUTION_API_KEY` — `openssl rand -base64 32`
- `PICOA_CONSENT_SALT` — generate once with `openssl rand -hex 32` and keep
  the same value across `migrate`, `api`, and `worker`. The production compose
  refuses to start if it is unset or empty. Store it with the other deployment
  secrets; replace the `__CHANGE_ME__` template value before the first deploy.
  Changing it after consent records exist requires a hash migration.
- `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` — temporary admin credentials
  (forced to change on first login)
- Leave `WEBHOOK_BASE_URL=http://api:3000` and `EVOLUTION_BASE_URL=http://evolution-api:8080`
  as-is (internal Docker DNS). These are for containers inside this compose only.
- `PUBLIC_WEBHOOK_BASE_URL` — required if you use an **external** provider that
  calls back (GoZap). Set it to `https://<your domain>/api`. It must be reachable
  from the public internet: `http://api:3000` is a compose service name, and a
  third-party SaaS accepts it with 200 and then silently delivers nothing
  (prod incident 2026-08-07). The app refuses to register a non-public webhook
  URL and logs at `error` level.
- `GOZAP_WEBHOOK_TOKEN` — `openssl rand -hex 24`. This is the **only** thing
  protecting `/api/webhooks/gozap` (GoZap does not sign the body). The receiver
  accepts it as a header (`X-Webhook-Token`, preferred) or in the query string
  (`?t=`, kept for compatibility with URLs already stored in the GoZap panel).
  Prefer the header: a query string is written to every proxy access log it
  passes through. After moving the panel to the header, set
  `GOZAP_WEBHOOK_ALLOW_QUERY_TOKEN=false` to close the query path for good —
  full procedure in [OPERATIONS.md](./OPERATIONS.md) → "Webhook do GoZap: tirar
  o segredo da URL".

## 4. First deploy

Click **Deploy**. Dokploy will:

1. Pull the repo.
2. Build the `api`, `worker`, and `web` images.
3. Start `postgres` and `redis`, wait for healthy.
4. Run the one-shot `migrate` service:
   - `npx prisma migrate deploy` applies all migrations.
   - `npx prisma db seed` upserts the admin user.
5. Start `evolution-api`, `api`, `worker`, and `web`.

Watch the deploy log; when it settles, open the domain from step 2.

## 5. First login + pair WhatsApp

1. Login with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` → forced redirect
   to `/change-password`.
2. Set a real admin password.
3. **/connect** → scan the QR with the WhatsApp account that will send
   broadcasts.

## Updating

Push to `main` → click **Deploy** again. The compose file is idempotent:

- New migrations run automatically.
- The seed is an upsert, so the admin user is never duplicated.
- Volumes (`postgres_data`, `redis_data`, `evolution_instances`) persist
  across deploys — your data and the paired WhatsApp session survive.

> ⚠️ **A subida que cria a trava "uma linha viva por (campanha, contato)"
> (migration `20260819010000`) NÃO é um deploy comum.** Ela cria um índice único
> em `Message` e roda, no mesmo job, o reparo que APAGA linha de `Contact`.
> Siga o procedimento passo a passo em
> [OPERATIONS.md → "Subida da trava…"](OPERATIONS.md#subida-da-trava-uma-linha-viva-por-campanha-contato-migration-20260819010000):
> snapshot, sondagem SQL, dry-run do reparo, e verificação **atravessando o
> proxy** depois (`/health` é servido pelo nginx e não prova nada). O rollback
> também está lá — só de código ele PIORA a situação, porque o índice fica.

## Changing the domain later

Because `VITE_API_URL` defaults to the relative path `/api` (no public API
domain baked into the bundle), you can change the public domain without
rebuilding:

1. Update the domain in the Domains tab.
2. Update `APP_BASE_URL` and `CORS_ORIGIN` in the Environment tab.
3. Restart (no rebuild needed).

## Backup checklist

Dokploy can schedule backups for the named volumes:

- `postgres_data` — application data (users, contacts, campaigns)
- `evolution_instances` — Baileys auth state (losing this forces re-pairing)
- `redis_data` — BullMQ queue state (loss only affects in-flight jobs)

## Switching to Meta WhatsApp Cloud API

Fill in all of the `META_*` variables (the whole group must be set together —
see `backend/src/shared/config/env.schema.ts`) and redeploy; the Meta channel
becomes available alongside whatever else is configured. There is no single
provider selector to flip — a deploy can run Evolution and Meta side by side.
If you're dropping Evolution entirely, the `evolution-api` service stays
running but is no longer used; you can comment it out of
`docker-compose.prod.yml` once you've fully migrated (and remove the
`EVOLUTION_*` vars so that group no longer validates as configured).

## Troubleshooting

| Symptom | Check |
|---|---|
| 502 from Traefik on the web domain | `web` not attached to `dokploy-network` — re-deploy; Dokploy re-attaches at deploy time |
| `migrate` exits non-zero | Migrate logs in Dokploy — usually a `DATABASE_URL` typo or unreachable postgres |
| QR code doesn't appear in /connect | `evolution-api` couldn't reach postgres on first boot. Restart the service from Dokploy |
| Login works but UI shows network errors | `CORS_ORIGIN` doesn't match the public domain exactly (scheme + host + port) |
