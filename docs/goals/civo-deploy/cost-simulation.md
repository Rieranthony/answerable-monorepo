# Cost simulation: staging, and production at 100 organisations

**Revised context, 10 October 2026.** This page prices the AWS design as first planned (Fargate). The portability decision ([D20](decisions.md)) moves compute to Kubernetes, which on AWS adds EKS's $73-a-month cluster fee and node costs, and makes Civo the cheapest home: the three-cloud comparison is in [`portability.md`](portability.md#cost-three-ways). The activity model, the unit prices and the audit-growth conclusion below still hold on every cloud.

**Revised storage, 19 October 2026.** ID no longer records an audit event per refresh (v0 schema audit, D6): of the 10 token issuances per active user a day, only the 2 code exchanges write one. The activity model's storage row and the yield below are recomputed; the month-12 storage figures in "The bill" and "What moves the number" were computed at the earlier 26.5 GB a month and are now upper bounds.

An estimate, built from unit prices measured on AWS's pricing API for `EU (London)` on 8 and 10 October 2026 ([findings](findings.md#london-prices-measured)) and from the repository's own storage measurements. Everything else is an assumption, stated. A month is 730 hours; prices are USD, on demand, before VAT. Cloudflare is on the free plan ($0) and GitHub Actions is free for this public repository.

## Unit prices used

| Item | Price | Per month |
| --- | --- | --- |
| Fargate arm64 vCPU / GB | $0.03725 / $0.00409 per hour | $27.19 per vCPU, $2.99 per GB |
| RDS PostgreSQL `db.t4g.micro` single-AZ | $0.018 per hour | $13.14 |
| RDS `db.t4g.medium` Multi-AZ (2 vCPU burstable, 4 GiB) | $0.145 per hour | $105.85 |
| RDS `db.m7g.large` Multi-AZ (2 vCPU, 8 GiB) | $0.3904 per hour | $284.99 |
| RDS gp3 storage single-AZ / Multi-AZ | $0.133 / $0.266 per GB-month | — |
| RDS backup storage beyond the free 100% of provisioned | $0.10 per GB-month | — |
| NAT gateway | $0.05 per hour + $0.05 per GB | $36.50 + data |
| Application Load Balancer | $0.02646 per hour + $0.0084 per LCU-hour | $19.32 + LCUs |
| Data transfer out to the internet (to Cloudflare) | $0.09 per GB, first 10 TB | — |
| CloudWatch Logs ingested / stored | $0.5985 per GB / $0.0315 per GB-month | — |
| CloudWatch alarms, standard / composite | $0.10 / $0.50 per alarm-month | — |
| Secrets Manager | $0.40 per secret-month | $5.60 for fourteen |
| KMS customer-managed key | $1 per key-month | $4 for four |
| ECR / S3 storage | $0.10 / $0.024 per GB-month | — |
| GuardDuty | $4.40 per million CloudTrail events + $1.10 per GB of flow and DNS logs analysed | — |

## Staging

One task per service, the smallest database, one NAT gateway, as planned ([task plan](task_plan.md)).

| Line | Sizing | Per month |
| --- | --- | --- |
| Fargate: ID | 0.5 vCPU, 1 GB | $16.59 |
| Fargate: Toolbox, admin MCP | 0.25 vCPU, 0.5 GB each | $16.58 |
| RDS `db.t4g.micro` single-AZ, 20 GB gp3 | | $15.80 |
| NAT gateway + about 10 GB | | $37.00 |
| ALB + a fraction of an LCU | | $21.50 |
| Secrets Manager (14) + KMS (4 keys) | | $9.60 |
| CloudWatch Logs (~1 GB) + 16 alarms + 1 composite | | $2.80 |
| ECR (~10 GB) + S3 (logs, state) | | $1.50 |
| GuardDuty (~1M CloudTrail events, ~2 GB logs) | | $6.60 |
| Data transfer out (~5 GB) | | $0.45 |
| **Total** | | **about $130** |

The `.uk` domain adds about £7 a year. Staging can be stopped outside working hours later (scheduled scale-to-zero, [D15](decisions.md)), which would cut the Fargate line by about 60%; the NAT, ALB and database hours dominate and do not stop.

## Staging with Kubernetes on AWS, PostgreSQL 17

