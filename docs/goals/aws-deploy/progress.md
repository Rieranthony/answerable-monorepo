# Progress: deploying Answerable on AWS

Session log, newest last. Facts go in [`findings.md`](findings.md), choices in [`decisions.md`](decisions.md), the order in [`task_plan.md`](task_plan.md).

## 2026-10-08 — planning session (Claude Fable 5.1, coordinator)

- Read `README.md`, `docs/00` to `docs/02`, `docs/06-deploying-answerable-id.md`, `apps/id/README.md`, `apps/id/OPERATIONS.md`, the three servers' `server.ts`, `environment.ts`/`env.ts` and migrate scripts, `packages/mcp-postgres`'s migrator and migrations, the acceptance kit's `id.ts` and compose files, `turbo.json`, `.github/workflows/ci.yml`, `default.env`, `.env.example`.
- Probed the machine: Docker 28.3.2, kubectl, Terraform 1.12.2, AWS CLI with an IAM user's long-lived keys in account 409892201591 (no Organization, no alias, default region us-east-1); no kind, k3d, helm, cdk, pulumi.
- Probed DNS: `answerable.org` is on Cloudflare; `www` is a CNAME to Vercel; `id.answerable.org` does not exist yet.
- Measured London prices from the AWS pricing API (`aws pricing get-products`), recorded in `findings.md`.
- Checked the latest Terraform (1.16.5 on releases.hashicorp.com) and that GitHub's arm64 hosted runners are free and generally available for public repositories.
- Wrote this goal's `task_plan.md`, `findings.md`, `decisions.md` and the briefs.

## Errors encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| `aws organizations describe-organization` → `AWSOrganizationsNotInUseException` | 1 | Not an error of ours: the account is standalone. Recorded as a fact; B0 creates the Organization |
| `find node_modules -name sql.d.ts -path "*bun-types*"` found nothing | 1 | Bun's isolated install layout; searched `node_modules/.bun` instead |

### Written this session

- `task_plan.md` (goal, requirements → decisions, topology, the brief table, layout, owner inputs, phases), `findings.md`, `decisions.md` (D1–D17), `briefs/b0.md` to `b8.md`.
- `bun --filter web test`: 88 pass, 0 fail, so every link in the new files resolves.
- Paths and headings the briefs cite were checked: `apps/id/src/http/admin/clients.ts`, `apps/id/src/db/runtime-role.ts`, `apps/id/src/__tests__/oidc-issuer.ts`, `packages/acceptance/src/{cleanup,oauth,admin-mcp}.ts`, `apps/web/content/docs/id/onboard.mdx` § Get a staff token, `docs/mcp/local-testing.mdx`.
- House memory: `aws-deploy-goal-progress.md` added to the memory index.
- Nothing committed: the plan awaits the owner's confirmation of D2 and D12 ([task_plan](task_plan.md#owner-inputs-the-briefs-need)).

## 2026-10-08 — owner review

- The owner confirmed Fargate (D2) and the hostnames: `id.answerable.org` for production, `*.staging.answerable.org` for staging (D12), and asked for Cloudflare to stay in front.
- Checked Cloudflare's documentation: Universal SSL stops at first-level names, so staging needs Advanced Certificate Manager; `X-Forwarded-For` is appended, not replaced; zone-level Authenticated Origin Pulls uses a certificate exclusive to the account; the proxy read timeout is 125 s; 15 IPv4 and 7 IPv6 ranges published. Recorded in `findings.md` § Cloudflare in front.
- Revised D6 and D12, added D18 (Cloudflare in front, what it does and does not do) and D19 (the `infra/edge` root and the origin-pull certificate handled outside Terraform); updated the plan's topology, requirements table, layout and owner inputs; B0 (token scopes), B4 (ingress and the edge root), B6 (`docs/01`, `docs/02`, `README.md` wording), B7 (step 0 for the edge, the lockdown proof, the forged-header address proof).

## 2026-10-10 — staging gets its own zone

- The owner moved staging to `answerable-staging.uk`; `dig` shows it registered and already on Cloudflare (`simon`/`mina.ns.cloudflare.com`), with no records.
- Every hostname is now first-level, so Universal SSL covers both zones and the Advanced Certificate Manager add-on is gone from the plan. D12 and D19 revised: one zone, one token and one origin-pull certificate per environment; the `edge` settings become a module in each environment root instead of a shared `infra/edge` root. Updated the plan's status, requirements, layout and owner inputs, `findings.md`, B0 (two tokens), B4 (the `edge` module), B6, B7 (step 0 per zone, staging URLs, Entra redirect).
- Wrote `cost-simulation.md`: staging about $130 a month; production for 100 organisations × 1,000 users about $410 (`db.t4g.medium`) to $590 (`db.m7g.large`) at the start, growing about $7 a month from the forever-kept audit and evidence rows (26.5 GB a month at 30% daily activity). Extra London prices measured: `db.t4g.large`, `db.m7g.large`, `db.r7g.large`, `db.m8g.large`, Multi-AZ gp3 $0.266, backup overage $0.10, CloudWatch Logs $0.5985 ingested / $0.0315 stored, alarms $0.10 / $0.50, data transfer out $0.09, GuardDuty $4.40 per million events and $1.10 per GB, S3 $0.024, ECR $0.10, KMS $1.
- Wrote `infra-explainer.html`, a plain-words tour of every service with one diagram per layer and an A-to-Z glossary, published privately at https://claude.ai/artifact/T57iGVdEJYp5qMGZt8gBQf (the file in this folder is the source).

