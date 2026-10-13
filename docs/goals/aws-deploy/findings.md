# Findings: deploying Answerable on AWS

Facts only, each with where it came from. Choices are in [`decisions.md`](decisions.md). A fact that a brief disproves is corrected here, not argued with.

## What has to run

| Service | Entry | Listens | Health | State | Talks to |
| --- | --- | --- | --- | --- | --- |
| Answerable ID (`apps/id`) | `bun apps/id/dist/server.js` after `bun --filter @answerable/id build`; the bundle keeps `hono-tailwind` external, so it runs from an installed checkout (`docs/06`, `apps/id/package.json`) | `PORT`, default 47300, every interface (`Bun.serve({ port })`, `src/runtime.ts`) | `/healthz` (no query), `/readyz` (`select 1`); both reachable without the ingress check (`apps/id/README.md`) | Postgres `answerable_id`; stateless otherwise except per-process rate-limit buckets and a five-minute JWKS cache, so replicas are fine (`docs/06`) | Google and Microsoft endpoints over outbound HTTPS |
| Toolbox (`mcps/toolbox`) | `bun src/server.ts` from source (`package.json` `start`); its `dev` builds `@answerable/mcp-e2e` first and `start` does not | `TOOLBOX_PORT`, default 47400, **`127.0.0.1` only** (`src/server.ts`) | `/health`: `{status:"ok"}` while `select 1` answers, else 503, whatever the `Host` header (`docs/toolbox/index.mdx`) | Postgres `answerable_toolbox` through `Bun.SQL`; an in-process grants poller reads ID's audit log every 15 s per replica (`src/poller.ts`) | ID's token endpoint and admin API as a machine client (`TOOLBOX_ID_*`); optional OTLP/HTTP exporter |
| Admin MCP (`mcps/admin`) | `bun src/server.ts` from source | `ADMIN_PORT`, default 47520, **`127.0.0.1` only** (`src/server.ts`) | `/health` from the SDK (`packages/mcp/src/server.ts`) | Postgres `answerable_admin` through `Bun.SQL`: only `@answerable/mcp-postgres`'s intents and evidence (`scripts/migrate.ts`) | ID's admin API on every request (roles are never cached, `docs/11`); the Toolbox's admin API at `ADMIN_TOOLBOX_ADMIN_RESOURCE`; exits 1 at start when ID does not answer `readPlatform` |
| Web (`apps/web`) | Vercel | — | — | — | Stays on Vercel; it never calls ID at runtime (`docs/06`, the `/oauth-test` page is development-only) |

