# Contributing to ORGAMIND

## Architecture

ORGAMIND is a NestJS modular monolith. Read these first:

- `docs/superpowers/specs/2026-04-29-whatsapp-broadcast-design.md` — design spec
- `docs/superpowers/plans/2026-04-29-picoa-implementation.md` — phase-by-phase implementation history
- `docs/superpowers/plans/2026-04-30-picoa-improvements.md` — improvement backlog

## Backend rules (non-negotiable)

1. **Domain code under `src/modules/<domain>/`**, infra under `src/shared/`.
2. **Each module has**: `<domain>.module.ts`, `<domain>.controller.ts`, `<domain>.service.ts`, `<domain>.repository.ts`, `dto/`, `errors/`.
3. **Repositories are thin and domain-meaningful** (e.g. `findByPhoneE164`), not generic (`find(query)`).
4. **Services throw `DomainError`**, never `HttpException`. The `DomainExceptionFilter` translates to RFC 9457 problem+json.
5. **No `class-validator`** — only Zod via `nestjs-zod` `createZodDto`.
6. **No `@nestjs/cqrs`, no UseCase classes, no three-layer mapping.**
7. **No `forwardRef`.** If you need it, the modeling is wrong.

## Frontend rules

1. **Feature-first**: `src/features/<domain>/api.ts` co-locates queries+mutations.
2. **No global `hooks/queries/` or `hooks/mutations/`.**
3. **HTTP via `ky`**, not axios.
4. **JWT in Zustand memory only** — never `localStorage`.
5. **Routes**: protected pages under `src/routes/_authenticated/`.

## Adding a new module

1. Create folder `backend/src/modules/<your-domain>/`.
2. Add Prisma model in `backend/prisma/schema.prisma`. Migrate with `bun run prisma migrate dev --name add_<domain>`.
3. Create `<domain>.repository.ts` (thin Prisma wrapper, domain-meaningful methods).
4. Create `<domain>.service.ts` injecting the repository. Throw `DomainError` subclasses from `errors/<domain>.errors.ts`.
5. Create Zod contracts in `backend/src/schemas/contracts/<domain>.schema.ts` for request/response shapes.
6. Create DTOs in `<domain>/dto/` via `createZodDto(yourSchema)`.
7. Create `<domain>.controller.ts` with `@Controller('your-resource')` and standard methods. Add `@ApiTags(...)` and `@ApiOperation({ summary })` for OpenAPI/Scalar.
8. Create `<domain>.module.ts` registering controller, service, repository.
9. Wire into `backend/src/app.module.ts` imports.
10. Tests: at minimum `<domain>.service.spec.ts` covering happy path + error throws.
11. Frontend: regenerate the OpenAPI client (`cd frontend && bun run codegen`) so types are in sync.

## Tests

- **Vitest** is the runner. `bun run test` (backend) / `bun run test` (frontend).
- **Unit tests**: mock repositories with `vitest-mock-extended`.
- **Integration tests**: opt-in with `TESTCONTAINERS_ENABLED=1` (Postgres + Redis from Docker).
- **E2E**: Playwright. `cd frontend && bun run e2e:fixtures && bun run test:e2e`.

## Commits

- Conventional Commits style: `feat(scope): description`, `fix(scope): description`, `chore(scope): description`.
- Reference improvement plan items: `feat(backend): #N add foo`.
- Use **path-restricted git add** (`git add specific/file.ts`) — never `git add -A` (concurrent agents share the repo).

## Code review

- For non-trivial changes, run the project's `code-reviewer` agent before merge (see `code-review/code-review` skill).
- The CI pipeline runs: backend tests, frontend build, type check, migration drift check, dep audit (non-blocking), Playwright E2E.
