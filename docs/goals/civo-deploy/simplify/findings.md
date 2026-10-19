# Findings: what the deployment carries, and what it rests on

Each candidate names the piece, what it is for, the assumption it rests on, and how the claim was (or will be) tested. Status: `claim` (not yet probed), `probed` (with the result), `decided` (by the owner).

## The shape, in numbers (measured 19 October 2026)

`find infra charts .github -type f` excluding `node_modules`, `.terraform`, `coverage`, `.turbo`: about 16,400 lines across 180 files. The largest pieces: `infra/setup` (about 2,900 lines with tests and proof), `infra/pipeline` (about 2,300 with tests and rehearsal), `infra/k8s` (about 1,400), `infra/civo` (about 2,000 with tests), the two charts (about 1,300), the workflows (about 900), the READMEs and runbooks (about 1,500).

## Candidates

### D. Delete

| # | Piece | What it is for | Assumption it rests on | Status |
| --- | --- | --- | --- | --- |
| D1 | `.github/workflows/infra.yml` (152 lines): `infra:check` and a Terraform plan comment on pull requests | Review a Terraform change before merge | That changes arrive as pull requests. The owner's rule since 25 September: no pull requests, everything lands on `main` | claim: the workflow has never run usefully; `gh run list --workflow infra.yml` |
| D2 | The `infra` job of `deploy-staging.yml`, the Terraform step and `apply_infra` input of `promote-production.yml`, the `infra-staging` GitHub environment, `STATE_*`, `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN` and `ALLOWED_API_CIDRS` in GitHub, `terraform.sh`'s credential mapping | Apply staging's Terraform on every push to `main` | That Terraform must run from CI. Production's already cannot (D30), so the two environments differ for no gain; the unscoped, never-expiring Civo key sits in a GitHub environment with no reviewer, readable by any branch of the repository (`infra/pipeline/README.md` § Known limits says so) | claim; decision A |
| D3 | `modules/state`, both `backend.tf`, `terraform.sh`, `first-apply`'s bucket and migration steps (2, 3, 4), the lock question, `STATE_*` in every README | Terraform state in Civo's object store, one 500 GB block per environment ($5.43 a month each) | That state must live outside the repository. With one operator and no CI applies, a `sops`-encrypted state file in the repository (the same `age` key as the secrets file) gives the same protection the secrets already have | claim; decision A |
| D4 | `api_open_to_internet`, `allowed_api_cidrs`, their validations, `ALLOWED_API_CIDRS` everywhere, the production refusal, the first-apply questions about 6443 from the private network | Production's Kubernetes API admits the operators' addresses only | That an internet-reachable, TLS-authenticated API is acceptable in staging but not in production. Every default Civo, DigitalOcean and GKE cluster has one; the deployer token is namespace-scoped; D30 names the follow-up (GitOps or a tunnel) that nobody has scheduled, and until it lands production cannot be deployed from GitHub at all | claim; decision B |
| D5 | `promote-production.yml`'s `resolve` job (70 lines) and the pipeline's `current-tag` command | Default production's tag to the one staging runs, read with staging's deployer token | That the owner does not know which commit staging runs. Staging deploys `main`; a dispatch on `main` has `github.sha`, which is that commit | claim: replace with `sha-${{ github.sha }}` |
| D6 | The arm64 half of the image build, the `manifest` job, the digest artifacts (about 110 lines of `deploy-staging.yml`) | Serve amd64 and arm64 | That Civo's node architecture is unknown. It is documented or observable | claim: web search; decision C |
| D7 | `charts/platform`'s `k8s-monitoring` dependency, the `monitoring` and `k8s-monitoring` values, the `platform` namespace's unenforced Pod Security | The Grafana agent, off until a Grafana Cloud workspace exists | That it will be turned on soon. D14 was the AWS plan; nothing reads metrics; the dependency is the stated reason `platform` is not `restricted` | claim: render the chart, confirm nothing renders |
| D8 | `modules/deployer`'s `read_namespaces`, `read_rules`, two `for_each` resources, one output | Read another namespace for a diagnostic | "Kept for a future diagnostic", empty in both roots | probed by reading: dead |
| D9 | `ops.yml`, `run-job`, `restartServers`, `readRelease` and their tests | Run `register` again from GitHub after root is locked | That a person who has already created `ops-staff-token` with `kubectl` benefits from a workflow for the next command. `helm upgrade --reuse-values --set ops.register=true` and `kubectl rollout restart` are two lines in the runbook | claim; grep for other callers |
| D10 | The `--bootstrap` flag of `deploy` | Choose whether the bootstrap Job runs | Both workflows always pass it; the Job is idempotent and documented as "every deploy" | probed by reading: always true |
| D11 | `database.host`, `database.port` chart values; `OPS_DATABASE_HOST`, `OPS_DATABASE_PORT` | Write a different address into the services' URLs | Nothing sets them: the admin URL already names the private address | claim: grep |
| D12 | `OPS_STORE=file`, `createFileSecretStore`, `OPS_SECRETS_FILE` | Run the ops commands outside a cluster | Only the README's example uses it | claim: grep |
| D13 | `id.microsoftClientId`, `id.googleClientId` chart values | Set the client IDs as plain variables | `init-secrets` already writes both ID and secret into `id-env`, which the chart loads with `envFrom` | claim: grep |
| D14 | The `origin-pull` TLSOption, `ingress.tlsOption`, the `router.tls.options` annotation, `crossProviderNamespaces` | Name the client-certificate option per Ingress | "Either alone keeps a host closed" is proved by the kind stack, so one of the two is redundant; `default` needs no reference | claim: `stack.test.ts` proves each alone fails closed |
| D15 | `infra/pipeline/rehearsal/rehearse.ts` (359 lines) | Run the deploy scripts for real against a stand-in chart | Not in any gate, so it rots; the unit tests cover the scripts, `infra:test` the chart, `infra/setup`'s proof the `sops` pipe | claim |
| D16 | `infra/.trivyignore` ("none yet") | Accepted findings | Empty | claim: read it |
| D17 | B7b (OpenBao) and the sentences that promise it | A secret store with per-service identities and a read audit | That files in git cannot give per-service isolation. No pod mounts an API token, so a pod reads only the Secrets mounted into it; "revocation" is a changed Secret; a read audit for three services and one operator is a product to run, patch, seal and snapshot, with its own seal key in the same `sops` file | claim; decision E |
| D18 | Production's two additional database nodes (`database_nodes = 3`, about $173 a month) | Fault tolerance | That Civo's undocumented failover between nodes works; `docs/12` says B7c checks it | claim; decision F |
| D19 | The inline tool installs of `ci.yml`'s `infra-check` job (`hashicorp/setup-terraform`, `azure/setup-helm`, a 25-line script) | Pin the tools | They duplicate `.github/actions/setup-tools` pin for pin | probed by reading: duplicated |
| D20 | `infra/pipeline/coverage/.lcov.info.*.tmp` (29 files, untracked) | Nothing | Leftovers of a crashed coverage run | probed: untracked |

