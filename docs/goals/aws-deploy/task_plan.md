# Task plan: deploying Answerable on AWS

Order, not time. Every brief starts with its failing tests, leaves its docs complete, ends with the cleanup pass, and is reviewed against [`decisions.md`](decisions.md), [`findings.md`](findings.md) and this plan before it lands on `main`. The log is [`progress.md`](progress.md).

**Status: planned; revised on 10 October 2026 for portability.** The owner confirmed `id.answerable.org` as production and the separate `answerable-staging.uk` zone for staging ([D12](decisions.md)), asked for Cloudflare to stay in front ([D18](decisions.md), [D19](decisions.md)), and then required the deployment to run on Civo, AWS and Google with Civo the most important. That withdrew Fargate ([D2](decisions.md)) in favour of Kubernetes with one Helm chart and a thin Terraform root per cloud ([D20](decisions.md) to [D27](decisions.md), design in [`portability.md`](portability.md)). On 12 October the owner chose **Civo for both environments, each in its own Civo account** ([D28](decisions.md)), and PostgreSQL 17 ([D26](decisions.md)). **Built on 13 October 2026 on branch `claude/civo-deploy`: B1 to B6 and the first-run setup commands, every gate green (see [`progress.md`](progress.md)). Next: B7a, the first staging deployment on the owner's Civo account, following [`infra/README.md`](../../../infra/README.md).** The owner's instruction (8 October 2026): deploy Answerable ID, the Toolbox and the admin MCP on AWS in the UK as code, with Postgres where needed, outstanding security, everything in containers, the web app staying on Vercel, one push to update, horizontal scaling when needed, Kubernetes allowed, low cost, staging first with production one click away, documented, and tested locally where possible, cutting no corners.

## What done looks like

1. A push to `main` builds the three images, migrates and deploys **staging** at `id.answerable-staging.uk`, `toolbox.answerable-staging.uk` and `admin-mcp.answerable-staging.uk`, and a smoke test proves them through the public ingress.
2. One click (a reviewed `workflow_dispatch`) stands up or updates **production** at `id.answerable.org`, `toolbox.answerable.org` and `admin-mcp.answerable.org` with the exact image digest staging runs.
3. Every AWS resource is Terraform in `infra/aws`, applied by GitHub Actions through OIDC roles; no long-lived AWS key exists anywhere.
4. The images, the migrations, the database bootstrap and the registration of the MCPs in ID are proved locally by `bun run infra:test` against a production-shaped Docker stack, and in CI on every push.
5. The security model holds: one account per environment, a private network with firewalls, Cloudflare as the only path, restricted database roles for all three services, verified TLS to Postgres, secrets in OpenBao with per-service identities and a read audit once B7b lands (encrypted in the repository until then), encrypted backups, alerts and spend checks.
6. `docs/12-aws-deployment.md` says what runs where and why, `infra/aws/README.md` says how to deploy, promote, roll back, rotate, restore and scale, and `docs/02-plan.md`'s register reflects what this goal resolved.

Out of scope: moving the web app off Vercel, a CDN or WAF, a second region, closing the ID release gate (E1 to E8 in `../../../reports/answerable-id-release-decision-plan.md`), Redis, email, KMS-backed token signing. Each is named Not yet in the docs ([D15](decisions.md)).

## The owner's requirements, decided

