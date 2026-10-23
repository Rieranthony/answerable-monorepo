# Civo infrastructure

Terraform for Answerable's two environments on Civo, each in its own Civo account in LON1 ([D28](../../docs/goals/civo-deploy/decisions.md)). One root, this directory, builds either environment: the network, the cluster, PostgreSQL 17, the load balancer's firewall and address, the platform chart and the objects the application reads, the deploy identity, the Cloudflare zone with its certificates, and the GitHub environment's rules and deploy secrets. Terraform runs from GitHub Actions for both environments; no step needs a person at a terminal. The application itself is deployed by `helm upgrade` from the deploy workflows, not by Terraform.

## Layout

```
infra/
  check.ts                    bun run infra:check
  .tflint.hcl                 tflint's rules for every directory below
  .terraform-version          1.16.5
  civo/
    *.tf                      the root, shared by both environments
    .terraform.lock.hcl       provider hashes for darwin_arm64, linux_amd64 and linux_arm64
    envs/staging.tfvars       what differs per environment: sizes, node counts, zone, hostnames, network range
    envs/production.tfvars
    tests/staging.tftest.hcl  the root's tests, one file per environment, run with that environment's values
    tests/production.tftest.hcl
    terraform.sh              terraform for one environment
    modules/                  used by the root, never applied on their own
```