- The Toolbox mounts the e2e provider and imports `mcps/e2e/dist/records.html` at module load: `@answerable/mcp-e2e/view` throws when `bun run --filter @answerable/mcp-e2e build` has not run (`mcps/e2e/src/view.ts`). An image of the Toolbox must run that build.
- The SDK checks the `Host` header against the resource URL's hostname (`hosts = [resourceUrl.hostname]`, `packages/mcp/src/server.ts:172`): the ingress must pass the public `Host` through unchanged.
- ID requires in production: `NODE_ENV=production`, `BETTER_AUTH_URL` (`https://`, the issuer; defaults to `https://id.answerable.org`), non-empty origin-only `BETTER_AUTH_TRUSTED_ORIGINS`, `TRUSTED_PROXY_CIDRS`, `BETTER_AUTH_SECRET`, `DATABASE_URL` as a restricted runtime login; it refuses `NODE_ENV=test` and a privileged database role before listening (`apps/id/src/env.ts`, `src/runtime.ts`, `docs/06`).
- ID's client address comes from `x-forwarded-for`, walked from the right skipping `TRUSTED_PROXY_CIDRS` (`apps/id/src/auth.ts:166`); a production `/auth/*` or `/api/admin/*` request with no resolvable address gets `403 untrusted_ingress` (`src/app.ts:69`). The resolver cannot see the socket peer, so the network must admit only the ingress (`apps/id/README.md`).
- ID's migrations need the schema owner (`DATABASE_MIGRATION_URL`) and provision `DATABASE_RUNTIME_ROLE` on every run; the migration connection waits 5 s for a lock and 5 minutes per statement, and refuses a changed or missing applied file (`apps/id/scripts/migrate.ts`, `apps/id/README.md`).
- The MCP migrator applies directories in order, each file in its own transaction under advisory lock 4751300, records `<directory>/<file>` with a SHA-256 and refuses a changed applied file (`packages/mcp-postgres/src/migrate.ts`). Concurrent migrators take turns, so two replicas starting at once is safe, but the plan runs migrations as a separate step anyway.
- The Toolbox and admin MCP connect as the database **owner** today: `.env.example` gives `TOOLBOX_DATABASE_URL` and `ADMIN_DATABASE_URL` the `answerable` login, and nothing provisions a runtime role for them. `evidence_events` is append-only by trigger and `evidence_payloads` erase-only (`packages/mcp-postgres/migrations/0001_evidence.sql`), but an owner can drop those triggers: the guarantee does not yet hold against the application credential, unlike ID's (`apps/id/README.md` § Database roles).
- The local Postgres is `postgres:16-alpine`; `infra/postgres/init/*.sql` creates the test databases, `answerable_id_runtime`, `answerable_toolbox`, `answerable_admin` and the MCP test databases once per volume (`docker-compose.yml`).
- Secrets: four independent families for ID (`BETTER_AUTH_SECRET`/`BETTER_AUTH_SECRETS`, `UPSTREAM_TOKEN_SECRETS`, `ROOT_ADMIN_SECRET`, the platform application secrets), none allowed in Postgres or its backups; a restored database is unreadable without the keys active when its rows were written (`docs/06` § Operating it). The MCPs add `TOOLBOX_ID_CLIENT_SECRET` and `ADMIN_ID_CLIENT_SECRET`. `Q-SECRET-STORE` in `docs/02-plan.md` is still open.
- Postgres sizing rule: `max_connections` ≥ replicas × `DATABASE_POOL_MAX` (20) + migration and operator sessions (`docs/06`). `Bun.SQL`'s default pool is 10 per process.
- A machine client's secret is **generated by ID**: `POST /api/admin/v1/clients` with `tokenEndpointAuthMethod: client_secret_basic` returns `clientSecret` once in the creation response and stores only its hash; a retry of the same idempotency key returns the receipt without the secret, and a lost secret needs `POST /clients/:clientId/rotate-secret`, which returns a new one and revokes the client's tokens and grant contexts (`apps/id/src/services/clients.ts:244-267`, `:386-395`; `apps/id/src/http/admin/clients.ts:170-172`, `:263-278`). So `register` (B3) must capture the secret from the creation response and store it at once, and recover from a lost response by rotating.
- `admin_operations` and `audit_events` are kept forever and nothing prunes them (`docs/06` § Storage growth); `Q-EVIDENCE-RETENTION` measures the MCPs' growth.
- The release gate `reports/answerable-id-release-decision-plan.md` is **no-go** until E1–E8 close; the deployment-shaped rows are E5 (secret store, key delivery), E6 (topology, ingress, budgets) and E7 (backup and restore, RTO/RPO). This goal supplies the topology and the secret store; it does not close the gate by itself.
- `docs/01-architecture.md` § Stack still says "Hosting: Civo London, K3s, managed Postgres, tailnet". The owner's instruction on 8 October 2026 is AWS, London; the page must change when this goal lands.

## Database TLS from the services

- `pg` 8.16.3 (ID) parses `sslmode` and `sslrootcert` from the URL: `sslrootcert=<file>` is read into `ssl.ca` and `sslmode=verify-full` keeps `rejectUnauthorized` true; `prefer`, `require` and `verify-ca` are deprecated aliases that warn (`node_modules/.bun/pg-connection-string@2.14.0/.../index.js:77-154`). So ID reaches RDS with `?sslmode=verify-full&sslrootcert=/etc/ssl/rds/global-bundle.pem` and no code change.
- `Bun.SQL` 1.3.1 takes `tls?: Bun.BunFile | TLSOptions | boolean` in its options object (`node_modules/.bun/bun-types@1.3.1.../sql.d.ts:329`); its types say nothing about `sslmode` or `sslrootcert` in the URL. The Toolbox and admin MCP build `new SQL(url)` with no options (`src/server.ts`, `scripts/migrate.ts`), so verified TLS to RDS needs either Bun's URL parsing proved by a test or a `tls: { ca }` option: B1 settles it with a TLS-only local Postgres.
- RDS signs its server certificates with Amazon's own CAs; the bundle for every region is `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` (AWS documentation). It must ship in the images.