### S. Simplify

| # | Piece | Today | Simpler | Status |
| --- | --- | --- | --- | --- |
| S1 | Cloudflare's 22 ranges, copied by hand into `values-civo-staging.yaml`, `values-civo-production.yaml` and `charts.test.ts`, with a comment claiming the Terraform apply and the file change together | Three copies; Terraform reads the live list and outputs `trusted_proxy_cidrs`, which nothing consumes | Terraform writes the ConfigMap `trusted-proxies` in `answerable`; ID reads `TRUSTED_PROXY_CIDRS` from it; the kind stack writes its own | claim |
| S2 | Two Terraform roots, byte for byte the same but for `backend.tf` and `terraform.tfvars`, held equal by `civoRootsAgree` in `check.ts` | Every `.tf` file and test twice | One root, two var files, two workspaces; a precondition ties `terraform.workspace` to `var.environment` | claim |
| S3 | `ci.yml`'s `containers` job on arm64 "like the laptops" | The images CI proves are not the architecture Civo runs | amd64 runners, which also lets the job use `setup-tools` | depends on D6 |
| S4 | Terraform outputs nobody reads (`firewall_name`, `reserved_ip_name`, `node_pool_name`, `credential_name`, `bucket_url`, `config_ruleset_id`, `cache_ruleset_id`, `https_sources`, `network_cidr`, `deployer`, `hostnames`) | Lines to keep in step | Keep the ones a command or a person reads | claim: grep consumers |
| S5 | The deployer Role's `cert-manager.io` read rule | Nothing in `deploy.ts` reads certificates | Drop the rule | claim: grep |