| Module | What it creates | What its tests hold it to |
| --- | --- | --- |
| `network` | `civo_vpc_network` | A /16 to /28 inside 10.0.0.0/8, clear of the pod and service ranges |
| `cluster` | `civo_vpc_firewall`, `civo_kubernetes_cluster` | The API (6443) from `0.0.0.0/0` in one rule, [authenticated by the cluster](#who-can-reach-the-kubernetes-api); from the private network only the node ports, the kubelet and Cilium's tunnel and health checks, never 6443 and never every port ([the ports and their sources](modules/cluster/README.md)); k3s with Cilium; Civo's Traefik removed, and the apply fails if it is installed anyway; at least two nodes |
| `database` | `civo_vpc_firewall`, `civo_database` | PostgreSQL 17; 5432 from the private network, not the nodes alone ([a known limit](#known-limits)); outbound to the private network only; 1, 3 or 5 nodes; `prevent_destroy`; the sensitive [administrator's URL](modules/database/README.md#the-administrators-url) on Civo's default database `postgres`, its login percent-encoded |
| `ingress-firewall` | `civo_vpc_firewall`, `civo_vpc_reserved_ip` | 443 from exactly Cloudflare's IPv4 ranges; no port 80; outbound to the private network only |
| `edge` | three `cloudflare_dns_record`s, zone settings, origin pulls, two `cloudflare_ruleset`s, [the certificates](#certificates) | Proxied A records for exactly the three hostnames, each one label under the zone; Full (strict), TLS 1.2 minimum, HSTS; no browser check, no challenge and no cache (except `/assets/`) on those hostnames; never `www` or the apex; the origin-pull CA, its client certificate (`client_auth`) and their upload; the Origin CA request for exactly the three hostnames, `origin-ecc`, 5475 days |
| `platform` | the `answerable` and `platform` namespaces, ConfigMap `trusted-proxies`, Secrets `postgres-admin` and `origin-tls`, `helm_release.platform` | The restricted Pod Security Standard enforced on both namespaces; the three objects' names, keys, type and namespace; Traefik's Service names the firewall and claims the reserved address; Traefik's websecure entry point trusts `X-Forwarded-For` only from the ranges given; the chart's `values-civo-<environment>.yaml` must exist; `originPull.caPem` from the edge module ([what Terraform writes](modules/platform/README.md)) |
| `deployer` | ServiceAccount `deployer`, its Role and binding, a token Secret | Manages only what `helm upgrade` of `charts/answerable` and the deploy touch, in `answerable`; no wildcards, no `escalate`, `bind`, `impersonate` or `exec`; Kubernetes' own API groups only |
| `github` | three environment secrets | Writes `KUBE_SERVER`, `KUBE_CA` and `KUBE_TOKEN` into the environment the owner created, and nothing else; the environment's policy and reviewer are the owner's ([the GitHub environment](#the-github-environment)) |

Resources are named `answerable-<environment>-<what>`: `answerable-staging-cluster`, `answerable-production-database` and so on.

## Running Terraform

Every command goes through `terraform.sh`, from any directory, with the environment first:

```sh
infra/civo/terraform.sh staging init -input=false
infra/civo/terraform.sh staging plan -input=false
infra/civo/terraform.sh production apply -input=false -auto-approve
```

- **`init`** gets the environment's state, `answerable-<environment>-tfstate/<environment>.tfstate`, which [`backend.tf`](backend.tf) leaves out, and `-reconfigure`, so that switching environment in one checkout never offers to copy one state into the other.
- **`plan`, `apply`, `destroy`, `import` and `refresh`** get `-var-file=envs/<environment>.tfvars`. An `apply` of a saved plan does not: the plan holds its variables and Terraform refuses new ones.
- **The state credential** arrives as `STATE_ACCESS_KEY_ID` and `STATE_SECRET_ACCESS_KEY` and is handed to the S3 backend under the only names it reads, for Terraform's process alone.
- **Paths** in arguments are relative to `infra/civo`, where Terraform runs. The script prints nothing of its own but a usage error.

The deploy workflows run Terraform for their environment; nothing here is run from a laptop.

## Checks

```sh
bun run infra:check
```

No cloud account, credential or Docker is needed. In order: `helm lint --strict` and `helm template | kubeconform` for every chart and values file under `charts/`, `terraform fmt -check`, `terraform init -backend=false` and `validate` in every directory (`-lockfile=readonly` in the root), `terraform test` in every directory with tests, `tflint --recursive`, `trivy config` on `infra/` and `charts/` (HIGH and CRITICAL fail), and `actionlint` on the workflows. CI runs the same script in the `infra-check` job.

The tests plan each module against mocked providers (`terraform test`, `command = plan`): they need the providers downloaded and nothing else. Trivy ships no checks for Civo or Cloudflare resources, so the Terraform tests are where the firewall, naming, PKI and RBAC rules are enforced. The root's tests run once per environment with that environment's values, and `infra:check` fails if an `envs/<environment>.tfvars` has no `tests/<environment>.tftest.hcl` or the reverse.

To run one module's tests, or the root's for one environment:

```sh
cd infra/civo/modules/cluster && terraform init -backend=false && terraform test
cd infra/civo && terraform init -backend=false && terraform test -filter=tests/staging.tftest.hcl -var-file=envs/staging.tfvars
```

`infra:check` keeps downloaded providers in `infra/.terraform/plugin-cache` (ignored by Git), or in `TF_PLUGIN_CACHE_DIR` when that is set. Terraform's plugin cache is not safe to share between runs at once.

**When a provider will not start on macOS.** If `terraform validate` fails with `Failed to read any lines from plugin's stdout`, run the provider binary by hand. A binary that exits 137 (killed) instead of printing `This binary is a plugin` was rewritten in place in a shared plugin cache, for example by two `terraform init` runs at once. macOS then kills the binary on start even though its signature still verifies. Delete `infra/.terraform/plugin-cache` and run the check again. This was seen on 13 October 2026 with `civo/civo` 1.3.3. CI is the arbiter of `infra:check`.

## Credentials

Nothing secret is committed and no Terraform variable holds a secret. Terraform reads these from its process environment, which the workflow fills from the GitHub environment of the same name (`staging` or `production`):

| Variable | What | Who puts it in the GitHub environment |
| --- | --- | --- |
| `CIVO_TOKEN` | The environment's Civo account API key | The owner, once |
| `CLOUDFLARE_API_TOKEN` | A token scoped to the environment's zone only, with the permissions listed below | The owner, once |
| `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY` | The state bucket's credential; `terraform.sh` hands it to the S3 backend | The bootstrap workflow: it creates the credential and the bucket with the Civo CLI, naming the region on every call (the CLI reads no region variable and defaults to NYC1), reads both keys from Civo's API (the CLI's JSON for the secret is empty) and lists the bucket with them at the region's endpoint, `infra/civo/check-state.sh`, before it declares success |
| `GITHUB_TOKEN` | The environment's `GH_SECRETS_TOKEN`, under the name the GitHub provider reads, with the permissions listed below | The owner pastes `GH_SECRETS_TOKEN` once; the workflow maps it |

The zone's Cloudflare token needs these permissions, on that zone only:

| Permission | Used by |
| --- | --- |
| **Zone > Zone > Read** | Looking the zone up by name: the `cloudflare_zone` data source calls `GET /zones?name=…`, which accepts only Zone Read ([List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)) |
| Zone > DNS > Edit | The three service records |
| Zone > SSL and Certificates > Edit | Authenticated origin pulls (the setting and the zone's client certificate), and the Origin CA certificate, whose create, get and revoke calls ask for exactly this permission ([Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)) |
| Zone > Zone Settings > Edit | SSL mode, HTTPS redirect, TLS versions, HSTS |
| **Zone > Config Rules > Edit** | The `http_config_settings` ruleset (no browser check or challenge) |
| **Zone > Cache Rules > Edit** | The `http_request_cache_settings` ruleset (no cache except `/assets/`) |

The last two are the ones easiest to miss ([config rules](https://developers.cloudflare.com/rules/configuration-rules/create-api/), [cache rules](https://developers.cloudflare.com/cache/how-to/cache-rules/create-api/)). Zone WAF Edit is not used.

`GH_SECRETS_TOKEN` is a fine-grained personal access token for this repository alone, with an expiry in the owner's calendar. GitHub's [fine-grained permission tables](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) name what the github module's calls need:

| Repository permission | Used by |
| --- | --- |
| Environments: Read and write | The environment's secrets: the public key they are encrypted with, and `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN`; the bootstrap workflow's `gh secret set` uses the same permission |
| Metadata: Read | Reading the repository; GitHub adds it to every token |

Nothing more. Managing the environment itself and its deployment policies would need Administration: Read and write, which also lets a token change the repository's settings, rename it or delete it; so the environment's policy and reviewer are set by the owner once, at creation, and Terraform never touches them.

**The state is a secret in its own right.** Anyone who reads the state bucket owns the cluster and the database, so the bucket and its credential are guarded like `CIVO_TOKEN`: only the GitHub environment holds them. Terraform cannot keep these out of state:

- **The database administrator's username and password**, stored by the Civo provider. One output carries them, `database_admin_url`, sensitive, for break-glass only: the `postgres-admin` Secret already gives them to the bootstrap Job.
- **The cluster's admin kubeconfig.** `write_kubeconfig = true`, which the root needs to configure the kubernetes and helm providers, stores it. The sensitive `admin_kubeconfig` output is the cluster-admin credential, for break-glass and diagnostics only. No workflow uses it.
- **The deployer's token**, which is also `KUBE_TOKEN`.
- **The edge's three private keys**: the origin-pull CA's, its client certificate's and the origin certificate's.
- **The plaintext of `KUBE_SERVER`, `KUBE_CA` and `KUBE_TOKEN`**, which the GitHub provider encrypts only on the way to GitHub.

## Who can reach the Kubernetes API

Civo clusters always have a public API endpoint (6443). The cluster firewall admits it from `0.0.0.0/0`, as every Civo cluster does by default, and the cluster authenticates every request. This resolves D30: GitHub-hosted runners publish 5,508 IPv4 ranges (`api.github.com/meta`, `actions`), too many for a firewall, and both environments' Terraform and deploys run on them.

- **How the deploy workflow gets in.** It connects over TLS to the public endpoint (`KUBE_SERVER`) and verifies it against the cluster CA (`KUBE_CA`). It then authenticates with the `deployer` ServiceAccount token (`KUBE_TOKEN`), which can manage only what the deploy touches in the `answerable` namespace and can read no other namespace. It holds no Civo key and no admin certificate.
- **How Terraform gets in.** With the admin kubeconfig from its own state, to install the platform chart, the namespaces and the objects in them.
- **What the open endpoint costs.** The cluster's security rests on its own authentication. A leaked deployer token works from anywhere until it is rotated (see "Day two"), and any flaw in the Kubernetes API server is reachable from the internet.

## The GitHub environment

The owner creates each environment (`staging`, `production`) by hand, once, before Terraform first runs ([`infra/README.md`](../README.md#first-run)): its deployment policy admits the branch `main` and the tags `<environment>/*` and nothing else; production names the owner as its required reviewer; and the five secrets are pasted in: `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `GH_SECRETS_TOKEN`. Terraform's `github` module writes one thing into it:

- **The cluster's address and credential**: `KUBE_SERVER` (the cluster's `api_endpoint`), `KUBE_CA` (the cluster CA, PEM, from the deployer's token Secret) and `KUBE_TOKEN` (the deployer's token). A new cluster or a rotated token reaches GitHub in the same apply.

## Certificates

The edge module makes two certificate chains, and keeps every key in state only: no person and no file holds one.

| Certificate | Made by | Key and lifetime | Goes to |
| --- | --- | --- | --- |
| The origin-pull CA, `Answerable origin-pull CA (<zone>)` | `tls_self_signed_cert` | ECDSA P-256; ten years; signs certificates and revocation lists only | `originPull.caPem` of the platform chart, which renders the Secret `cloudflare-origin-pull-ca` that Traefik's `default` TLS option verifies clients against |
| The client certificate, `cloudflare-origin-pull.<zone>` | `tls_locally_signed_cert`, signed by the CA above | ECDSA P-256; five years; client authentication only | Cloudflare, as the zone's [zone-level authenticated origin pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/zone-level/) certificate (`cloudflare_authenticated_origin_pulls_certificate`), presented on every proxied request |
| The origin certificate, for the three hostnames | `cloudflare_origin_ca_certificate`, from Cloudflare's [Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/) and a `tls_cert_request` | ECDSA P-256, `origin-ecc`; 5475 days, Cloudflare's longest | The Secret `origin-tls` the three Ingresses serve; Cloudflare alone trusts it, which is all Full (strict) needs |

Together they keep the origin closed to everything but this zone's Cloudflare proxy: the load balancer admits only Cloudflare's ranges, and Traefik admits only a client certificate the origin-pull CA signed. In the other direction, Full (strict) makes Cloudflare refuse an origin whose certificate it does not trust for the hostname.

**Rotation** is `terraform apply -replace` on the key, through the workflow's Terraform step:

| To rotate | Arguments |
| --- | --- |
| The origin-pull CA and the client certificate it signs | `apply -replace=module.edge.tls_private_key.origin_pull_ca` |
| The client certificate alone | `apply -replace=module.edge.tls_private_key.origin_pull_client` |
| The origin certificate | `apply -replace=module.edge.tls_private_key.origin` |

The apply uploads or issues the new certificate before it deletes the old one (`create_before_destroy`; deleting an Origin CA certificate revokes it). There is still a short interruption while Cloudflare and Traefik switch: Cloudflare presents the newest client certificate as soon as it is uploaded, and Traefik trusts a new CA, or serves a new origin certificate, only once the platform release or the `origin-tls` Secret is updated a moment later.

**Expiry.** Nothing renews these certificates by itself. Cloudflare sends no expiry notice for Origin CA certificates; the output `origin_certificate_expires_on` says when the origin certificate ends, fifteen years after the first apply.

## Before the first apply

- The Civo account for the environment exists and its API key is the environment's `CIVO_TOKEN`.
- The zone's Cloudflare token has the six permissions above.
- Bot Fight Mode is off in the zone (Security settings in the dashboard). The token cannot change it.
- The zone has no `http_config_settings` or `http_request_cache_settings` ruleset made by hand. Cloudflare allows one per zone and phase; import an existing one with `infra/civo/terraform.sh <environment> import 'module.edge.cloudflare_ruleset.config' 'zones/<zone id>/<ruleset id>'`.
- The GitHub environment exists with its five secrets, its deployment policy (`main` and the tags `<environment>/*`) and, for production, the owner as required reviewer ([the GitHub environment](#the-github-environment)).
- The bootstrap workflow has run for the environment: the state bucket exists and `STATE_ACCESS_KEY_ID` and `STATE_SECRET_ACCESS_KEY` are in the GitHub environment.

## First apply

The deploy workflow runs it, in two steps, every time:

```sh
infra/civo/terraform.sh <environment> init -input=false
infra/civo/terraform.sh <environment> apply -input=false -auto-approve -target=module.cluster -target=module.database -target=module.ingress_firewall
infra/civo/terraform.sh <environment> apply -input=false -auto-approve
```

The kubernetes and helm providers are configured from the cluster's kubeconfig, which does not exist until the cluster does, so the targeted apply creates the cluster, the database and the firewalls first. The full apply then creates the rest: the edge and its certificates, the namespaces, the three objects, the platform chart, the deployer and the GitHub environment's rules and secrets. Afterwards both steps are no-ops unless something changed; a cluster that is ever replaced needs the targeted step again, which is why it always runs.

Then pin the cluster's version: write the version the apply created the cluster with into `kubernetes_version` in `envs/<environment>.tfvars`, in a commit.

## What the first apply must confirm

Each of these could not be proved without a Civo account. Record the answer in [`progress.md`](../../docs/goals/civo-deploy/progress.md) and fix the code where it differs.

| Question | How to check | If it differs |
| --- | --- | --- |
| Does Civo's object store honour `use_lockfile`? | The first `init` and `apply`: a refused write of `<environment>.tfstate.tflock` fails them | `use_lockfile = false` in `backend.tf`, and rely on the workflows never running two applies of one environment at once |
| Is Traefik absent? The root removes `Traefik-v2-nodeport`, the name Civo's CLI documentation uses | Automatic: a postcondition fails the apply when the cluster reports a Traefik application | Correct the name in `modules/cluster/main.tf` and recreate the cluster |
| Does Cloudflare accept the ECDSA client certificate and key for zone-level origin pulls? Its examples use RSA | The full apply creates `cloudflare_authenticated_origin_pulls_certificate` or fails | Make `tls_private_key.origin_pull_client` RSA 2048 |
| Does the load balancer reach the ingress node ports through the cluster firewall? It admits TCP 30000-32767 from the private network | The smoke test through Cloudflare once the records are live | Find the load balancer's source address and admit it on the node ports |
| Does the load balancer work with outbound limited to the private network? | As above | Widen its egress rule |
| Do `kubectl logs` and `exec` work? The control plane reaches each kubelet on 10250, admitted from the private network only | The deploy's logs of a failed Job | Admit 10250 from the control plane's address |
| Does Civo's Cilium tunnel over VXLAN (UDP 8472)? | Pods on different nodes reach each other, for example the Toolbox calling ID through its Service | Admit Geneve (UDP 6081), or nothing for native routing |
| What address does Traefik see? No PROXY protocol is configured, so it should be the load balancer's private address, which is why the private range is in Traefik's `trustedIPs` and in the `trusted-proxies` ConfigMap | Read `X-Forwarded-For` at ID through the audit API | Enable `kubernetes.civo.com/loadbalancer-enable-proxy-protocol` with Traefik's `ports.websecure.proxyProtocol.trustedIPs` |
| Is the pod range k3s's default 10.42.0.0/16? | A node's `spec.podCIDR` | Set `pod_cidr` |
| Does the Civo database serve TLS at all? Civo's pages never mention SSL, TLS or a certificate | The first `bootstrap` Job: it sends PostgreSQL's SSLRequest, fetches the certificate chain on first use and logs its fingerprint, or fails | Stop and bring it back to the owner: every database connection is `verify-full` by design |
| Which certificate does the database present, and does it name the private address that `postgres-admin` and the services use? | The first `bootstrap` Job connects with `verify-full` against the CA it stored | Switch the host in `modules/database` (output `admin_url`) and the services to the database's `dns_endpoint` |
| Do standbys and backups work with the database's outbound traffic limited to the private network? | The restore drill ([B7](../../docs/goals/civo-deploy/briefs/b7.md)) | Widen the database firewall's egress |
| Does the platform chart accept the values Terraform sets (`originPull.caPem`, `traefik.service.annotations`, `traefik.ports.websecure.forwardedHeaders.trustedIPs`)? | The full apply's `helm_release.platform` succeeds; the smoke test reaches the reserved address | Match the keys in `modules/platform/main.tf` to the chart |

## Day two

Every change is a commit and a workflow run; these are the Terraform arguments the run needs.

- **Plan and apply**: `infra/civo/terraform.sh <environment> plan`, then `apply`. A change in Cloudflare's published ranges shows as a plan diff.
- **Rotate the deployer token**: `apply -replace=module.deployer.kubernetes_secret_v1.token`. The same apply writes the new `KUBE_TOKEN` to GitHub; deleting the old Secret revokes the old token.
- **Rotate a certificate**: see [Certificates](#certificates).
- **Destroy**: the database and the GitHub environment carry `prevent_destroy`; removing it is a reviewed change. The state bucket belongs to the bootstrap workflow, not to this root.

## Known limits

- **PostgreSQL admits the private network, not the cluster's nodes alone.** Civo firewall rules match CIDRs. Node addresses come from the network and change as the pool changes, and no Civo resource puts a node pool in a range of its own (`civo_vpc_subnet` takes no range, and the cluster and node pool take a network, nothing narrower). By policy the network holds only this environment's nodes, the load balancer Traefik's Service creates (which forwards only 443 to the node port and cannot open a connection to 5432), and the database. Anything else that joined could reach 5432, but would still need a per-database login over `verify-full` TLS. Details in [`modules/database/README.md`](modules/database/README.md).
- **Production's database runs one node.** Civo documents failover for additional nodes only as "can continue to operate even if one or more nodes fail"; the count rises once brief B7c has measured it.

## Not yet

- **Bot Fight Mode as code.** `cloudflare_bot_management` can turn it off, but the token would need Bot Management Edit; it stays a dashboard toggle.
