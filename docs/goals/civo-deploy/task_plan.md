# Task plan: deploying Answerable on Civo

Order, not time. Every brief starts with its failing tests, leaves its docs complete, ends with the cleanup pass, and is reviewed against [`decisions.md`](decisions.md), [`findings.md`](findings.md) and this plan before it lands on `main`. The log is [`progress.md`](progress.md); the decisions as they were taken, including the designs they replaced, are in [`decisions.md`](decisions.md).

**Status: built and on `main` since 14 October 2026 (8da8302), CI green. Next: B7a, the first staging deployment on the owner's Civo account, following [`staging-tutorial.html`](staging-tutorial.html) and [`infra/README.md`](../../../infra/README.md).** The owner confirmed `id.answerable.org` as production and the separate `answerable-staging.uk` zone for staging ([D12](decisions.md)), asked for Cloudflare to stay in front ([D18](decisions.md), [D19](decisions.md)), chose **Civo for both environments, each in its own Civo account** ([D28](decisions.md)), PostgreSQL 17 ([D26](decisions.md)), and OpenBao right after staging is up ([D29](decisions.md)). The owner's instruction (8 October 2026): deploy Answerable ID, the Toolbox and the admin MCP in the UK as code, with Postgres where needed, outstanding security, everything in containers, the web app staying on Vercel, one push to update, horizontal scaling when needed, Kubernetes allowed, low cost, staging first with production one click away, documented, and tested locally where possible, cutting no corners.

## What done looks like

1. A push to `main` builds the images, migrates and deploys **staging** at `id.answerable-staging.uk`, `toolbox.answerable-staging.uk` and `admin-mcp.answerable-staging.uk`, and a smoke test proves them through Cloudflare.
2. One click (a reviewed `workflow_dispatch`) stands up or updates **production** at `id.answerable.org`, `toolbox.answerable.org` and `admin-mcp.answerable.org` with the exact image digest staging runs.
3. Every Civo and Cloudflare resource is Terraform in `infra/civo`, one root per environment; staging applies from GitHub Actions on every push to `main`.
4. The images, the migrations, the database bootstrap and the registration of the MCPs in ID are proved locally by `bun run infra:test` on a production-shaped kind cluster, and in CI on every push.
5. The security model holds: one Civo account per environment, a private network with firewalls, Cloudflare as the only path, restricted database roles for all three services, verified TLS to Postgres, secrets in OpenBao with per-service identities and a read audit once B7b lands (encrypted in the repository until then), and backups proved by a restore.
6. `docs/12-deployment.md` says what runs where and why, `infra/README.md` says how to deploy, promote, roll back, rotate, restore and scale, and `docs/02-plan.md`'s register reflects what this goal resolved.

Out of scope: moving the web app off Vercel, a second region, closing the ID release gate (E1 to E8 in `../../../reports/answerable-id-release-decision-plan.md`), Redis, email, KMS-backed token signing. Each is named Not yet in the docs ([D15](decisions.md)).

## The owner's requirements, decided

