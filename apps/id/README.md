# Answerable ID

Identity and authorization service for Answerable. This first milestone contains the runtime skeleton and the schema contract; production migrations and administrative write routes intentionally come later.

## HTTP surface

- Better Auth: `/auth/*` (explicit allowlist; currently only `/auth/ok`). The organization, JWT, and OAuth provider plugins are registered, so OAuth 2.1, OIDC discovery, and JWKS routes exist under `/auth` but stay unreachable until allowlisted. The provider's admin endpoints also require a session and privilege hooks that deny by default; client administration is designed with the admin API
- Admin OpenAPI: `/api/admin/openapi.json`
- Admin docs: `/api/admin/docs` in development and test only
- Liveness: `/healthz` (no database query)
- Readiness: `/readyz` (one `select 1`)

Production uses `https://id.answerable.org` as `BETTER_AUTH_URL`; Better Auth's separate `basePath` is `/auth`. Local development keeps `BETTER_AUTH_URL=http://localhost:47300`.

`src/env.ts` validates `Bun.env` once during startup and returns a typed configuration object. `DATABASE_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET` are required and produce a named startup error when absent. Runtime settings such as `PORT` and pool limits declare their defaults in the same schema; see [`.env.example`](../../.env.example).

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