### K. Keep, and why

- **Kubernetes.** D20 chose it for portability across three clouds; D28 then chose Civo alone and the owner asked that no other cloud be named. The portability reason is gone, but the charts, the kind stack and the ops Jobs are built and proved, Civo sells Kubernetes as its product, and the alternative (VMs with Compose) gives up rolling deploys and scaling. Not a deletion that pays.
- **Cloudflare in front, the firewall by Cloudflare's ranges, Traefik's client-certificate check.** Three cheap layers for one invariant; each catches what the others miss.
- **The ops Jobs, the zero-replica wait, `register` in the first upgrade.** The only way one `helm upgrade` can bring up ID and then register the MCPs against it.
- **`infra/setup`.** Big, but it is the first run the owner is about to do, reviewed on 18 October; it shrinks with D2, D3 and D4.
- **The kind stack and `charts.test.ts`.** The local proof the owner asked for; it is in CI.
- **cosign signing and the verification in `promote-production.yml`.** One step each; the only check that production's bytes came from a commit that passed CI.
- **`DEPLOY_STAGING`.** Five `if:` lines; also the off switch.

## Decisions for the owner

| | Question | Recommended | Alternative |
| --- | --- | --- | --- |
| A | Where does Terraform run, and where does its state live? | By hand only, both environments; state `sops`-encrypted in the repository next to the secrets file (D2, D3) | Keep the staging apply in CI and the state bucket |
| B | Who may reach the Kubernetes API in production? | The internet, authenticated by the cluster, as in staging and every default Civo cluster (D4); `promote-production.yml` works today | Keep it closed; then production deploys by hand and `promote-production.yml` goes |
| C | Which architectures do the images serve? | What Civo runs (D6, S3) | Both |
| D | Origin certificates: cert-manager with Let's Encrypt, or Cloudflare Origin CA? | Pending research | |
| E | OpenBao (D29, B7b)? | Not yet, with a trigger (D17) | Keep the brief |
| F | Production's database nodes? | One, until Civo documents failover or B7c measures it (D18) | Three |

## Probes and their results (19 October 2026)