Measured on 12 October 2026 from the pricing API for `EU (London)`, on demand, 730 hours. Two Graviton nodes carry ingress-nginx, cert-manager, External Secrets, the Grafana agent and one replica of each service; secrets come from 1Password, so Secrets Manager and ECR are not used; logs go to Grafana Cloud's free tier, so only EKS's own control-plane logs land in CloudWatch.

| Line | Sizing | Per month |
| --- | --- | --- |
| EKS cluster fee | $0.10 per cluster-hour, charged whether or not anything runs | $73.00 |
| Worker nodes | 2 × `t4g.medium` (2 vCPU, 4 GiB) at $0.0376 per hour | $54.90 |
| Node disks | 2 × 20 GB gp3 at $0.0928 per GB-month | $3.71 |
| Network Load Balancer | $0.02646 per hour + about one capacity unit at $0.006 per hour | $21.50 |
| NAT gateway + about 10 GB | $0.05 per hour + $0.05 per GB | $37.00 |
| RDS `db.t4g.micro` single-AZ, PostgreSQL 17.11, 20 GB gp3 | $0.018 per hour + $0.133 per GB-month | $15.80 |
| KMS keys (database, disks, logs) | 3 × $1 | $3.00 |
| GuardDuty (CloudTrail events, flow logs, EKS audit logs) | | $7.00 |
| CloudWatch Logs for the EKS control plane (~2 GB) | | $2.00 |
| S3 (state), data transfer out (~5 GB) | | $1.50 |
| **Total** | | **about $220** |

