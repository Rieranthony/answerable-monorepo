# Portability: one deployment for Civo, AWS and Google

The owner's requirement of 10 October 2026: whatever we build must run on AWS, Google Cloud and Civo, with Civo the most important. This page is the design that meets it, the facts it rests on (read from the providers' own pages in the browser on 10 October 2026), what it changes in the plan, and the one decision the owner still has to make. Decisions are recorded as D20 to D28 in [`decisions.md`](decisions.md).

## The shape: a portable core and a thin cloud layer

Only one compute layer exists on all three clouds. ECS Fargate is AWS-only, Cloud Run is Google-only, and Civo offers Kubernetes and nothing else, so **Kubernetes is the compute layer** (D20) and the earlier Fargate decision (D2) is withdrawn. Everything the application needs is expressed once, in Kubernetes terms, and each cloud supplies the same five things underneath.

```
┌─ Portable core (identical on every cloud) ───────────────────────────────────────────┐
│  Images (GHCR)  ·  Helm chart: 3 Deployments, HPA, PDB, NetworkPolicy, Ingress, Jobs │
│  ingress-nginx (TLS, Cloudflare origin-pull check, trusted proxies) · cert-manager   │
│  sops + age for human secrets → Kubernetes Secrets · Jobs own generated ones         │
│  Grafana Cloud agent                                                                  │
│  GitHub Actions: build → push → helm upgrade  ·  the kind stack for local proof       │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌─ Cloud layer (one small Terraform root per cloud and environment) ───────────────────┐
│            Civo (LON1)            AWS (eu-west-2)            Google (europe-west2)    │
│  cluster   Civo Kubernetes        EKS                        GKE Autopilot            │
│  database  Civo Database PG 17    RDS PostgreSQL 17          Cloud SQL PostgreSQL 17  │
│  entry     Civo load balancer     Network Load Balancer      TCP load balancer        │
│  secrets   sops + age in git      sops + age (or Secrets M.) sops + age (or Secret M.)│
│  state     Civo object store      S3                         GCS                      │
│  CI auth   deployer token         OIDC role                  Workload Identity Fed.   │
│  DNS/edge  Cloudflare, unchanged (D18)                                                │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

What stays exactly as planned: the images and their hardening, the two-login database scheme (B1), verified TLS to Postgres, Cloudflare in front with origin pulls and Cloudflare's ranges as the trusted proxies, the one-off `bootstrap`, `migrate` and `register` tasks, push-to-deploy staging and one-click production, the documentation and local-proof gates.

## What each cloud offers, as read from its pages

### Civo

| Fact | Source |
| --- | --- |
| The Kubernetes control plane is free ("all of the core components of the control plane for free"); you pay for worker nodes. Standard nodes: Small 1 vCPU / 2 GB $10.86, Medium 2 vCPU / 4 GB $21.73, Large 4 vCPU / 8 GB $43.45 a month | [pricing](https://www.civo.com/pricing) |
| Managed PostgreSQL: Small 2 vCPU / 4 GB / 40 GB NVMe $43.45, Medium 4 vCPU / 8 GB / 80 GB $86.91, Large 6 vCPU / 16 GB / 160 GB $173.81 a month; "additional nodes" (2 or 4) for fault tolerance, priced separately | pricing; [getting started](https://www.civo.com/docs/database/getting-started) |
| **Only PostgreSQL 17 is offered, and the service is in beta**: "We currently support Postgres 17"; "PostgreSQL 17: Currently available in beta for testing purposes"; 14 is being deprecated | getting started |
| Backups: the landing page says "automatic backups" and "high-availability options" with no schedule, retention or restore procedure documented | [databases](https://www.civo.com/docs/database) |
| Database access is a firewall on port 5432 (any address, or listed addresses) and optionally a private network | getting started |
| Load balancer $10.86 a month per 10,000 concurrent requests; a Kubernetes `Service` of type `LoadBalancer` creates one, with annotations for the firewall, the algorithm and a reserved IP; internal load balancers exist | [load balancers](https://www.civo.com/docs/networking/load-balancers/creating-load-balancers) |
| Private networks isolate instances and clusters; assignment is permanent; "Civo Kubernetes clusters always have a public IP address" | [private networks](https://www.civo.com/docs/networking/private-networks); [create a cluster](https://www.civo.com/docs/kubernetes/create-a-cluster) |
| Firewalls attach to clusters, databases and load balancers; node pools scale up and down; CNI is selectable (Flannel and Talos being deprecated) | create a cluster |
| Object store is S3-compatible, region-specific, $0.01086 per GB-month in 500 GB blocks; egress is free | [object stores](https://www.civo.com/docs/object-stores); pricing |
| Regions: LON1, FRA1, NYC1, MUM1, all with Kubernetes, databases, volumes and object stores | [regions](https://www.civo.com/docs/overview/regions) |
| Teams: accounts own resources and billing; organisations group accounts and share roles; teams carry permissions such as "Technical Administrator"; the docs show one account per environment as the intended pattern | [teams](https://www.civo.com/docs/account/teams) |
| **API keys are per account, not per user or scope, with no expiry documented**; regeneration is the only control | [API keys](https://www.civo.com/docs/account/api-keys) |
| **No managed secrets service.** The marketplace (apps Civo installs into your cluster, which you then run yourself) lists Sealed Secrets ("a Kubernetes controller and tool for one-way encrypted Secrets"), HashiCorp Vault, Bitwarden Self Host Unified (beta, "Open Source Password and Secrets Manager") and "Kubernetes External Secrets", the retired predecessor of External Secrets Operator; none is operated by Civo | [marketplace](https://www.civo.com/marketplace), read 12 October 2026 |
| Terraform provider `civo/civo` 1.3.3 (29 September 2026) | registry.terraform.io |

Not found on Civo's pages: etcd or secrets-at-rest encryption, a private cluster API endpoint, an audit log of API calls, a KMS, a secret store, a threat detector. The design compensates where it can (below) and names the rest.

### AWS

EKS charges $0.10 per cluster-hour ($73 a month) before any node, plus EC2 for nodes or the Auto Mode management premium ([findings](findings.md#london-prices-measured)). RDS, Secrets Manager, IAM, OIDC, CloudTrail and GuardDuty are as already planned. RDS offers PostgreSQL 17.11 in London.

### Google Cloud

GKE charges $0.10 per cluster-hour; the free tier gives $74.40 a month per billing account, "equivalent to one free Autopilot or zonal Standard cluster per month". Autopilot bills per pod request: in Iowa $0.0445 per vCPU-hour and $0.0049225 per GiB-hour (London is priced higher; not measured). Cloud SQL London prices were not measured in this session. Source: [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing).

### The tooling the core relies on

- External Secrets Operator lists providers for AWS Secrets Manager (with IRSA and Pod Identity), Google Secret Manager, Infisical, and 1Password through either a Connect server or the newer SDK provider, which needs only a service-account token ([ESO](https://external-secrets.io/latest/provider/1password-sdk/)). Kept for the day a company store exists; not used now (D23).
- **Cloudflare Secrets Store** exists, "available in open beta", as "a secure, centralized location in which account-level secrets are stored"; it "is currently compatible with Cloudflare Workers and AI Gateway", a Worker reads a value with `await env.<BINDING>.get()`, and the REST API's "Get a secret by ID" returns only metadata (id, name, status, scopes, comment), never the value ([overview](https://developers.cloudflare.com/secrets-store/), [Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/), [API](https://developers.cloudflare.com/api/resources/secrets_store/)). Nothing outside Cloudflare's own products can fetch a secret from it, so it cannot feed a cluster; a Worker written to serve secrets over HTTPS could bridge it (External Secrets has a generic webhook provider), which would be a secret service of our own making, not a managed one.
- **A store of our own, asked on 12 October 2026.** No small, maintained "Hono on Workers" secret store exists: a search finds only a CLI for syncing Worker secrets, an alpha Hono plugin that wraps the cloud stores, and Cloudflare's own product ([search](https://www.producthunt.com/products/cloudflare-secrets-manager), [plugin](https://jsr.io/@hono-enterprise/secrets-plugin)). The self-hostable products are whole systems: Infisical ships as "Infisical, PostgreSQL, and Redis together" with an HSM option and a hardening guide ([self-hosting](https://infisical.com/docs/self-hosting/overview)); Phase wants 2 cores and 2 GB at minimum, a TLS certificate, a WAF, backups and your own upgrades ([self-hosting](https://docs.phase.dev/self-hosting)); OpenBao inherits Vault's Raft, storage and unseal model. What makes a home-made one feasible at all is External Secrets' **generic webhook provider**: a `SecretStore` with a templated `url`, headers carrying a token from a Kubernetes Secret and a `jsonPath` into the JSON reply, so any small HTTPS API becomes a cluster secret source ([webhook](https://external-secrets.io/latest/provider/webhook/)). A minimal service for our scope (a dozen static secrets, two consumers) would be: a Hono app on Workers with a D1 table of `name, version, ciphertext, iv`, AES-256-GCM through Web Crypto with the master key held as a Worker secret, scoped bearer tokens stored hashed, versions, an append-only read log, and a `bun` CLI for people; about 500 lines plus tests, three to five days with the custody and rotation runbook. The code is the easy part; the custody of the master key, the token model, availability at pod start and being our own security vendor are the real cost. Recorded as the third option under `Q-SECRET-STORE`; not built now (D23).
- **OpenBao in our own cluster, raised by the owner on 12 October 2026.** From OpenBao's documentation (version 2.7.x): a server "starts in a sealed state" and by default needs a quorum of Shamir shares entered by hand after every restart, which "makes the process of automating an OpenBao install difficult"; Auto Unseal delegates that to a KMS or HSM, and the **static key seal** is "built into OpenBao" and takes a 32-byte key from a file or an environment variable, "only recommended when an existing source of trust, such as another third-party secrets manager, already exists", with n-1 to n rotation ([seal](https://openbao.org/docs/concepts/seal/), [static seal](https://openbao.org/docs/configuration/seal/static/)). The official Helm chart installs it, but by default "in standalone mode" with file storage that "is NOT appropriate for a production setup", and it carries a warning that the chart "is new and under significant development" ([Helm chart](https://openbao.org/docs/platform/k8s/helm/)). The Kubernetes auth method lets a pod log in with its ServiceAccount token and receive a scoped OpenBao token ([Kubernetes auth](https://openbao.org/docs/auth/kubernetes/)). Backups are `bao operator raft snapshot save` and `restore` ([operator raft](https://openbao.org/docs/commands/operator/raft/)). External Secrets talks to OpenBao "by using the HashiCorp Vault Provider" ([ESO](https://external-secrets.io/latest/provider/openbao/)). The viable shape on Civo: OpenBao from the official chart with integrated Raft storage, one replica in staging and three in production, the static seal key being the one secret kept in the `sops` file, Kubernetes auth for the services and External Secrets, the audit device shipped to Grafana, a nightly Raft snapshot to the Civo object store, and the root token and recovery shares kept offline by the owner. Decided on 12 October 2026 as [D29](decisions.md): OpenBao lands as brief B7b, right after staging is up, and production launches with it.
- `sops` encrypts a file "for one or more age recipients" with `--age` or `SOPS_AGE_RECIPIENTS`, decrypts with the identity from `keys.txt` in the user's configuration directory or from the `SOPS_AGE_KEY_FILE`, `SOPS_AGE_KEY` or `SOPS_AGE_KEY_CMD` environment variables, and lets `updatekeys` add or remove recipients ([age](https://getsops.io/docs/usage/identities/age/)); a `.sops.yaml` at the repository root holds `creation_rules`, "evaluated sequentially, the first match wins", each with a `path_regex` and the `age` recipients for files matching it, so a staging file and a production file encrypt to different keys by name ([config file](https://getsops.io/docs/usage/identities/config-file/)). The encrypted file keeps its structure with only the values replaced by ciphertext, so a reviewer sees which secret changed without seeing its value ([first steps](https://getsops.io/docs/usage/first-steps/)).
- ingress-nginx verifies client certificates per host with `nginx.ingress.kubernetes.io/auth-tls-secret` (a secret holding `ca.crt`), `auth-tls-verify-client: on` and `auth-tls-verify-depth` ([annotations](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/)). Its ConfigMap has `use-forwarded-headers` (pass incoming `X-Forwarded-*` headers to upstreams), `proxy-real-ip-cidr` (the external load balancer's ranges, comma-separated, default `0.0.0.0/0`), `compute-full-forwarded-for` ("append the remote address to the X-Forwarded-For header instead of replacing it", so the application keeps its own trusted-proxy walk) and `use-proxy-protocol` ([ConfigMap](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/configmap/)). With `compute-full-forwarded-for: "true"` and `proxy-real-ip-cidr` set to Cloudflare's ranges, ID receives the same header chain it would behind the ALB.

## How the plan's promises survive the move

| Promise | On Kubernetes |
| --- | --- |
| Only Cloudflare reaches us | The cloud load balancer's firewall admits 443 from Cloudflare's 22 ranges only (Civo firewall, AWS security group, Google firewall rule); ingress-nginx requires Cloudflare's origin-pull certificate on every host. Same two layers as before, one level lower |
| ID sees the real visitor address | The cloud load balancer passes TCP through (PROXY protocol where the cloud supports it, otherwise source IP preserved with `externalTrafficPolicy: Local`); ingress-nginx trusts `X-Forwarded-For` only from Cloudflare's ranges; `TRUSTED_PROXY_CIDRS` holds Cloudflare's ranges plus the cluster's pod range, because the nginx pod is now a hop |
| Services are private | No service has a public address; a NetworkPolicy allows ingress to each service only from ingress-nginx, and egress only to the database, ID and the identity providers |
| The database is private | Civo: the database in the cluster's private network with a firewall allowing only the cluster's nodes; AWS: RDS in private subnets; Google: private IP. Two logins per database everywhere (B1); `sslmode=verify-full` against each provider's CA, shipped in the image or mounted from a secret |
| Secrets never in plain text in files or state | Human-provided secrets are encrypted in the repository with `sops` and an `age` key per environment and applied as Kubernetes Secrets by the deploy workflow; generated passwords are written by the `bootstrap` and `register` Jobs into Kubernetes Secrets and can be recreated by re-running them; Terraform holds nothing (D23). Kubernetes Secrets in etcd are the last hop and Civo's etcd encryption is undocumented, which the docs say plainly |
| Migrations before the rollout, with the owner login | Helm pre-upgrade hook Jobs from the same image; the owner URL secret is mounted only by the Job |
| Rolling deploys with rollback | Deployment strategy `RollingUpdate` with `maxUnavailable: 0`, readiness probes on `/readyz` and `/health`, `helm upgrade --atomic` rolls back when pods never become ready |
| Horizontal scaling | HorizontalPodAutoscaler on CPU (and, later, requests per second from the ingress metrics); production floors at two replicas spread across nodes by a topology constraint; a PodDisruptionBudget keeps one up during node maintenance |
| One image, one click | Images on GHCR named by commit; `promote-production` runs `helm upgrade` against the production cluster with the staging tag |
| Logs and alarms | The Grafana Cloud agent ships logs and metrics from every cluster to one free-tier workspace; alert rules there replace the CloudWatch alarms; the managed database's own metrics stay in each cloud's console |
| Tested locally | The chart is installed into a `kind` cluster on the laptop and in CI with the real images, ingress-nginx, cert-manager and a TLS-only PostgreSQL 17, and the same proofs run (health, ingress refusal, discovery, registration, a staff sign-in, a tool call) |

## PostgreSQL 17 everywhere

Civo offers only 17, so the plan runs 17 on every cloud and locally, instead of the 16 the repository pins today. The migrations and the test suites must be proved on 17 before anything deploys: B1 adds `postgres:17` to the compose file and CI. RDS has 17.11 in London; Cloud SQL offers 17.

## Where the three clouds differ in security, honestly

| Concern | Civo | AWS | Google |
| --- | --- | --- | --- |
| Who can act on the account | Teams with roles; one API key per account, unscoped, no expiry documented | IAM roles, OIDC federation for GitHub, no long-lived keys | IAM, Workload Identity Federation for GitHub |
| Audit of control-plane actions | Not documented | CloudTrail | Cloud Audit Logs |
| Threat detection | None | GuardDuty | Security Command Center (paid tiers) |
| Encryption keys you control | None | KMS | Cloud KMS |
| Cluster API endpoint | Public address, firewall-restrictable | Private endpoint possible | Private endpoint possible |
| Managed Postgres maturity | Beta, 17 only, backups and HA undocumented | Mature, 35-day point-in-time recovery, Multi-AZ | Mature, point-in-time recovery, HA |

Mitigations the design applies on Civo: one Civo account per environment under an organisation; the API key held only by the owner and by the infra workflow's protected environment, never by the deploy workflow, which uses a namespace-scoped deployer ServiceAccount token instead; the cluster API firewalled to the owner's addresses and GitHub's runner ranges where practical; the database on the private network behind a firewall listing only the cluster; a restore drill on Civo in B7 before any production data, because the backup behaviour is undocumented; the audit of our own API lives in ID's `audit_events` regardless of cloud.

## Cost, three ways

Civo prices are from its pricing page; AWS from the pricing API ([cost simulation](cost-simulation.md)); Google partly unmeasured. Monthly, USD, before VAT.

| Environment | Civo | AWS (EKS) | Google (GKE Autopilot) |
| --- | --- | --- | --- |
| Staging: 2 nodes or equivalent pods, smallest managed Postgres 17, one load balancer, state storage | 2 × Medium nodes $43.46 + Postgres Small $43.45 + LB $10.86 + object store $5.43 ≈ **$103** (2 × Small nodes: ≈ $82) | cluster fee $73.00 + 2 × `t4g.medium` $54.90 + disks $3.71 + NLB $21.50 + NAT $37.00 + RDS `db.t4g.micro` 17.11 $15.80 + KMS, GuardDuty, logs, state ≈ $13.50 = **about $220** (measured 12 October 2026, itemised in the [cost simulation](cost-simulation.md#staging-with-kubernetes-on-aws-postgresql-17); Auto Mode ≈ $250) | cluster fee covered by the free tier + pods ≈ $35 (Iowa rates) + Cloud SQL smallest (unmeasured, about $30 to $50) + load balancer ≈ $20 ≈ **$90 to $110**, London rates higher |
| Production at the planned baseline (two replicas per service) | 3 × Medium nodes $65.19 + Postgres Medium $86.91 (+ 2 extra nodes for fault tolerance, price unlisted, assume ≈ ×3 ≈ $260) + LB $10.86 + object store $5.43 ≈ **$170 single-node database, ≈ $340 with the extra nodes** | $73.00 + 3 × `t4g.large` $164.69 + disks $5.57 + NLB $25 + 2 NAT $76 + RDS `db.t4g.medium` Multi-AZ $105.85 + 50 GB storage $13.30 + KMS, GuardDuty, logs, egress ≈ $31 = **about $495** | $73 + pods ≈ $80 + Cloud SQL HA (unmeasured, about $150 to $200) + load balancer ≈ **$330 to $380** |
| Observability | Grafana Cloud free tier on every cloud | | |

The audit-growth caveat from the cost simulation applies on every cloud, and bites hardest on Civo, where storage is bundled with the instance size: at 15 GB a month (26 GB before ID stopped recording an audit event per refresh on 19 October 2026) the Medium database's 80 GB fills in about five months, after which the next size costs $86.90 more. Deciding retention (`Q-EVIDENCE-RETENTION`) is a prerequisite for production on Civo, not an optimisation.

## What changes in the briefs

- **B0** gains the Civo foundation (organisation, one account per environment, teams, the deployer ServiceAccount pattern) and keeps the AWS foundation for the AWS target; the Google foundation (a project per environment, Workload Identity Federation) is written when Google is first applied.
- **B1** adds PostgreSQL 17 to the local compose file and CI.
- **B2** keeps the images and replaces the compose stack with the **kind stack**: the real chart on a local cluster.
- **B3** is unchanged; its tasks become Helm Jobs.
- **B4** splits into **B4a, the chart** (`charts/answerable`, the platform pieces, the kind tests, `infra:check` for Helm) and **B4b, the cloud roots** (`infra/civo`, `infra/aws`, `infra/google`, each thin), applied for the clouds the owner chooses.
- **B5** builds to GHCR and deploys with `helm upgrade`, authenticating per cloud.
- **B6** documents the portable core once and each cloud in an appendix.
- **B7a** deploys staging on Civo; **B7b** adds OpenBao to it ([D29](decisions.md)); **B7c** rehearses production with OpenBao in place; a second cloud's rehearsal is a separate, owner-approved step.

## The decision the owner must make (D28)

**Decided on 12 October 2026: Civo for staging and production, each environment in its own Civo account.** AWS and Google stay written and validated roots. The options as they were put:

| Option | For | Against |
| --- | --- | --- |
| **Civo for staging and production** (recommended if cost and the stated priority rule) | Cheapest by far; the architecture page already names Civo London; consistent staging and production; proves the Civo path every day | The weakest security toolbox of the three for an identity provider: unscoped account API keys, no control-plane audit, undocumented backups, a beta database; those gaps are mitigated, not closed |
| **AWS for production, Civo for staging** | Production on the strongest primitives; staging cheap; the chart is proved on two clouds continuously | Cloud-specific surprises reach production first; two roots to operate from day one |
| **AWS for both** (the original instruction) | As planned, strongest security, everything measured | Most expensive; Civo compatibility is proved only by the kind stack and a later rehearsal |

Whichever is chosen, Google stays a written root that `terraform validate` keeps honest until someone applies it.