| Requirement | Decision |
| --- | --- |
| Deploy as code | Terraform, hand-written and pinned, one root per environment under `infra/civo`, plus two Helm charts ([D3](decisions.md), [D21](decisions.md)) |
| Civo, staying portable | Civo runs both environments in two Civo accounts; the images, the charts, the secrets scheme and the pipeline do not depend on Civo, so another cloud would need only its own Terraform root ([D20](decisions.md) to [D28](decisions.md)) |
| Postgres where needed | One Civo Database PostgreSQL 17 per environment with three databases, separate owner and runtime logins ([D4](decisions.md), [D5](decisions.md), [D26](decisions.md)) |
| Outstanding security | Account per environment, private network and firewalls, Cloudflare-only admission with origin pulls verified by Traefik, verified TLS, least-privilege database roles, a namespace-scoped deploy identity, OpenBao with per-service identities and a read audit after staging is up ([D5](decisions.md), [D18](decisions.md), [D22](decisions.md), [D25](decisions.md), [D29](decisions.md)) |
| UK region | Civo `LON1` (London) only |
| Docker for the admin MCP, the Toolbox and ID | Images from the monorepo, multi-architecture, non-root, read-only, signed, deployed by digest ([D9](decisions.md)) |
| Web stays on Vercel | Untouched; production's records sit beside Vercel's in the `answerable.org` zone, staging has its own zone `answerable-staging.uk` ([D12](decisions.md)) |
| Cloudflare stays in front | Proxied records, Full (strict), Authenticated Origin Pulls verified by Traefik, Cloudflare's ranges as the only admitted source and as ID's trusted proxies, challenges off for the API hostnames, one zone and one token per environment ([D18](decisions.md), [D19](decisions.md), [D31](decisions.md)) |
| One push updates everything | `main` → images → staging, with migrations first ([D8](decisions.md), [D10](decisions.md), [D11](decisions.md)) |
| Horizontal scaling when needed | HorizontalPodAutoscalers; two replicas per service at least, spread across nodes ([D21](decisions.md)) |
| Kubernetes allowed | Used: one compute layer for every service, with scaling, rollouts and network policy built in, and it keeps the deployment portable ([D20](decisions.md)) |
| Low cost | About $103 a month for staging; about $170 for production with one database node, $340 with three ([`docs/12`](../../12-deployment.md#cost)); production costs nothing until its first apply |
| Staging first, production one click | `promote-production` behind a reviewed GitHub environment ([D8](decisions.md), [D16](decisions.md)) |
| Documented and tested locally | `docs/12`, `infra/README.md`, `bun run infra:test` on the kind cluster, `bun run infra:check` on the charts, Terraform and workflows ([D13](decisions.md)) |

## Topology, per environment

```
Browsers, MCP hosts, machine clients
        │ HTTPS
        ▼
Cloudflare (proxied records, Full strict, no challenges on API hosts)
        │ HTTPS + origin-pull client certificate          GitHub Actions
        ▼                                                         │ build → GHCR · helm upgrade
┌─ one Civo account per environment, LON1 ──────────────────────────────────▼───────┐
│  Civo load balancer: 443 from Cloudflare's ranges only (firewall)                  │
│        │                                                                           │
│  Civo Kubernetes · namespace answerable                                            │
│     Traefik: TLS (cert-manager), origin-pull verify, trusted proxies               │
│        │                                                                           │
│     id (×n) · toolbox (×n) · admin-mcp (×n) · Jobs: migrate, bootstrap, register   │
│     Secrets: sops-encrypted in git, applied by the deploy · Grafana agent          │
│        │ TLS verify-full, runtime logins, private network                          │
│  Civo Database PostgreSQL 17, backups                                              │
│  Terraform state in Civo's object store                                            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

The Toolbox and the admin MCP reach ID at its public issuer through Cloudflare, so that one URL is the issuer everywhere ([findings](findings.md#what-has-to-run)). `TRUSTED_PROXY_CIDRS` is Cloudflare's published ranges plus the private network and the cluster's pod range, because the load balancer and Traefik are hops ([D22](decisions.md)).

## Briefs

| Brief | Executor ([D17](decisions.md)) | Depends on | What lands | Proof |
| --- | --- | --- | --- | --- |
| [B0](briefs/b0.md) Account foundation | Owner with an agent | — | The Civo accounts per environment, the `age` key pair per environment and `.sops.yaml`, the Cloudflare tokens | The first apply authenticates to each account |
| [B1](briefs/b1.md) Least-privilege database roles for the MCP servers | Codex, Fable reviews | — | `@answerable/mcp-postgres` provisions and asserts a runtime role; the Toolbox and admin MCP migrate with an owner URL and run as a restricted login; PostgreSQL 17 in compose and CI | `bun run mcp:test`, `bun run mcp:test:e2e` on 17; an owner login is refused at start |
| [B2](briefs/b2.md) Containers and the local cluster | Codex, Fable reviews | B1 | The Dockerfiles, `.dockerignore`, bind-host variables, verified TLS to Postgres; the kind stack (`infra/k8s/local`) installing the charts with a TLS-only PostgreSQL 17 | `bun run infra:test` green locally and in CI |
| [B3](briefs/b3.md) The ops image: database bootstrap and registration | Codex, Fable reviews | B2 | `infra/ops`: idempotent `bootstrap` and `register`, run as Helm Jobs; the kind test covers the admin MCP, a machine-token round trip and a staff sign-in through the cluster | `bun run infra:test`; `infra/ops` at 100% coverage |
| [B4a](briefs/b4.md) The charts | Codex, Fable reviews | B3 | `charts/answerable` and `charts/platform` (Traefik, cert-manager, the Grafana agent) with values per environment; `infra:check` for Helm, Terraform and workflows | `infra:check` and `infra:test` green |
| [B4b](briefs/b4.md) The Civo roots | Codex, Fable reviews | B0, B4a | `infra/civo/envs/staging` and `envs/production`: network, firewalls, cluster, database, object-store state, the platform chart, the deployer, the Cloudflare zone | `terraform test` with mocked providers; the first apply in B7a |
| [B5](briefs/b5.md) Pipeline: push to deploy, one click to production | Codex, Fable reviews | B4a, B4b | Signed images on GHCR; `deploy-staging` on `main` and `promote-production` on dispatch, both `helm upgrade` after the migration Jobs; `infra` plan and apply; `ops` dispatch for `register`; smoke test | Exercised in B7a |
| [B6](briefs/b6.md) Documentation and gates | Codex, Fable reviews | B1–B5 | `docs/12-deployment.md`, the `infra/README.md` runbook, updates to `docs/01`, `docs/02`, `docs/06`, `README.md`, `AGENTS.md`, `default.env`, `knip.json`, `turbo.json` | `bun --filter web test` (links), `bunx knip` |
| [B7a](briefs/b7.md) First staging deployment | Owner with an agent | B0–B6 on `main` | Staging live end to end: first run, Claude Code against the staging admin MCP, preflight, the database restore drill, measured numbers, the evidence report | The evidence report |
| [B7b](briefs/b7b.md) OpenBao, the secret store | Codex for the code, the owner for the ceremony, Fable reviews | B7a, B4a, B5 | OpenBao in the platform chart with the static seal chained to the `sops` file, Kubernetes auth, policies per service, External Secrets in front of it, nightly snapshots, the runbook; staging migrated and the `sops` file reduced to the seal key ([D29](decisions.md)) | `infra:test` with OpenBao in the loop; staging on OpenBao; a rehearsed restore |
| [B7c](briefs/b7c.md) The production rehearsal | Owner with an agent | B7a, B7b | Production stood up by one click with OpenBao from its first minute, smoke-tested, both restores drilled, then destroyed again or kept; the evidence report's production section | The evidence report |
| [B8](briefs/b8.md) Cleanup and conclusions | Fable | B7c | Dead code and docs drift removed, `conclusions.md`, the plan's do-not-re-propose entries, memory | Every gate green on `main` |

Order: **B0 ∥ (B1 → B2 → B3 → B4a) → B4b → B5 → B6 → B7a → B7b → B7c → B8.** B1 to B6 are done; B7a is the owner's first run.

## What the goal adds to the repository

```
apps/id/Dockerfile · mcps/toolbox/Dockerfile · mcps/admin/Dockerfile · infra/ops/Dockerfile · .dockerignore
charts/
  answerable/    ID, the Toolbox, the admin MCP: Deployments, HPA, PDB, NetworkPolicy, Ingress, the migrate and ops Jobs; values per environment
  platform/      Traefik, cert-manager, the Grafana agent, pinned as dependencies; from B7b OpenBao and External Secrets
.sops.yaml       the age recipients per environment; infra/civo/envs/<env>/secrets.enc.yaml holds the encrypted human secrets
infra/
  README.md      the runbook
  civo/          modules/* · envs/staging · envs/production · terraform.sh (Terraform with the state bucket's credential)
  k8s/           the kind stack and the chart tests                         (@answerable/infra-k8s)
  ops/           bootstrap and register                                     (@answerable/infra-ops)
  pipeline/      the scripts the deploy workflows call, and the smoke test  (@answerable/infra-pipeline)
  setup/         bun run setup: the first run of an environment             (@answerable/infra-setup)
.github/workflows/  deploy-staging.yml · promote-production.yml · infra.yml · ops.yml  (ci.yml gains infra:check and infra:test)
docs/12-deployment.md · reports/staging-evidence.md (B7a)
```

Root scripts: `bun run infra:check` (Helm lint, Terraform and workflow linting, no cloud access) and `bun run infra:test` (the kind stack; Docker). Both run in CI.

## Owner inputs the briefs need

- B7a: what [`staging-tutorial.html`](staging-tutorial.html) lists: the Civo account `answerable-staging` and its API key, the two Cloudflare tokens for `answerable-staging.uk`, Bot Fight Mode off, the Entra app's staging redirect URIs and client secret, the `age` key's backup, the first sign-in.
- B7b: the OpenBao initialisation ceremony on a trusted machine, and a safe place for the recovery shares and root token, separate per environment ([D29](decisions.md)).
- B7c: the Civo account `answerable-production` and its tokens for `answerable.org`, production's Entra redirect URIs, a path from GitHub to production's Kubernetes API ([D30](decisions.md)), and the go for the rehearsal (about $10 for a day, then destroyed) or for keeping production up (about $170 to $340 a month).

## After the goal

- Close E5, E6 and E7 of the release gate with the staging evidence and a production load test through the real edge.
- Scheduled scale-to-zero for staging outside working hours, and alerts in Grafana Cloud: each when a measurement says it pays.
