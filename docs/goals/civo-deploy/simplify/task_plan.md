# Task plan: simplify the deployment, automated end to end

**Goal.** Before B7a, reshape the deployment so that nothing is done by hand from a laptop: every secret is born in GitHub, in Terraform or inside the cluster; a tag ships staging or production; Civo is the only cloud named anywhere, the goal's record included. Delete first, simplify second.

**The owner's words.** 19 October 2026: "Is anything here unnecessary, overly complicated in our current setup, or based on weak assumptions for our infra? Challenge them. What can be deleted entirely? What can be simplified now that unnecessary pieces are gone? Then make the changes. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. Plan with files, report before coding." Then: "I need this to be as much automated as possible. Would love to maybe store our secrets in GitHub secrets, then those are being encrypted from there automatically, so nothing is done from one's laptop manually and secrets are safe there." Then, confirmed: tags `staging/<name>` and `production/<name>`, one GitHub environment per target, the open authenticated Kubernetes API, Origin CA certificates from Terraform, no OpenBao, delete the AWS-era studies and the stale worktree, rewrite the decisions file as Civo-only.

The audit that led here: [`report.html`](report.html) (published at https://claude.ai/artifact/S5NTzGp8ParMRRPNASXh2S), [`findings.md`](findings.md).

## The target, in one page

**GitHub.** Two environments, `staging` and `production`, each allowed for the branch `main` and the tags `<environment>/*`; `production` requires the owner's review. The owner pastes five secrets into each, once: `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `GH_SECRETS_TOKEN` (a fine-grained token for this repository alone, with read and write on Environments and Secrets, and an expiry in the owner's calendar). `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are optional. Everything else is written by a workflow or by Terraform and never read by a person: `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `UPSTREAM_TOKEN_SECRETS`, `ROOT_ADMIN_SECRET` (the bootstrap workflow), `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN` (Terraform). No repository variable.