## Cloudflare in front

Checked on 8 October 2026 against Cloudflare's developer documentation and API.

- **Two zones, both on Cloudflare** (10 October 2026): `answerable.org` (`crystal`/`cullen.ns.cloudflare.com`, shared with Vercel's DNS-only `www`) and `answerable-staging.uk` (`simon`/`mina.ns.cloudflare.com`, registered by the owner for staging, no records yet).
- **Universal SSL covers only the apex and first-level names** in a full-setup zone: "coverage is limited to the root domain (for example, `example.com`) and first-level subdomains"; deeper names "are not covered and will not serve a valid certificate" ([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)). Every hostname in [D12](decisions.md) is first-level, so Universal SSL suffices. (The earlier `id.staging.answerable.org` shape was second-level and would have needed **Advanced Certificate Manager**, the paid add-on that lets a certificate list `*.staging.answerable.org` explicitly ([ACM](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)), which third-party price guides put at $10 a month per zone ([one](https://blog.blazingcdn.com/en-us/decoding-cloudflares-ssl-tls-pricing-options), [two](https://spendhound.com/marketplace/cloudflare-pricing)); the separate staging domain removed that cost.)
- **`X-Forwarded-For`**: Cloudflare keeps an incoming header and appends the address that connected to it; `CF-Connecting-IP` carries that single address ([HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)). The ALB then appends Cloudflare's edge address. At ID the header reads `<whatever the client sent>, <client>, <cloudflare edge>`; the right-to-left walk over Cloudflare's ranges stops at the client ([D6](decisions.md)).
- **Cloudflare's ranges**: 15 IPv4 and 7 IPv6 CIDRs from `https://api.cloudflare.com/client/v4/ips` (etag `38f79d050aa027e3be3865e495dcc9bc` today). They fit one security group (22 rules on port 443) and one `TRUSTED_PROXY_CIDRS` value; Terraform reads them at apply time, so a change in the list needs an apply.
- **Authenticated Origin Pulls** is on every plan. Zone-level uses "a certificate that you upload" and "provides stricter security because the certificate is exclusive to your account"; only the *global* variant uses a Cloudflare certificate shared across all accounts ([AOP](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/)). The ALB verifies client certificates against a trust store (a PEM bundle of CA certificates) in `verify` mode; session resumption is off under mutual TLS ([ALB mTLS](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/mutual-authentication.html)).
- **Streaming**: Cloudflare's Proxy Read Timeout is 125 s by default (error 524, [docs](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)); the SDK's `subscriptions/listen` stream sends a keep-alive comment more often than every 10 s (`packages/mcp/src/server.ts:97`), so MCP streams survive the proxy. Cloudflare preserves the `Host` header to the origin on non-Enterprise plans, which the SDK's host check needs.
- **Bot and browser heuristics break machines**: Bot Fight Mode and Browser Integrity Check challenge non-browser clients with an HTML page; MCP hosts, Claude Code and the Toolbox's and admin MCP's calls to ID are non-browser clients. They must be off for these hostnames ([D18](decisions.md)).
- `www.answerable.org` is **DNS-only** today (its Vercel addresses resolve directly), so zone-wide SSL settings do not change how the site is served.

## Civo, Google and the Kubernetes tooling (10 October 2026)

Read in the browser from the providers' own pages; recorded with their sources in [`portability.md`](portability.md#what-each-cloud-offers-as-read-from-its-pages). The facts that drive decisions: Civo's control plane is free and nodes start at $10.86 a month; Civo's managed PostgreSQL is in beta and offers only version 17, with backups and high availability mentioned but undocumented; a Kubernetes `Service` of type `LoadBalancer` creates a Civo load balancer ($10.86 a month) that a Civo firewall can restrict; Civo clusters always have a public address; Civo API keys are per account and unscoped; Civo has no managed secrets service, only marketplace apps you run in your own cluster (Sealed Secrets, HashiCorp Vault, a beta self-hosted Bitwarden, and the retired "Kubernetes External Secrets"); Cloudflare's Secrets Store (open beta) serves only Workers and AI Gateway, its API never returns a value, so it cannot feed a cluster; GKE charges $0.10 per cluster-hour with $74.40 of monthly credit per billing account; External Secrets Operator supports AWS, Google, Infisical and 1Password (SDK provider, no Connect server); ingress-nginx verifies client certificates per host and can append rather than replace `X-Forwarded-For`.

## This machine and these accounts (8 October 2026)

- Tools: Docker 28.3.2 (Compose v2), `kubectl`, Terraform 1.12.2, AWS CLI; no `kind`, `k3d`, `helm`, `cdk`, `pulumi`, `kustomize`, `flux`.
- AWS: IAM user `anthony-laptop` in account 409892201591 with long-lived keys in `~/.aws/credentials`, default region `us-east-1`, no account alias, **not in an Organization** (`aws organizations describe-organization` → `AWSOrganizationsNotInUseException`). `eu-west-2` is enabled (`opt-in-not-required`).
- DNS: `answerable.org` is served by Cloudflare (`crystal.ns.cloudflare.com`, `cullen.ns.cloudflare.com`); `www.answerable.org` is a CNAME to `bc677ddbb6e2367.vercel-dns-016.com`; `id.answerable.org` and `staging.answerable.org` do not resolve.
- GitHub: `Rieranthony/answerable-monorepo` is **public**; environments `Preview` and `Production` exist (Vercel's); no Actions secrets. CI (`.github/workflows/ci.yml`) runs on `ubuntu-latest` with Docker, Bun 1.3.1 and Playwright Chromium.
- GitHub's arm64 hosted runners (`ubuntu-24.04-arm`, 4 vCPU, 16 GB) are free and generally available for public repositories since 7 August 2025 ([changelog](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)), so arm64 images build natively without QEMU.

## Versions to pin (checked 8 October 2026)

| What | Latest | Source |
| --- | --- | --- |
| Terraform | 1.16.5 | releases.hashicorp.com/terraform |
| `hashicorp/aws` provider | 6.68.0 (7 October 2026) | registry.terraform.io/v1/providers/hashicorp/aws |
| `cloudflare/cloudflare` provider | 5.27.0 (5 October 2026) | registry.terraform.io/v1/providers/cloudflare/cloudflare |
| RDS PostgreSQL in eu-west-2 | 16.9 to 16.15 and 17.5 to 17.11 | `aws rds describe-db-engine-versions --engine postgres --region eu-west-2` |
| Bun | 1.3.1, the repository's pin | `package.json` `packageManager` |

## London prices, measured

From `aws pricing get-products` on 8 October 2026, on-demand, USD, location `EU (London)`; a month is 730 hours.

| Item | Unit price | Per month |
| --- | --- | --- |
| Fargate arm64 vCPU | $0.03725 per vCPU-hour | $27.19 per vCPU |
| Fargate arm64 memory | $0.00409 per GB-hour | $2.99 per GB |
| Fargate x86 vCPU / memory | $0.04656 / $0.00511 per hour | 25% more than arm64 |
| RDS `db.t4g.micro` PostgreSQL | $0.018 single-AZ, $0.036 Multi-AZ per hour | $13.14 / $26.28 |
| RDS `db.t4g.small` PostgreSQL | $0.036 single-AZ, $0.072 Multi-AZ per hour | $26.28 / $52.56 |
| RDS `db.t4g.medium` PostgreSQL | $0.072 single-AZ, $0.145 Multi-AZ per hour | $52.56 / $105.85 |
| RDS gp3 storage, single-AZ | $0.133 per GB-month | $2.66 for 20 GB (Multi-AZ stores twice) |
| NAT Gateway | $0.05 per hour + $0.05 per GB processed | $36.50 + data |
| Application Load Balancer | $0.02646 per hour + $0.0084 per LCU-hour | $19.32 + LCUs (one LCU all month is $6.13) |
| Secrets Manager | $0.40 per secret-month + $0.05 per 10,000 calls | $4.80 for twelve secrets |
| EKS cluster fee (measured 12 October) | $0.10 per cluster-hour | $73.00 |
| EKS Auto Mode management (12 October) | per instance type on top of EC2: $0.00623 per hour for `m8g.medium`, $0.01258 for `m6gd.large`; no entry for `t4g` or `m7g.medium`, so burstable nodes are not offered there | — |
| EC2 Graviton on demand, Linux (12 October) | `t4g.small` 2 vCPU / 2 GiB $0.0188; `t4g.medium` 2 / 4 $0.0376; `t4g.large` 2 / 8 $0.0752; `m7g.medium` 1 / 4 $0.0472; `m7g.large` 2 / 8 $0.0944; `c7g.medium` 1 / 2 $0.0429; `m8g.medium` 1 / 4 $0.0519 per hour | `t4g.medium` $27.45, `t4g.large` $54.90, `m8g.medium` $37.89 |
| Network Load Balancer (12 October) | $0.02646 per hour + $0.006 per NLCU-hour | $19.32 + capacity units |
| EBS gp3 (12 October) | $0.0928 per GB-month | $1.86 for a 20 GB node disk |
| RDS PostgreSQL 17.11 (12 October) | `available` in eu-west-2 on `db.t4g.micro` (Multi-AZ capable); instance prices do not depend on the engine version | as the `t4g` rows above |

Not measured, small: CloudWatch Logs ingestion and storage, ECR storage ($0.10 per GB-month), KMS keys ($1 per key-month), S3 for access logs and Terraform state, data transfer out.

### Sizing used in the estimate

| Environment | Tasks (arm64) | Database | Egress | Estimate |
| --- | --- | --- | --- | --- |
| Staging | ID 0.5 vCPU / 1 GB ×1 ($16.58), Toolbox 0.25 / 0.5 ×1 ($8.29), admin MCP 0.25 / 0.5 ×1 ($8.29) | `db.t4g.micro` single-AZ, 20 GB gp3 ($15.80) | one NAT ($36.50) | with the ALB ($20–25), secrets ($4.80) and the small items (~$8): **about $120 per month** |
| Production | each service ×2 across two zones ($66.32) | `db.t4g.small` Multi-AZ, 20 GB ($57.88) | one NAT ($36.50); two for zone resilience (+$36.50) | with the ALB ($25–30), secrets and small items (~$15): **about $200 per month, $240 with two NAT gateways** |

Production costs nothing until its Terraform is applied; the plan keeps it unapplied until the owner promotes for the first time ([D8](decisions.md)). The scaled scenario, 100 organisations of 1,000 users, with the larger RDS classes, logs, egress, GuardDuty and storage growth priced on 10 October 2026, is in [`cost-simulation.md`](cost-simulation.md).

## Open facts a brief must measure

- Whether `bun install --frozen-lockfile --production --filter <workspace>` installs a workspace's `workspace:*` dependencies in Bun 1.3.1, which would shrink the images; the fallback is a full production install of the monorepo.
- Whether `Bun.SQL` honours `sslmode=verify-full&sslrootcert=` in the URL, or needs `tls: { ca }` (B1).
- Whether ID already sets `Strict-Transport-Security` itself (no match for it in `apps/id/src`); with Cloudflare in front HSTS is a zone setting, so the ALB listener attribute ([docs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-header-modification.html)) is no longer needed.
- Whether the Cloudflare provider 5.x exposes the published ranges as `cloudflare_ip_ranges` (its documentation page did not render in this session); the fallback is Terraform's `http` data source on `https://api.cloudflare.com/client/v4/ips`.
- RDS's default `max_connections` for `db.t4g.micro` and `db.t4g.small` (the formula is `LEAST(DBInstanceClassMemory/9531392, 5000)`, about 112 and 225; read the live parameter in B7).