| Requirement | Decision |
| --- | --- |
| Deploy as code | Terraform, hand-written, pinned, one thin root per cloud under `infra/`, plus the Helm chart ([D3](decisions.md), [D21](decisions.md)) |
| Runs on Civo, AWS and Google | A portable core (images, chart, ingress-nginx, `sops`-encrypted secrets, Grafana agent, `helm upgrade`) over a thin cloud layer; Civo runs both environments in two Civo accounts, AWS and Google stay validated roots ([D20](decisions.md) to [D28](decisions.md), [`portability.md`](portability.md)) |
| Postgres where needed | One managed PostgreSQL 17 instance per environment (Civo Database, RDS or Cloud SQL) with three databases, separate owner and runtime logins ([D4](decisions.md), [D5](decisions.md), [D26](decisions.md)) |
| Outstanding security | Account per environment, private network and firewalls, Cloudflare-only admission with origin pulls verified, verified TLS, least-privilege database roles, a namespace-scoped deploy identity, OpenBao with per-service identities and a read audit after staging is up ([D1](decisions.md), [D5](decisions.md), [D18](decisions.md), [D22](decisions.md), [D25](decisions.md), [D29](decisions.md)) |
| UK region | `eu-west-2` (London) only, enforced by an SCP |
| Docker for the admin MCP, the Toolbox and ID | Three images from the monorepo, arm64, non-root, read-only ([D9](decisions.md)) |
| Web stays on Vercel | Untouched; production's records sit beside Vercel's in the `answerable.org` zone, staging has its own zone `answerable-staging.uk` ([D12](decisions.md)) |
| Cloudflare stays in front | Proxied records, Full (strict), Authenticated Origin Pulls verified by the ALB, Cloudflare's ranges as the only admitted source and as ID's trusted proxies, challenges off for the API hostnames, one zone and one token per environment ([D6](decisions.md), [D18](decisions.md), [D19](decisions.md)) |
| One push updates everything | `main` → images → staging, with migrations first ([D8](decisions.md), [D10](decisions.md), [D11](decisions.md)) |
| Horizontal scaling when needed | HorizontalPodAutoscalers; production starts at two replicas per service spread across nodes ([D21](decisions.md)) |
| Kubernetes allowed | Used, because it is the only compute layer all three clouds share ([D20](decisions.md)) |
| Low cost | Civo: about $103 a month for staging and $170 to $340 for production; AWS with EKS about $220 and $430; Google about $100 and $350 ([portability](portability.md#cost-three-ways), [cost simulation](cost-simulation.md) for the AWS detail and the audit-growth caveat); production costs nothing until the first click |
| Staging first, production one click | `promote-production` behind a reviewed GitHub environment ([D8](decisions.md), [D16](decisions.md)) |
| Documented and tested locally | `docs/12`, `infra/aws/README.md`, `bun run infra:test` on the production-shaped stack, `bun run infra:check` on the Terraform ([D13](decisions.md)) |

## Topology, per environment

```
Browsers, MCP hosts, machine clients
        │ HTTPS
        ▼
Cloudflare (proxied CNAMEs, Full strict, WAF, no challenges on API hosts)
        │ HTTPS + origin-pull client certificate          GitHub Actions
        ▼                                                         │ build → GHCR · helm upgrade
┌─ one cloud account per environment (Civo LON1 · AWS eu-west-2 · Google europe-west2) ─┐
│  cloud TCP load balancer: 443 from Cloudflare's ranges only (firewall)         ▼       │
│        │                                                                               │
│  Kubernetes cluster · namespace answerable                                              │
│     ingress-nginx: TLS (cert-manager), origin-pull verify, trusted proxies              │
│        │                                                                               │
│     id (×n) · toolbox (×n) · admin-mcp (×n) · Jobs: migrate, bootstrap, register        │
│     Secrets: sops-encrypted in git, applied by the deploy · Grafana agent → Grafana Cloud │
│        │ TLS verify-full, runtime logins, private network                              │
│  managed PostgreSQL 17 (Civo Database · RDS · Cloud SQL), backups                       │
│  Terraform state in the cloud's object store                                            │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

The Toolbox and the admin MCP reach ID at its public issuer through Cloudflare, so that one URL is the issuer everywhere ([findings](findings.md#what-has-to-run)). `TRUSTED_PROXY_CIDRS` is Cloudflare's published ranges plus the cluster's pod range, because ingress-nginx is a hop ([D22](decisions.md)). The earlier AWS-only topology (ALB, Fargate, RDS in private subnets) is kept in [`decisions.md`](decisions.md) under the withdrawn D2 and D6 for the record.

## Briefs

| Brief | Executor ([D17](decisions.md)) | Depends on | What lands | Proof |
| --- | --- | --- | --- | --- |
Each brief file carries a "Revised 10 October" block where portability changed it; the original text below it stands where it did not.

| Brief | Executor ([D17](decisions.md)) | Depends on | What lands | Proof |
| --- | --- | --- | --- | --- |
| [B0](briefs/b0.md) Account foundation | Owner with an agent | — | The Civo organisation with one account per environment, teams and roles; the AWS Organization, SCPs, CloudTrail, Identity Center and OIDC roles when AWS is a target; the `age` key pair per environment and `.sops.yaml`; per-cloud state storage | A workflow job authenticates to each chosen cloud; a call outside London is denied where the cloud can enforce it |
| [B1](briefs/b1.md) Least-privilege database roles for the MCP servers | Codex, Fable reviews | — | `@answerable/mcp-postgres` provisions and asserts a runtime role; the Toolbox and admin MCP migrate with an owner URL and run as a restricted login; local init, acceptance kit, lanes and docs follow; PostgreSQL 17 in compose and CI | `bun run mcp:test`, `bun run mcp:test:e2e` on 17; an owner login is refused at start |
| [B2](briefs/b2.md) Containers and the local cluster | Codex, Fable reviews | B1 | Three Dockerfiles, `.dockerignore`, bind-host variables, the database CA bundles, verified `Bun.SQL` TLS; the **kind stack** (`infra/k8s/local`) installing the chart with ingress-nginx, cert-manager and a TLS-only PostgreSQL 17; `bun run infra:test` proving ID and the Toolbox through the ingress | `bun run infra:test` green locally and in CI |
| [B3](briefs/b3.md) The ops image: database bootstrap and registration | Codex, Fable reviews | B2 | `infra/ops`: idempotent `bootstrap` and `register`, run as Helm Jobs; the kind test now covers the admin MCP, a machine-token round trip and a staff sign-in through the cluster | `bun run infra:test`; `infra/ops` at 100% coverage |
| [B4a](briefs/b4.md) The chart | Codex, Fable reviews | B3 | `charts/answerable` and the platform pieces (ingress-nginx, cert-manager, External Secrets, the Grafana agent) with values per environment and cloud; `helm lint`, chart tests in kind, `infra:check` for Helm, Terraform, workflows | `infra:check` and `infra:test` green |
| [B4b](briefs/b4.md) The cloud roots | Codex, Fable reviews | B0, B4a | `infra/civo/envs/staging` and `envs/production` (network, firewalls, cluster, database, load balancer firewall, object-store state, the deployer ServiceAccount, Cloudflare records), applied; `infra/aws` and `infra/google` written and validated only | `terraform plan` clean against both Civo accounts; `terraform validate` on the other two |
| [B5](briefs/b5.md) Pipeline: push to deploy, one click to production | Codex, Fable reviews | B4a, B4b | Images to GHCR with attestations and signatures; `deploy-staging` on `main` and `promote-production` on dispatch, both `helm upgrade --atomic` after the migration Jobs; `infra` plan and apply; `ops` dispatch for `register`; smoke test | Exercised in B7 |
| [B6](briefs/b6.md) Documentation and gates | Codex, Fable reviews | B1–B5 | `docs/12-deployment.md` (the portable core, then one appendix per cloud), `infra/README.md` runbook, updates to `docs/01`, `docs/02`, `docs/06`, `README.md`, `AGENTS.md`, `default.env`, `knip.json`, `turbo.json`, the release plan's E5–E7 inputs | `bun --filter web test` (links), `bunx knip` |
| [B7a](briefs/b7.md) First staging deployment | Owner with an agent | B0–B6 on `main` | Staging live end to end on Civo: first run, registration, Claude Code against the staging admin MCP, preflight, the database restore drill, measured numbers; long-lived keys retired; the evidence report | The evidence report |
| [B7b](briefs/b7b.md) OpenBao, the secret store | Codex for the code, the owner for the ceremony, Fable reviews | B7a, B4a, B5 | OpenBao in the platform chart with the static seal chained to the `sops` file, Kubernetes auth, policies per service, External Secrets back in front of it, the ops store and `migrate-secrets`, nightly snapshots, the alerts, the runbook; staging migrated and the `sops` file reduced to the seal key ([D29](decisions.md)) | `infra:test` with OpenBao in the loop; staging on OpenBao; a rehearsed restore |
| [B7c](briefs/b7c.md) The production rehearsal | Owner with an agent | B7a, B7b | Production stood up by one click with OpenBao from its first minute, initialised, smoke-tested, both restores drilled, then destroyed again or kept; the evidence report's production section | The evidence report |
| [B8](briefs/b8.md) Cleanup and conclusions | Fable | B7c | Dead code and docs drift removed, `conclusions.md`, the plan's do-not-re-propose entries, memory | Every gate green on `main` |

Order: **B0 ∥ (B1 → B2 → B3 → B4a) → B4b → B5 → B6 → B7a → B7b → B7c → B8.** B0 needs only the owner and can start today; the chart (B4a) is cloud-neutral and waits on nothing but B3; OpenBao (B7b) waits for staging to be up, as the owner asked.

## What the goal adds to the repository

```
apps/id/Dockerfile · mcps/toolbox/Dockerfile · mcps/admin/Dockerfile · .dockerignore
charts/
  answerable/    the chart: Deployments, HPA, PDB, NetworkPolicy, Ingress, Jobs, ExternalSecrets; values per environment and cloud
  platform/      ingress-nginx, cert-manager, the Grafana agent, and from B7b OpenBao and External Secrets, pinned as dependencies
.sops.yaml       the age recipients per environment; infra/civo/envs/<env>/secrets.enc.yaml holds the encrypted human secrets, and after B7b only OpenBao's seal key
infra/
  README.md      the runbook: the portable core once, then one section per cloud
  k8s/local/     the kind stack: TLS-only PostgreSQL 17, a self-signed issuer, local values, stack.test.ts   (@answerable/infra-k8s)
  ops/           bootstrap, register, the secret store, Dockerfile, tests                                   (@answerable/infra-ops)
  civo/          org notes · envs/staging · envs/production  (network, firewall, cluster, database, deployer, Cloudflare records, state)
  aws/           org/ · bootstrap/ · envs/*                   (VPC, EKS, RDS, NLB firewall, OIDC roles, S3 state; the Organization as before)
  google/        envs/*                                       (VPC, GKE Autopilot, Cloud SQL, WIF; written and validated, applied on demand)
.github/workflows/  deploy-staging.yml · promote-production.yml · infra.yml · ops.yml  (ci.yml gains infra:check and infra:test)
docs/12-deployment.md · reports/staging-evidence.md
```

Root scripts: `bun run infra:check` (Helm lint, Terraform and workflow linting, no cloud access) and `bun run infra:test` (the kind stack; Docker). Both run in CI.

## Owner inputs the briefs need

- Decided on 12 October 2026: **Civo for both environments, two Civo accounts** ([D28](decisions.md)).
- B0: a Civo organisation with the two accounts (`answerable-staging`, `answerable-production`), the owner in each Owners team, MFA on the owner's Civo login, each account's API key kept by the owner ([D25](decisions.md)); the alarm email for Grafana Cloud; one `age` key pair per environment, generated on a trusted machine, the public key committed in `.sops.yaml` and the private key kept by the owner wherever they keep their own secrets and set as `SOPS_AGE_KEY` on that environment in GitHub ([D23](decisions.md)); two Cloudflare API tokens, one per zone (`answerable-staging.uk` for staging, `answerable.org` for production), each with DNS edit, SSL and Certificates edit, Zone Settings edit and Zone WAF edit on its zone only ([D19](decisions.md)). The AWS Organization work waits until AWS is used.
- Before B4b applies: Bot Fight Mode off in both zones' Security settings (a dashboard toggle). No certificate add-on: every hostname is first-level ([D12](decisions.md)).
- B7b: the OpenBao initialisation ceremony on a trusted machine, and a safe place for the recovery shares and root token, separate per environment ([D29](decisions.md)).
- B7: the one-time origin-pull certificate upload per zone from a trusted machine ([D19](decisions.md)); an Entra app registration for staging with the redirect `https://id.answerable-staging.uk/auth/sso/callback` (production keeps the documented one), optionally a Google client for staging; the first sign-in; the go for the production rehearsal (about $10 for a day, then destroyed) or for keeping production up (about $200 a month).
- Confirmed: [D2](decisions.md) (Fargate) on 8 October 2026; [D12](decisions.md) (hostnames) on 8 October, staging moved to its own zone on 10 October.

## Phases of this planning session

| Phase | Status |
| --- | --- |
| 1. Read the repository, probe the machine, DNS and AWS | complete |
| 2. Measure prices and versions, record findings | complete |
| 3. Decide, write the briefs | complete |
| 4. Owner review of D2, D12 and the brief order | complete: Cloudflare in front added as D18 and D19; staging on its own zone `answerable-staging.uk` |
| 5. Portability revision (Civo, AWS, Google) | complete: facts read from the providers' pages, D20 to D27 decided, briefs revised; D28 decided on 12 October: Civo, two accounts |
| 6. Execution, B0 to B8 | not started |

Errors met during planning are in [`progress.md`](progress.md).

## After the goal

- Close E5, E6 and E7 of the release gate with the staging evidence and a production load test through the real ingress.
- Scheduled scale-to-zero for staging outside working hours, a second NAT gateway in production, Container Insights and the Toolbox's OTLP exporter: each when a measurement says it pays.
- Kubernetes only if a need appears that Fargate cannot meet; the images, pipeline and data layer carry over unchanged ([D2](decisions.md)).