## 2026-10-10 — portability revision (Civo, AWS, Google)

- The owner required compatibility with AWS, Google Cloud and Civo, Civo most important, and asked that the research use the browser. Read in the built-in browser: Civo's pricing, Kubernetes, database (getting started, PostgreSQL), networking (load balancers, private networks), account (API keys, teams), regions and object store pages; GKE's pricing page; External Secrets' AWS and 1Password SDK provider pages and ingress-nginx's annotations and ConfigMap pages through WebFetch. Each fact is cited in `portability.md`.
- Wrote `portability.md`: the portable core (images, Helm chart, ingress-nginx, cert-manager, External Secrets, Grafana agent, `helm upgrade`, kind stack) over a thin Terraform root per cloud; the per-cloud facts; how every promise survives; PostgreSQL 17 everywhere; the security comparison; the three-way cost table; the owner's pending decision D28.
- Decisions: D2 withdrawn; D20 to D27 added; D28 pending. Task plan, findings, cost simulation and briefs B0, B1, B2, B4 (now B4a and B4b), B5, B6, B7 carry "Revised 10 October" blocks.
- Not yet updated: `infra-explainer.html` (sections 4 to 7, 9 and 10 describe the AWS-only design); refresh after D28.

## 2026-10-12 — staging on EKS, PostgreSQL 17 confirmed

- The owner confirmed PostgreSQL 17 (D26) and asked what staging costs with Kubernetes on AWS. Measured from the pricing API: EKS $0.10 per cluster-hour; `t4g.small` $0.0188, `t4g.medium` $0.0376, `t4g.large` $0.0752, `m7g.medium` $0.0472, `m7g.large` $0.0944, `m8g.medium` $0.0519 per hour; Auto Mode management $0.00623 per hour for `m8g.medium` and nothing for `t4g`; NLB $0.02646 per hour + $0.006 per NLCU-hour; EBS gp3 $0.0928 per GB-month; RDS PostgreSQL 17.11 available on `db.t4g.micro` in London.
- Staging on EKS with 2 × `t4g.medium`, an NLB, one NAT and `db.t4g.micro` on 17.11: about $220 a month ($250 with Auto Mode), itemised in `cost-simulation.md`; production on EKS about $495. `portability.md`'s three-way table updated.
- The owner decided D28: Civo for staging and production, each in its own Civo account. Recorded in `decisions.md`, `portability.md`, the task plan and briefs B0, B4, B5, B6, B7; the AWS Organization work in B0 and the AWS and Google roots are deferred to validation only. `infra-explainer.html` rewritten for the Civo and Kubernetes design and republished.
- The owner's 1Password is personal and is not to be automated. D23 revised: human-provided secrets encrypted in the repository with `sops` and one `age` key per environment, applied by the deploy workflow; generated passwords written by the `bootstrap` and `register` Jobs into Kubernetes Secrets and recreatable by re-running them; External Secrets Operator and a company store deferred (`Q-SECRET-STORE` stays open). Updated `portability.md`, the task plan, B0, B3, B4, B5, B7 and the tour page.
- Read sops's own pages in the browser (age identities, config file, first steps): `--age`/`SOPS_AGE_RECIPIENTS` to encrypt, `SOPS_AGE_KEY`/`SOPS_AGE_KEY_FILE`/`SOPS_AGE_KEY_CMD` to decrypt, `.sops.yaml` `creation_rules` with `path_regex` and `age` recipients, first match wins; cited in `portability.md`.
- Checked Civo's marketplace in the browser for a secrets service: none managed by Civo; self-run apps only (Sealed Secrets, HashiCorp Vault, Bitwarden Self Host beta, the retired Kubernetes External Secrets). Recorded in `portability.md`, `findings.md` and D23's alternatives; the sops + age choice stands.
- Checked Cloudflare Secrets Store in the browser (overview, Workers integration, API reference): open beta, compatible with Workers and AI Gateway only, values readable only through a Worker binding's `get()`, the API returns metadata without values. Not a store a cluster can read; recorded in `portability.md`, `findings.md` and D23.
- The owner asked about a small self-hosted secret store, possibly on Cloudflare. Researched: no maintained minimal Hono/Workers store exists; Infisical (Postgres + Redis), Phase (2 cores / 2 GB minimum) and OpenBao are whole systems; External Secrets' webhook provider makes any small HTTPS API a cluster source. Sketched a Workers + D1 + Web Crypto design (about 500 lines, three to five days) as the third `Q-SECRET-STORE` option in `portability.md` and D23; not built now.
- The owner is weighing OpenBao on our own cluster. Read OpenBao's docs in the browser: Shamir unseal by default (manual after every restart), the built-in static-key seal (a 32-byte key from a file or env, "only recommended when an existing source of trust" exists, n-1 rotation), the official Helm chart (standalone mode not for production; chart "under significant development"), Kubernetes auth, Raft snapshot save/restore; ESO reaches OpenBao through its Vault provider. Recorded the viable shape in `portability.md` and D23's alternatives; D23 unchanged pending the owner's decision.
- The owner decided OpenBao as the secret store, placed right after staging is up (D29). B7 split: B7a staging (file `b7.md`), B7b OpenBao (`b7b.md`: static seal chained to the `sops` file, Kubernetes auth, policies, External Secrets back, ops store, `migrate-secrets`, snapshots, alerts, runbook, the ceremony), B7c the production rehearsal (`b7c.md`, with OpenBao from the first minute); B8 depends on B7c. Task plan, D23 and `portability.md` updated; `Q-SECRET-STORE` resolves when B7b lands.