| Probe | Result | Bears on |
| --- | --- | --- |
| `gh run list --workflow infra.yml`, `ops.yml`, `promote-production.yml` | No run of any of the three, ever. The last pull request (#12) merged on 29 September; none since. GitHub has only Vercel's `Preview` and `Production` environments and no `DEPLOY_STAGING` variable | D1, D9, D5 |
| `grep` for `database.host`, `database.port`, `OPS_DATABASE_HOST`, `OPS_DATABASE_PORT` outside the ops bootstrap's own defaults and their README row | Nothing sets them | D11 |
| `grep` for `OPS_STORE`, `OPS_SECRETS_FILE` outside `infra/ops` | Nothing | D12 |
| `grep` for `microsoftClientId`, `googleClientId` | Only `charts/answerable/values.yaml` (empty) and the two `with` blocks in `id.yaml`; `init-secrets` writes `MICROSOFT_CLIENT_ID` into `id-env`, which `envFrom` loads | D13 |
| `grep` for `read_namespaces` | `[]` in both roots; a test "kept for a future diagnostic" | D8 |
| `grep` for `run-job`, `current-tag` outside `infra/pipeline/src` | `ops.yml`, `promote-production.yml` (the `resolve` job) and the READMEs | D5, D9 |
| `stack.test.ts` line 443 | "the default option alone refuses a host whose Ingress lost its reference, and the reference alone refuses without the default": the `default` TLSOption alone keeps every host closed | D14 |
| `helm template charts/platform` with `values-civo-staging.yaml` | 58 objects, none from `k8s-monitoring` (0 lines mention alloy, grafana or k8s-monitoring). Every Deployment and Job (Traefik, cert-manager, cainjector, webhook, startupapicheck) runs `runAsNonRoot`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `readOnlyRootFilesystem: true`, no `hostPort`, no `hostNetwork`: the restricted Pod Security Standard can be enforced on `platform` on Civo. The kind stack's Traefik uses `hostPort: 48443` and creates the namespace itself, unlabelled, so nothing changes there | D7 |
| `terraform providers schema` for `civo/civo` 1.3.3 | `civo_database` exposes `dns_endpoint`, `endpoint`, `private_ipv4`, `port`, `username`, `password`, `status` and no certificate attribute; trust on first use stays | K |
| `terraform providers schema` for `cloudflare/cloudflare` 5.27.0 | `cloudflare_origin_ca_certificate` takes `csr`, `hostnames`, `request_type` (`origin-ecc`), `requested_validity` (7 to 5475 days) and returns `certificate` and `expires_on`; the provider authenticates with `api_token` | Decision D |
| [Civo Learn, Deploying Llama 3 with Kubeflow](https://www.civo.com/learn/deploy-llama3-kubeflow-kubernetes-cpu-serverless) | "Civo's nodes are `amd64`, so the image has to be built for `linux/amd64`"; an arm64 image "fails to start with an exec-format error" | D6, S3 |
| [Cloudflare, Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/) | Create, list, get and revoke authenticate with "an API token with Permissions that include Zone-SSL and Certificates-Edit", a permission Terraform's token already holds; "compatible with Strict SSL mode"; wildcards and up to 200 names; "Cloudflare does not currently send expiration notifications"; the certificates "only encrypt traffic between Cloudflare and your origin server", which is the design's own invariant | Decision D |
| [Civo, Connecting to your PostgreSQL database](https://www.civo.com/docs/database/postgresql/connect) | "The default database name will be `postgres`" (the `database_admin_database` assumption holds); the example connection string carries no `sslmode`, and neither this page, the getting-started page nor the PostgreSQL page mentions SSL, TLS or a certificate | K: `verify-full` against Civo is unproved; the first apply must show whether the database serves TLS at all |
| [Civo, Getting started with Civo Database](https://www.civo.com/docs/database/getting-started) | "you can choose to run additional nodes", "always choose an odd number of nodes", "the database can continue to operate even if one or more nodes fail"; no mechanism, no price | D18 |
| The kind stack's certificates (`database.yaml`, `edge.yaml`, `charts/platform` `issuers.local`) | Seven cert-manager objects make the stack's three authorities (the stack CA, the database CA, the origin-pull stand-in CA) and four certificates; without cert-manager, `stack.ts` would make them with `openssl` (OpenSSL 3.6.2 here, 3.0 on the runners) | Decision D's cost |
| `wc -l` | `infra.yml` 152, `ops.yml` 90, `rehearse.ts` 359, `terraform.sh` 17, `backend.tf` 21 × 2, `modules/state` 152 with its test, `charts/platform/templates/issuers.yaml` 80, the `resolve` job 78, the `manifest` job 68, the `k8s-monitoring` values 38: 1,076 lines in whole files or whole jobs, before any partial edit | numbers |
