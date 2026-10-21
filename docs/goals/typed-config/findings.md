# Typed configuration: findings

Every row read from the tree at `e7bce746` on 2026-10-21. "Staging source" is where the value comes from on the Civo staging environment after `staging/first`.

## 1. The short answer

- Nothing non-secret is pasted into GitHub. The staging environment holds 14 names: 5 the owner pastes, 4 the Bootstrap workflow generates, 3 Terraform writes, 2 optional (Google). Five of the 14 are identifiers rather than secrets (`MICROSOFT_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `STATE_ACCESS_KEY_ID`, `KUBE_SERVER`, `KUBE_CA`); each is the partner of a secret and travels with it.
- Every other value a pod sees is computed by the chart from three hostnames and two client IDs in the overlay, written by Terraform (the proxy CIDRs, the database administrator login), or generated in the cluster by the ops Jobs (the database logins, the machine clients' secrets).
- The defaults live in four hand-maintained places: the zod schemas (ports, pool size, break-glass, fresh seconds), `.env.example` (29 local values), `default.env` (78 names, enforced against ID's schema only), docs/06's table (18 rows for ID). Only ID's part of `default.env` is tested.

## 2. ID (`apps/id/src/env.ts`, 15 variables; tooling 3)

| Variable | Secret | Default in code | Staging source |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | image: `ENV NODE_ENV=production` |
| `PORT` | no | 47300 | image |
| `DATABASE_URL` | yes (a login) | required | Secret `id-database`, written by the ops `bootstrap` Job |
| `BETTER_AUTH_URL` | no | required | chart, from `hostnames.id` |
| `BETTER_AUTH_SECRET` | yes | required | GitHub environment (Bootstrap generates) → deploy → Secret `id-env` |
| `BETTER_AUTH_SECRETS` | yes | optional | not handed over by the deploy steps (finding F2) |
| `MICROSOFT_CLIENT_ID` / `_SECRET` | ID no, secret yes | optional, together | GitHub environment (pasted) → `id-env` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | ID no, secret yes | optional, together | GitHub environment (optional) → `id-env` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | no | `""`; production requires origins | chart, `id.trustedOrigins` (the six platform-application origins, the same in every deployed environment) |
| `ROOT_ADMIN_SECRET` | yes | optional | GitHub environment (Bootstrap generates) → `id-env` |
| `ROOT_ADMIN_BREAK_GLASS` | no | `false` | default |
| `TRUSTED_PROXY_CIDRS` | no | optional; production requires | ConfigMap `trusted-proxies`, written by Terraform |
| `DATABASE_POOL_MAX` | no | 20 | default |
| `DATABASE_MIGRATION_URL` (tooling) | yes | – | Secret `id-database-owner` → the migration Job |
| `DATABASE_RUNTIME_ROLE`, `TEST_DATABASE_URL` (tooling) | no / local | – | not deployed |

Fixed constants in `env.ts`, not variables: the operational log interval, the protocol sweep, the five database timeouts, the platform organisation's slug and name, the admin resource `${BETTER_AUTH_URL}/api/admin`.

## 3. The Toolbox (`mcps/toolbox/src/environment.ts`, 9; tooling 3)

| Variable | Secret | Default in code | Staging source |
| --- | --- | --- | --- |
| `TOOLBOX_DATABASE_URL` | yes | required | Secret `toolbox-database`, ops `bootstrap` |
| `TOOLBOX_ID_ISSUER` | no | required | chart, `hostnames.id` |
| `TOOLBOX_RESOURCE_URL` | no | required | chart, `hostnames.toolbox` + `/mcp` |
| `TOOLBOX_ID_ADMIN_RESOURCE` | no | required | chart, `hostnames.id` + `/api/admin` |
| `TOOLBOX_HOST` | no | `127.0.0.1` | image: `0.0.0.0` |
| `TOOLBOX_PORT` | no | 47400 | image |
| `TOOLBOX_ID_CLIENT_ID` | no | required | chart, `toolbox.clientId` (`toolbox-hub`) |
| `TOOLBOX_ID_CLIENT_SECRET` | yes | required | Secret `toolbox-id-client`, ops `register` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | unset | unset |
| `TOOLBOX_DATABASE_MIGRATION_URL`, `_RUNTIME_ROLE`, `TOOLBOX_TEST_DATABASE_URL` (tooling) | first yes | – | owner Secret → migration Job; the rest local |

## 4. The admin MCP (`mcps/admin/src/environment.ts`, 10; tooling 3)

Same shape as the Toolbox with the `ADMIN_` prefix, plus `ADMIN_TOOLBOX_ADMIN_RESOURCE` (chart, `hostnames.toolbox` + `/admin`) and `ADMIN_FRESH_SECONDS` (default 1,800 in `createAdminMcp`, unset in staging). Secrets: `ADMIN_DATABASE_URL` (ops `bootstrap`), `ADMIN_ID_CLIENT_SECRET` (ops `register`).

## 5. The ops Jobs (`infra/ops/src/commands.ts`, 14 `OPS_*`)

All set by the chart from the hostnames and the values; no defaults. Secrets among them: `OPS_DATABASE_ADMIN_URL` (Secret `postgres-admin`, Terraform), `OPS_ID_ROOT_SECRET` (`id-env`'s `ROOT_ADMIN_SECRET`), `OPS_ID_TOKEN` (optional Secret `ops-staff-token`, by hand after root locks).

## 6. The GitHub environment (14 names; `infra/README.md`)

| Group | Names | Written by |
| --- | --- | --- |
| Pasted | `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `GH_SECRETS_TOKEN` | the owner, once |
| Generated | `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `ROOT_ADMIN_SECRET` | `bootstrap.yml` |
| Cluster | `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN` | Terraform's github module |
| Optional | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the owner, if Google is wanted |

The deploy step receives `KUBE_*`, `BETTER_AUTH_SECRET`, `ROOT_ADMIN_SECRET`, `MICROSOFT_*`, `GOOGLE_*` (`deploy-staging.yml` lines 184 to 192; the same in `promote-production.yml`). `infra/pipeline/src/deploy.ts` `idEnv()` builds `id-env` from `ID_ENV_REQUIRED` (`BETTER_AUTH_SECRET`, `ROOT_ADMIN_SECRET`), the two pairs, and `ID_ENV_OPTIONAL` (`BETTER_AUTH_SECRETS`).

## 7. Local today (`.env.example`, root)

29 active lines: 28 localhost values (database logins on 47432, `http://localhost:47300` as issuer, the three services' resource URLs, hosts, ports, pool size, fresh seconds) and one secret (`BETTER_AUTH_SECRET`). Credentials that cannot have a default because another system issues them: `MICROSOFT_CLIENT_ID`/`_SECRET` (the owner's Entra app), `GOOGLE_*`, `TOOLBOX_ID_CLIENT_ID`/`_SECRET` and `ADMIN_ID_CLIENT_ID`/`_SECRET` (machine clients the local ID registers), `OAUTH_TEST_*` (the web app's test consumer). `apps/web/.env.local` is separate: the waitlist's Google Sheets service account and `OAUTH_TEST_*`, on Vercel in production.

The kind stack (`infra/k8s/local/stack.ts`) already generates its own `BETTER_AUTH_SECRET` and `ROOT_ADMIN_SECRET` and writes `id-env` itself: the local cluster never reads `.env`.

## 8. Hostnames: where they are written

`infra/civo/envs/staging.tfvars` (zone and three hosts, for DNS and the certificates), `charts/answerable/values-civo-staging.yaml` (`hostnames`, for Ingress, NetworkPolicies and the services' URLs), `infra/pipeline/src/environments.ts` (`ZONES`, for the smoke test), and the expectation in `infra/k8s/charts.test.ts`. The chart tests and the pipeline tests pin the second and third to the first's values.

## 9. Findings

- **F1 Stale tutorial.** Step 6.1 said the bootstrap writes `UPSTREAM_TOKEN_SECRETS`. ID stopped reading it in the v0 code audit (2026-10-20, landed at 6eaba576); `bootstrap.yml` writes four names. Corrected and republished on 2026-10-21. The name survives only in history files under `docs/goals/` and in two stale worktrees under `.claude/worktrees/` (`sleepy-gould-f358d1`, `suspicious-curran-0034ba`, other sessions').
- **F2 Ring rotation cannot run.** `infra/README.md` (Rotate) says `BETTER_AUTH_SECRET` rotates through the ring `BETTER_AUTH_SECRETS`, and `idEnv()` accepts it, but neither deploy workflow passes `BETTER_AUTH_SECRETS` to the deploy step, so a value set in the environment never reaches `id-env`. One line per workflow fixes it (D5).
- **F3 Four copies of the defaults.** The schemas, `.env.example`, `default.env` and docs/06's table each carry a copy; only ID's names in `default.env` are tested (`apps/id/src/env.test.ts`), so the Toolbox's, the admin MCP's and the ops Jobs' 39 names there are by hand, and docs/06 drifted once already (the removed variable).