**Workflows, five.**

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ci.yml` | A push to any branch; called by the two shipping workflows | validate, infra-check, containers (the kind stack on amd64, as Civo runs) |
| `bootstrap.yml` | By hand, once per environment, `environment` input | With the Civo CLI: the state bucket and its credential; with `gh`: the state credential and ID's three random secrets into the environment, each only when missing. Prints nothing secret |
| `deploy-staging.yml` | A tag `staging/*` on a commit of `main` | CI; Terraform apply (staging), which also writes `KUBE_*` to the environment; build the four amd64 images, push by digest, tag `sha-<commit>`, sign; apply `id-env` from the environment's secrets and `helm upgrade` by digest; smoke |
| `promote-production.yml` | A tag `production/*` on a commit of `main` | Verify the four signatures of `sha-<commit>` (built by `deploy-staging.yml` on a `staging/*` tag, so staging always comes first); wait for the reviewer; Terraform apply (production); deploy the verified digests; smoke |
| `ops.yml` | By hand: `environment`, `command` (`register`, `make-admin`), `email` | Runs the ops Job once through a Helm upgrade; `make-admin` is the last step of the first run, after the owner's first sign-in |

**Terraform, one root.** `infra/civo` with `envs/staging.tfvars` and `envs/production.tfvars`; `terraform.sh <environment> <args>` runs `init` with `-backend-config=bucket=answerable-<environment>-tfstate -backend-config=key=<environment>.tfstate` and every command with `-var-file=envs/<environment>.tfvars`, mapping `STATE_*` to the backend's own variable names (the one place that may). Modules: `network`, `cluster` (6443 from the internet, authenticated; no `allowed_api_cidrs`, no `api_open_to_internet`), `database` (the administrator's database is `postgres`, as Civo documents), `ingress-firewall`, `edge` (the records, settings and rules as today, plus: the origin-pull CA and client certificate made with the `tls` provider and uploaded with `cloudflare_authenticated_origin_pulls_certificate`; the origin certificate requested from Cloudflare's Origin CA with `cloudflare_origin_ca_certificate` for the three hostnames, 5475 days, ECC), `platform` (both namespaces with `enforce: restricted`; the platform release with `originPull.caPem` from the edge module's output, no file; the ConfigMap `trusted-proxies` key `cidrs` in `answerable`; the Secret `postgres-admin` key `OPS_DATABASE_ADMIN_URL` from the database module; the Secret `origin-tls`, type `kubernetes.io/tls`, from the Origin CA certificate), `deployer` (as today, without `read_namespaces`), `github` (the environment's policies and reviewer, and `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN` as its secrets). The first apply in CI runs `apply -target=module.cluster -target=module.database -target=module.ingress_firewall` and then the full apply; both are no-ops afterwards. No `modules/state`: the bootstrap workflow owns the bucket. Sensitive outputs for break-glass only: `admin_kubeconfig`, `database_admin_url`.

**Charts.** `charts/platform`: Traefik only (no cert-manager, no Grafana agent); one TLSOption, `default`, demanding Cloudflare's client certificate; the Secret `cloudflare-origin-pull-ca` from `originPull.caPem`. `charts/answerable`: the Ingresses use the shared Secret `origin-tls` and no issuer; `TRUSTED_PROXY_CIDRS` from the ConfigMap `trusted-proxies`; no `database.caPem`, no `postgres-ca` template (the bootstrap Job writes that ConfigMap); the ops Job gets `OPS_STAFF_DOMAIN`, `OPS_ENTRA_TENANT` (chart values `id.staffDomain`, `id.entraTenant`) and `OPS_ADMIN_EMAIL` (`ops.adminEmail`); no `database.host`, `database.port`, `id.microsoftClientId`, `id.googleClientId`, `ingress.issuer`, `ingress.tlsOption`.

**The ops image.** `bootstrap`: when the ConfigMap `postgres-ca` is missing, open a TCP connection to the database, send PostgreSQL's SSLRequest, start TLS, keep the chain's self-signed root, write it to the ConfigMap and log its SHA-256 fingerprint; connect with `verify-full` against it; then the databases and logins as today. `register`: as today, then the staff domain and the Entra SSO provider on the platform organisation when `OPS_STAFF_DOMAIN` and `OPS_ENTRA_TENANT` are set (the same calls and keys as `onboard.mdx`), skipped with a line when a Microsoft client is not configured. `make-admin` (new): the member with `OPS_ADMIN_EMAIL` into `answerable-owner` then `platform-admins`, confirming that root is locked afterwards. No file store.

**The pipeline.** `deploy`: build the `id-env` Secret from the environment (`BETTER_AUTH_SECRET`, `UPSTREAM_TOKEN_SECRETS`, `ROOT_ADMIN_SECRET`, the Microsoft pair, the Google pair when set) and apply it on standard input; always run the bootstrap Job; register on the first install; `helm upgrade` by digest. `run-job <bootstrap|register|make-admin>`. `smoke`. No `current-tag`, no `--bootstrap`, no `--set-file`, no `sops`, no rehearsal.

**The kind stack.** Its three authorities and four certificates made with the system `openssl` (LibreSSL 3.3 supports `-addext`): the stack CA, the origin-pull stand-in CA and client certificate, the database CA and server certificate. It writes `origin-tls`, `trusted-proxies`, `postgres-admin`, `id-env` and `cloudflare-origin-pull-ca`'s input as Terraform and the deploy do; the bootstrap Job fetches the database CA by itself and the test checks the ConfigMap against the generated CA. No cert-manager anywhere.

**Deleted.** `infra/setup` (whole), `infra/pipeline/rehearsal`, `infra.yml`, `infra/civo/envs/production` and the second root, `modules/state`, `.trivyignore`, `.sops.yaml`, `secrets.enc.yaml`, `edge-ca`, `database-ca.pem`, cert-manager and the Grafana agent, `read_namespaces`, `DEPLOY_STAGING`, the AWS-era studies (`portability.md`, `cost-simulation.md`), the finished briefs B0 to B6 and B7b, the stale worktree directory.

## Contracts between the pieces

| Object | Written by | Read by |
| --- | --- | --- |
| ConfigMap `answerable/trusted-proxies`, key `cidrs` (comma-separated CIDRs: Cloudflare's ranges, the private network, the pod range) | Terraform (platform module); the kind stack | ID's `TRUSTED_PROXY_CIDRS` (`configMapKeyRef`) |
| Secret `answerable/postgres-admin`, key `OPS_DATABASE_ADMIN_URL` (`sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`) | Terraform; the kind stack | The bootstrap Job |
| Secret `answerable/origin-tls`, type `kubernetes.io/tls` | Terraform (Origin CA); the kind stack (its CA) | The three Ingresses |
| Secret `answerable/cloudflare-origin-pull-ca`, key `ca.crt` | The platform chart from `originPull.caPem` (Terraform passes the edge module's CA; the stack its stand-in's) | Traefik's `default` TLSOption |
| ConfigMap `answerable/postgres-ca`, key `ca.pem` | The bootstrap Job (trust on first use, fingerprint logged) | Every pod, at `/etc/ssl/db/ca.pem` |
| Secret `answerable/id-env` | The deploy, from the GitHub environment; the stack | ID; the register and make-admin Jobs (`ROOT_ADMIN_SECRET`) |
| The six database URL Secrets, `toolbox-id-client`, `admin-id-client` | The ops Jobs | The services and migrations |
| GitHub environment secrets `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN` | Terraform (github module) | The deploy and ops jobs |
| GitHub environment secrets `STATE_*`, `BETTER_AUTH_SECRET`, `UPSTREAM_TOKEN_SECRETS`, `ROOT_ADMIN_SECRET` | `bootstrap.yml` | Terraform's init; the deploy |
| Platform chart values Terraform sets | `originPull.caPem`, `traefik.service.annotations`, `traefik.ports.websecure.forwardedHeaders.trustedIPs` | unchanged keys |
| Pipeline CLI | `deploy --environment <e> --image-tag sha-<40 hex> [--image-digest <image>=sha256:<hex> x4]`; `run-job <job> --environment <e> [--email <address>]`; `smoke --environment <e> --wait <s>` | The workflows |
| Terraform wrapper | `infra/civo/terraform.sh <environment> <terraform args>` | The workflows, the runbook |

## Phases

| # | Phase | Owner | Status |
| --- | --- | --- | --- |
| 1 | Audit, report, decisions | coordinator | complete |
| 2 | Rewrite this plan | coordinator | complete |
| 3 | Terraform: one root, the edge PKI, the github module, the platform module's objects, tests, lock file, README | agent T (worktree) | pending |
| 4 | Charts, ops image, pipeline, kind stack, chart tests, READMEs | agent C (worktree) | pending |
| 5 | Workflows and the tool action; deletions outside the agents' areas; the AWS-era record | coordinator | pending |
| 6 | Integrate the two branches on `main`, every gate, push | coordinator | pending |
| 7 | `docs/12`, `infra/README.md`, `AGENTS.md`, `default.env`, decisions D32 onward, the tutorial and the tour page, memory | coordinator | pending |

Gates: `bun run infra:check` (T), `bun run mcp:check @answerable/infra-ops`, `@answerable/infra-pipeline`, `@answerable/infra-k8s` typecheck and lint, `bun run infra:test` (C, one kind cluster per machine), `bun run typecheck`, `bun run lint`, `bun --filter web test` (links), `bunx knip`, then CI on the pushed commit.

## Errors encountered

| Error | Attempt | Resolution |
| --- | --- | --- |
| A `cd` inside a Bash call moved the shell's working directory; later relative reads failed | 1 | Absolute paths everywhere |
| Persisted tool outputs above about 25k tokens cannot be read in one call | 1 | Read in slices of 600 lines |
| macOS has no `timeout` command | 1 | Dropped it |