Two variants: EKS Auto Mode (AWS runs the nodes; burstable `t4g` is not offered there) with 2 × `m8g.medium` (1 vCPU, 4 GiB) at $0.0519 + $0.00623 management per hour comes to $84.87 for the nodes, **about $250** in total; 2 × `t4g.small` (2 vCPU, 2 GiB) at $0.0188 per hour saves $27 but leaves about 1.3 GiB usable per node once the platform pods are placed, so it is not the default. The cluster fee and the NAT gateway are fixed costs the cluster cannot scale away; the same staging is about $130 on Fargate and about $103 on Civo ([portability](portability.md#cost-three-ways)).

## Production: 100 organisations of 1,000 users

### The activity model

| Assumption | Value | Why |
| --- | --- | --- |
| Registered users | 100,000 | 100 organisations × 1,000 |
| Active on a working day | 30% → 30,000 | A typical B2B product; sensitivity below |
| Working days a month | 22 | Weekend load ignored |
| Business hours a day | 9 | Peak load is taken as 3× the business-hour average |
| Per active user per day, ID | 1 OIDC login to their OmniChat cell (~6 requests, 1 token issuance), 1 MCP connect (~4 requests, 1 issuance), 8 refreshes (15-minute tokens over ~2 hours of use, 8 issuances) | `docs/01`: tokens are audience-bound and live 5 to 15 minutes; the admin MCP's documented TTL is 900 s |
| Per active user per day, Toolbox | 20 reads, 2 mutations (prepare + commit = 4 calls), ~4 list and metadata calls → 28 MCP calls | A moderate agent user |
| Staff on the admin MCP | ~500 calls a day | Negligible |
| Storage per event | ID: ~2.4 KB per code exchange in `audit_events` (with its indexes and `audit_event_users` row), none per refresh, kept forever; Toolbox: 568 B per read, ~3.4 KB per mutation, kept forever | Toolbox measured on 6 October 2026, ID on 19 October 2026, `docs/02-plan.md` row `Q-EVIDENCE-RETENTION` |

What that yields per working day: 540,000 ID requests (16.7 a second on average in business hours, ~50 at peak) and 300,000 token issuances, 60,000 of them code exchanges that write an audit event; 840,000 Toolbox calls (~26 a second, ~78 at peak); about 1.5 million inserted rows before the revision, 240,000 fewer audit events after it; and **about 0.7 GB of new audit and evidence rows** (ID 0.14 GB, the Toolbox 0.54 GB), 15 GB a month, about 180 GB a year, roughly 240 GB with indexes. Before the revision: 1.2 GB a day, 26.5 GB a month, about 320 GB a year, roughly 415 GB with indexes.

### Sizing

- **ID**: two tasks of 1 vCPU / 2 GB across two zones, autoscaling 2 to 6. Fifty requests a second at peak is well inside what two Bun processes serve; the database, not the CPU, is the first limit.
- **Toolbox**: the same shape. Each call verifies a JWT locally, reads cached grants and writes one evidence row.
- **Admin MCP**: two tasks of 0.25 vCPU / 0.5 GB, for availability rather than load.
- **Database**: at baseline the three services open about 80 connections (ID 2 × 20, the MCPs 2 × 10 each), about 240 when every service is at six tasks, plus migrations and operators. `db.t4g.medium` (4 GiB, `max_connections` ≈ 450 by RDS's formula) carries it; it is burstable, so B7's CPU-credit alarm decides whether `db.m7g.large` (8 GiB, no credits) replaces it. Both shown. Multi-AZ, 35-day backups, 50 GB provisioned at the start with storage autoscaling.
- **Network**: two NAT gateways (one per zone) at this scale; the ALB stays under one LCU because Cloudflare keeps connections open and requests are small.

### The bill

| Line | Start, `db.t4g.medium` | Start, `db.m7g.large` | Month 12 (storage grown) |
| --- | --- | --- | --- |
| Fargate: ID 2 × (1 vCPU, 2 GB) | $66.34 | $66.34 | $66.34 |
| Fargate: Toolbox 2 × (1 vCPU, 2 GB) | $66.34 | $66.34 | $66.34 |
| Fargate: admin MCP 2 × (0.25, 0.5), one-off tasks | $17.58 | $17.58 | $17.58 |
| RDS instance, Multi-AZ | $105.85 | $284.99 | $105.85 |
| RDS storage, Multi-AZ gp3 (50 GB → ~450 GB) | $13.30 | $13.30 | $119.70 |
| NAT gateways ×2 + ~60 GB | $76.00 | $76.00 | $76.00 |
| ALB + under one LCU | $25.00 | $25.00 | $25.00 |
| Data transfer out (~77 GB) | $6.93 | $6.93 | $6.93 |
| CloudWatch Logs (~3 GB) + alarms | $4.20 | $4.20 | $4.50 |
| Secrets Manager (14) + KMS (4) | $9.60 | $9.60 | $9.60 |
| ECR (~15 GB) + S3 (ALB logs 90 days, state) | $2.20 | $2.20 | $2.20 |
| GuardDuty (~2M events, ~5 GB logs) | $14.00 | $14.00 | $14.00 |
| **Total, baseline tasks** | **about $410** | **about $590** | **about $515** |
| With autoscaling averaging 2.4 tasks for ID and 2.5 for the Toolbox | about $440 | about $620 | about $545 |

That is about $0.004 per registered user a month, or $0.014 per active user.

### What moves the number

| Change | Effect |
| --- | --- |
| 10% of users active a day (10,000) | Compute unchanged at baseline; storage grows 9 GB a month: about $400 at the start, $435 at month 12 |
| 60% active (60,000) | ID and Toolbox average 3 tasks (+$66); storage grows 53 GB a month (+$14 every month): about $480 at the start, $650 at month 12 |
| **Audit and evidence kept forever** (today's behaviour) | The only line that keeps growing: about $7 more every month at 30% activity, $14 at 60%. `Q-EVIDENCE-RETENTION` in `docs/02-plan.md` decides retention and archiving; archiving rows older than 13 months to S3 would cap storage near 450 GB (about $120 a month Multi-AZ) and move the rest to $0.024 per GB |
| One NAT gateway instead of two | −$36.50; a zone failure then takes egress with it |
| `db.m7g.large` instead of `db.t4g.medium` | +$179; needed only if the credit alarm fires under real load |
| Fargate Compute Savings Plan, 1 year, no upfront | Roughly 20% off the Fargate lines (about −$30); a 1-year RDS reservation about 30% off the instance (about −$32 on `t4g.medium`) |
| Fargate Spot for the Toolbox | About −$45; not for ID, whose sign-in flows should not be interrupted |
| Cloudflare Pro on the production zone | +$25 a month for more WAF rules and rate limiting; not needed to start |
| AWS Business Support | +$100 a month minimum; worth it once a client depends on production |

### Not in the estimate

OmniChat cells and the web app (Vercel), Microsoft and Google (free), domain registrations (about £7 a year each), VAT, staff time, and anything in [D15](decisions.md)'s Not yet list (Container Insights, a second region, Redis, email).

### How sure is this

The unit prices are measured. The activity model is a guess with the sensitivities above; measure the real figures in B7 (`DatabaseConnections`, CPU credits, storage growth per day, LCUs, egress) and replace this page's assumptions with them. The one structural fact is independent of the guess: audit and evidence are append-only and kept forever, so production's bill rises every month until retention is decided.
