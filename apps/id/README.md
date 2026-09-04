# Answerable ID

Identity and authorization service for Answerable. This first milestone contains the runtime skeleton and the schema contract; production migrations and administrative write routes intentionally come later.

## HTTP surface

- Better Auth: `/auth/*` behind an explicit allowlist: `GET /auth/ok`, `POST /auth/sign-in/sso`, `GET /auth/sso/callback`, `GET /auth/get-session`, and `POST /auth/sign-out`. Every SSO administration/SAML route and every OAuth-provider route remains unreachable until a later milestone. The provider's admin endpoints also require a session and privilege hooks that deny by default; client administration is designed with the admin API
- Public OpenAPI contract: `/openapi.json` — the reachable routes only; regenerate the committed snapshot with `bun run openapi:export`
- Admin OpenAPI: `/api/admin/openapi.json`
- Admin docs: `/api/admin/docs` in development and test only
- Liveness: `/healthz` (no database query)
- Readiness: `/readyz` (one `select 1`)

Production uses `https://id.answerable.org` as `BETTER_AUTH_URL`; Better Auth's separate `basePath` is `/auth`. Local development keeps `BETTER_AUTH_URL=http://localhost:47300`.

`src/env.ts` validates `Bun.env` once during startup and returns a typed configuration object. `DATABASE_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET` are required and produce a named startup error when absent. `BETTER_AUTH_TRUSTED_ORIGINS` is a comma-separated browser/IdP origin allowlist (defaults to `AUTH_PAGES_URL` when unset), and `AUTH_PAGES_URL` is the absolute login/consent-page origin (default `http://localhost:47100`). Runtime settings such as `PORT` and pool limits declare their defaults in the same schema; see [`.env.example`](../../.env.example).

## Commands

From the repository root:

```bash
bun install
docker compose up -d --wait postgres
bun --filter @answerable/id db:test:push
bun --filter @answerable/id typecheck
bun --filter @answerable/id lint
bun --filter @answerable/id build
bun --filter @answerable/id test
```

`db:test:push` recreates the `public` schema and then uses `drizzle-kit push --force`. Both safety gates refuse any database whose name is not exactly `answerable_id_test`; data in that explicitly disposable database is not recoverable after a run. There is deliberately no migration directory.

Coverage thresholds require 100% of application lines and functions. Tests, fixtures, generated output, and the composition-only `src/server.ts` process entry are excluded; its runtime behavior lives in the fully tested `src/runtime.ts`.

## Boundaries

`src/db/client.ts` owns the one process-wide pool and Drizzle construction. Database operations live in `src/db/queries`, grouped by domain. Vocabularies live once in `src/db/schema/vocabulary.ts`, and `src/db/schema/columns.ts` carries the identifier, timestamp, and CHECK conventions. The integration test freezes the PostgreSQL catalog, so a schema change is a deliberate edit to that snapshot. HTTP routes receive `db`, `auth`, and request metadata through typed Hono context. Future administrative routes call services, and services call these query modules—routes never contain Drizzle or SQL.

The default pool maximum is five connections per process and one in tests. Timeouts and the maximum are configurable through the environment. Session resolution remains route-scoped; liveness and public metadata do not resolve a session.

See [`../../docs/04-answerable-id-schema.md`](../../docs/04-answerable-id-schema.md) for the schema contract.
