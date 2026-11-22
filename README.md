# ORGAMIND

WhatsApp broadcast system that imports Excel contacts, filters them, and dispatches messages through the Evolution API with live delivery status tracking.

## Features

- Excel upload (`.xlsx`) with phone E.164 normalization and dedupe by phone
- Filter contacts by AND/OR nested rules (city, group, tags, etc.)
- Campaign wizard: pick template, map variables, filter recipients, preview, send
- Live campaign monitor with delivery status (sent/delivered/read/failed)
- Adapter pattern: only the Evolution API is on (Meta Cloud API, Twilio, Zernio and GoZap: see [WhatsApp providers](#whatsapp-providers))
- Worker as separate process (BullMQ + Redis) with deterministic job IDs
- Webhook receiver with HMAC verification + Redis-based dedupe

## Architecture

- **Backend**: NestJS (Node 22 + Bun pkg manager) modular monolith — `src/modules/<domain>/` + `src/shared/<infra>/`. DomainError hierarchy mapped to RFC 9457 problem+json. Prisma + PostgreSQL.
- **Worker**: separate Node process via `NestFactory.createApplicationContext(WorkerModule)`, same Docker image, different bootstrap.
- **Frontend**: React 19 + Vite + Bun + TanStack Router/Query/Table + shadcn/ui + ky + Zustand (memory token only) + Zod + RHF. Feature-first under `src/features/<domain>/`.
- **Hexagonal** in `whatsapp-providers/` (Evolution adapter behind the `MessageProvider` port; the Meta, Twilio, Zernio and GoZap adapters stay in the repository, inactive).
- **Event-driven** via BullMQ for sends + `@nestjs/event-emitter` for cross-module events when needed.

See `docs/superpowers/specs/2026-04-29-whatsapp-broadcast-design.md` for full design.
See `docs/superpowers/plans/2026-04-29-picoa-implementation.md` for implementation history.

## Quick start (dev, with hot-reload)

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml exec api bun run prisma migrate deploy
docker compose -f docker-compose.dev.yml exec api bun run prisma db seed
```

- API: http://localhost:3000
- Web: http://localhost:5173 — login `admin@picoa.local` / `changeme123`
- Postgres: localhost:5432
- Redis: localhost:6379
- Evolution API (optional): `docker compose -f docker-compose.dev.yml --profile evolution up -d`

## Production

```bash
cp .env.example .env  # fill in Evolution credentials, JWT_SECRET, etc.
docker compose up -d --build
docker compose exec api bun run prisma migrate deploy
docker compose exec api bun run prisma db seed
```

Caddy fronts the stack on `:80` and `:443`, terminating TLS and proxying `/api/*` and `/webhooks/*` to the API and everything else to the web (nginx) container. API, worker, and web are private (no host ports).

## Production with TLS

1. Point DNS A record to your VPS IP.
2. Set `DOMAIN` and `ACME_EMAIL` in `.env`.
3. Open ports 80 and 443 on the VPS firewall.
4. `docker compose up -d --build`. Caddy will obtain a Let's Encrypt cert automatically.

For local-only / no-TLS dev, omit `DOMAIN` and Caddy will serve on `:80` only.

## Backups

Postgres is backed up daily by the `backup` service. Backups live in the `pg_backups` Docker volume with tiered retention (7 daily / 4 weekly / 6 monthly).

### Inspect backups

```bash
docker compose run --rm backup ls -la /backups/daily
```

### Restore from backup

```bash
# Stop api+worker so no writes during restore
docker compose stop api worker

# List available backups
docker compose run --rm backup ls /backups/daily

# Restore (replace FILE with the desired backup file)
docker compose exec -T postgres pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists < /backups/daily/FILE

# Restart services
docker compose start api worker
```

### Off-host backup (recommended)

For disaster recovery, copy the `pg_backups` volume off-host nightly. Options:
- **rclone** to S3/B2/Backblaze (`rclone sync /var/lib/docker/volumes/picoa_pg_backups/_data remote:bucket/picoa/`)
- **restic** with encryption + dedup (`restic backup /var/lib/docker/volumes/picoa_pg_backups/_data`)
- **borg** equivalent

Off-host setup is left to the operator (varies by infra).

## Chatbot (Dify)

ORGAMIND supports auto-reply via [Dify](https://dify.ai) chatbot apps. Each WhatsApp number can have its own bot; the bot pauses automatically when an operator takes over the conversation.

### How it works

- Dify runs as a **separate application** on the same Dokploy instance, served at `https://bot.picoa.app.br`. The `OPENAI_API_KEY` (and any other model-provider credentials) are configured **inside Dify** (Settings → Model Provider), not in orgamind's `.env`.
- orgamind's backend calls Dify's API to generate a reply for each incoming message, then forwards that reply via the WhatsApp provider.
- Requires an **Evolution-provider channel**. Evolution is the only provider on, so bots work with every connected number (checked per-channel, not by a deploy-wide setting).

### Setup

**1. Deploy Dify on Dokploy**

Create the Dify app in Dokploy. Point `bot.picoa.app.br` (or any domain you choose) at it. Inside Dify, configure your model provider (Settings → Model Provider → add OpenAI or whichever backend you want) and create one chatbot app per use-case.

**2. Configure orgamind's `.env`**

```env
DIFY_BASE_URL=https://bot.picoa.app.br/v1   # must include /v1
```

`DIFY_BASE_URL` is passed to both the `api` and `worker` containers.

**3. Register bots in ORGAMIND**

Navigate to **/bots** (admin sidebar). Click **Novo bot**, give it a name, and paste the **app API key** from Dify (open the app in Dify → API Access → copy the key).

**4. Assign a bot to a WhatsApp number**

Go to **Conectar**, open the settings drawer for an instance ("⚙" icon), and pick the desired bot in the **"Bot que responde neste número"** field. Save. The number will now auto-reply to incoming messages using that bot.

### Auto-handoff

The bot **pauses automatically** for a conversation when:
- an operator sends a manual reply in the inbox, or
- the conversation is assigned to an agent.

To re-enable auto-reply for that conversation, click **Reativar bot** inside the inbox thread.

## Configuration

See `.env.example` for the full list. Required for production:

| Variable | Notes |
|---|---|
| `JWT_SECRET` | Generate with `openssl rand -hex 32`. Min 32 chars. |
| `EVOLUTION_BASE_URL` | Part of the Evolution provider group — see below. |
| `EVOLUTION_API_KEY` | Part of the Evolution provider group. |
| `EVOLUTION_INSTANCE_NAME` | Part of the Evolution provider group. |
| `DIFY_BASE_URL` | Required for chatbot auto-reply. Base URL of your Dify instance including `/v1` (e.g. `https://bot.picoa.app.br/v1`). |

**Provider group**: only the Evolution group (`EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME`) is required, and the app fails to boot without it. Env keys of the switched-off providers are ignored with a warning that lists names only, never values. See `backend/src/shared/config/env.schema.ts`. The Evolution image is pinned by digest in the compose files; to change the version, see `OPERATIONS.md` → "Evolution: versão fixa e troca de versão".

## WhatsApp providers

Only the Evolution API is on (`ENABLED_CHANNEL_PROVIDERS`). The other providers were switched off and their code stays in the repository, inactive.

### Meta Cloud API

Desligado em 2026-11; código inativo no repositório.

### Twilio

Desligado em 2026-11; código inativo no repositório.

### Zernio

Desligado em 2026-11; código inativo no repositório.

### GoZap

Desligado em 2026-11; código inativo no repositório.


## Authentication

- **Access token**: short-lived (15 min default), kept only in browser memory (Zustand). Sent as `Authorization: Bearer <token>`.
- **Refresh token**: 7-day TTL, stored in an `httpOnly` `Secure` cookie scoped to `/auth` (`SameSite=Strict` in prod, `Lax` in dev for cross-origin localhost). Never visible to JS.
- **Rotation**: each `POST /auth/refresh` issues a new refresh token and overwrites the family record in Redis (`auth:refresh-family:<fid>`).
- **Reuse detection**: presenting an old refresh token after rotation invalidates the entire family and forces re-login. Logged as `auth.refresh_reuse_detected` in the audit log.
- **Silent restore**: on app load, the SPA POSTs to `/auth/refresh` once; if the cookie is valid, the session is recovered without bouncing to `/login`.
- **401 retry**: the API client attempts a single silent refresh + retry on `401` responses; if refresh fails the user is logged out.

Endpoints:

- `POST /auth/login` — issues an access token and sets the refresh cookie.
- `POST /auth/refresh` — rotates the refresh cookie and returns a new access token.
- `POST /auth/logout` — revokes the family in Redis and clears the cookie.

## API Documentation

Interactive Scalar UI and a raw OpenAPI 3 spec are exposed by the backend:

- **Scalar UI** (browse + try out endpoints): http://localhost:3000/docs
- **OpenAPI JSON spec**: http://localhost:3000/docs-json

### Generating frontend types

The frontend ships generated typed clients under `frontend/src/api/generated/` (committed). To regenerate after backend changes:

```bash
cd backend && bun run start:dev   # backend must be running
cd frontend && bun run codegen
```

Codegen is driven by `frontend/openapi-ts.config.ts` (uses `@hey-api/openapi-ts`).

## Error tracking (Sentry)

Sentry is opt-in. Set `SENTRY_DSN` (backend, also picked up by the worker) and `VITE_SENTRY_DSN` (frontend) to enable. Without these, the SDKs do not initialise and capture calls become no-ops.

`DomainError` subclasses (`NotFoundError`, `ValidationError`, `ConflictError`, `WhatsappSendError`, etc.) are **not** sent to Sentry — they are expected business outcomes already returned to the client as RFC 9457 problem+json, not unhandled bugs.

Events are tagged with `traceId` (the `X-Request-Id` correlation ID) so you can pivot from a Sentry issue to the matching log lines in the API, worker, and browser.

For source maps and release tracking, set `GIT_SHA` (backend) and `VITE_GIT_SHA` (frontend) at build time:

```bash
GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build
```

## Webhooks

The Evolution API posts its events to `POST /webhooks/whatsapp` (internal Docker network, `WEBHOOK_BASE_URL`). The worker checks every 10 min that the webhook is armed on each Evolution instance and re-arms it when it diverges (details in `OPERATIONS.md`).

The Meta, Twilio, Zernio and GoZap webhooks: Desligado em 2026-11; código inativo no repositório.

## Development workflow

| Task | Command |
|---|---|
| Backend dev (hot-reload) | `cd backend && bun run start:dev` |
| Worker dev | `cd backend && bun run worker:dev` |
| Backend tests | `cd backend && bun run test` |
| Backend build | `cd backend && bun run build` |
| Frontend dev | `cd frontend && bun run dev` |
| Frontend build | `cd frontend && bun run build` |
| Frontend type check | `cd frontend && bunx tsc --noEmit` |
| E2E tests (requires running stack) | `cd frontend && bun run e2e:fixtures && bun run test:e2e` |
| Prisma migration | `cd backend && bun run prisma migrate dev --name <name>` |
| Prisma seed | `cd backend && bun run prisma db seed` |

## Folder structure

```
orgamind-ia/
├── backend/
│   ├── prisma/                       # Schema + migrations + seed
│   └── src/
│       ├── modules/                  # Domain modules (one per bounded context)
│       │   ├── auth/
│       │   ├── contacts/
│       │   ├── excel-import/
│       │   ├── whatsapp-providers/   # Hexagonal: ports/ + adapters/
│       │   ├── templates/
│       │   ├── campaigns/
│       │   ├── queue/
│       │   └── webhooks/
│       ├── shared/                   # Cross-cutting infrastructure
│       │   ├── config/
│       │   ├── prisma/
│       │   ├── errors/               # DomainError + DomainExceptionFilter (RFC 9457)
│       │   ├── zod/
│       │   ├── correlation/
│       │   └── health/
│       ├── schemas/contracts/        # Zod schemas (synced to frontend)
│       ├── main.ts                   # API HTTP entry
│       ├── worker.ts                 # BullMQ worker entry
│       ├── app.module.ts
│       └── worker.module.ts
└── frontend/
    └── src/
        ├── routes/                   # TanStack Router file-based
        │   ├── login.tsx
        │   └── _authenticated/       # Protected layout + pages
        ├── features/                 # Feature-first organization
        │   ├── auth/
        │   ├── contacts/
        │   ├── imports/
        │   ├── templates/
        │   └── campaigns/
        ├── components/ui/            # shadcn (CLI-generated)
        ├── lib/                      # api-client (ky), query-client, utils
        └── stores/                   # Zustand (auth memory + ephemeral UI)
```

## Tech stack

- **Backend**: NestJS, Node 22 LTS, Bun (pkg manager), Prisma, PostgreSQL, Redis, BullMQ, Pino, Zod (via `nestjs-zod`), Vitest, MSW, Testcontainers, argon2id, JWT.
- **Frontend**: React 19, Vite, Bun (runtime), TanStack Router/Query/Table, ky, Zustand, Zod, react-hook-form, shadcn/ui, Tailwind 4, Playwright.
- **Infra**: Docker Compose (dev + prod), GitHub Actions CI.

## Status

| Phase | Status |
|---|---|
| A — Repo + Docker scaffolding | Done |
| B — Backend foundation | Done |
| C — Auth (User + JWT + login) | Done |
| D — Frontend foundation | Done |
| E — Contacts + Excel import | Done |
| F — WhatsApp providers (Meta + Evolution; only Evolution on since 2026-11) | Done |
| G — Templates + Campaigns + filters | Done |
| H — BullMQ worker + Webhooks | Done |
| I — Frontend complete | Done |
| J — E2E + CI | Done |

66 backend tests passing. Frontend builds clean.

## Future enhancements (post-MVP)

- OpenTelemetry auto-instrumentation
- Multi-tenancy (shared schema + Postgres RLS + Prisma extension)

## License

UNLICENSED — internal use only.
