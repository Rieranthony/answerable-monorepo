# Civo infrastructure

Terraform for Answerable's two environments on Civo, each in its own Civo account in LON1 ([D28](../../docs/goals/civo-deploy/decisions.md)). One root per environment builds the network, the cluster, PostgreSQL 17, the load balancer's firewall and address, the state bucket, the platform chart, the deploy identity and the Cloudflare zone. The application itself is deployed by `helm upgrade` from GitHub Actions, not by Terraform.

## Layout

```
infra/
  check.ts                bun run infra:check
  .tflint.hcl             tflint's rules for every directory below
  .trivyignore            accepted trivy findings, each with its reason (none yet)
  .terraform-version      1.16.5
  civo/
    envs/staging/         the root for the answerable-staging account
    envs/production/      the root for the answerable-production account
    modules/              shared by both roots, never applied on their own
```

The two roots share every `.tf` file byte for byte except `backend.tf`; their sizes and names are in `terraform.tfvars`. `bun run infra:check` fails when the shared files drift apart.

| Module | What it creates | What its tests hold it to |
| --- | --- | --- |
| `network` | `civo_vpc_network` | A /16 to /28 inside 10.0.0.0/8, clear of the pod and service ranges |
| `cluster` | `civo_vpc_firewall`, `civo_kubernetes_cluster` | API (6443) from `allowed_api_cidrs`, plus the whole internet only when `api_open_to_internet` is true, which production refuses; from the private network only the node ports, the kubelet and Cilium's tunnel and health checks, never 6443 and never every port ([the ports and their sources](modules/cluster/README.md)); k3s with Cilium; Civo's Traefik removed, and the apply fails if it is installed anyway; at least two nodes |
| `database` | `civo_vpc_firewall`, `civo_database` | PostgreSQL 17; 5432 from the private network, not the nodes alone ([a known limit](#known-limits)); outbound to the private network only; 1, 3 or 5 nodes; `prevent_destroy`; the sensitive [administrator's URL](modules/database/README.md#the-administrators-url) with its login percent-encoded |
| `ingress-firewall` | `civo_vpc_firewall`, `civo_vpc_reserved_ip` | 443 from exactly Cloudflare's IPv4 ranges; no port 80; outbound to the private network only |
| `state` | `civo_object_store_credential`, `civo_object_store` | One 500 GB block, its own credential; `prevent_destroy` |
| `platform` | the `answerable` and `platform` namespaces, `helm_release.platform` | The restricted Pod Security Standard enforced on `answerable`; Traefik's Service names the firewall and claims the reserved address; Traefik's websecure entry point trusts `X-Forwarded-For` only from the ranges given; the chart's `values-civo-<environment>.yaml` must exist; `originPull.caPem` from `edge-ca/ca.pem`, which the full apply requires and targeted applies do not ([values Terraform sets](modules/platform/README.md)) |
| `deployer` | ServiceAccount `deployer`, its Roles and bindings, a token Secret | Manages only what `helm upgrade` of `charts/answerable` touches, in `answerable`, and reads no other namespace (`read_namespaces = []` in both roots; the variable stays for a future diagnostic and never grants Secrets); no wildcards, no `escalate`, `bind`, `impersonate` or `exec` |
| `edge` | three `cloudflare_dns_record`s, zone settings, origin pulls, two `cloudflare_ruleset`s | Proxied A records for exactly the three hostnames, each one label under the zone; Full (strict), TLS 1.2 minimum, HSTS; no browser check, no challenge and no cache (except `/assets/`) on those hostnames; never `www` or the apex |

Resources are named `answerable-<environment>-<what>`: `answerable-staging-cluster`, `answerable-production-database` and so on.

## Checks

```sh
bun run infra:check
```

No cloud account, credential or Docker is needed. In order: `helm lint --strict` and `helm template | kubeconform` for every chart and values file under `charts/` (skipped while `charts/` does not exist), `terraform fmt -check`, the two roots compared, `terraform init -backend=false` and `validate` in every directory (`-lockfile=readonly` in the roots), `terraform test` in every directory with tests, `tflint --recursive`, `trivy config` on `infra/` and `charts/` (HIGH and CRITICAL fail), and `actionlint` on the workflows. CI runs the same script in the `infra-check` job.

The tests plan each module against mocked providers (`terraform test`, `command = plan`): they need the providers downloaded and nothing else. Trivy ships no checks for Civo or Cloudflare resources, so the Terraform tests are where the firewall, naming and RBAC rules are enforced.

To run one module's tests:

```sh
cd infra/civo/modules/cluster && terraform init -backend=false && terraform test
```

`infra:check` keeps downloaded providers in `infra/.terraform/plugin-cache` (ignored by Git), or in `TF_PLUGIN_CACHE_DIR` when that is set. Terraform's plugin cache is not safe to share between runs at once.

**When a provider will not start on macOS.** If `terraform validate` fails with `Failed to read any lines from plugin's stdout`, run the provider binary by hand. A binary that exits 137 (killed) instead of printing `This binary is a plugin` was rewritten in place in a shared plugin cache, for example by two `terraform init` runs at once. macOS then kills the binary on start even though its signature still verifies. Copy it to a new file and move that over the old one, or delete the cache entry and run `terraform init` again. This was seen on 13 October 2026 with `civo/civo` 1.3.3. CI is the arbiter of `infra:check`.

## Credentials

Nothing secret is committed. Terraform reads these from the environment. Run it as `infra/civo/terraform.sh`, which hands the state credential to the S3 backend under the names that backend reads; plain `terraform` is enough for what never touches the state (`fmt`, `validate`, `test`):

| Variable | What | Where it is kept |
| --- | --- | --- |
| `CIVO_TOKEN` | The environment's Civo account API key | The owner, and the protected infra GitHub environment; never the deploy workflow ([D25](../../docs/goals/civo-deploy/decisions.md)) |
| `CLOUDFLARE_API_TOKEN` | A token scoped to the environment's zone only, with the permissions listed below | As `CIVO_TOKEN` |
| `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY` | The state bucket's credential (outputs `state_access_key_id`, `state_secret_access_key`) | As `CIVO_TOKEN` |
| `TF_VAR_allowed_api_cidrs` | The operators' own addresses for `kubectl`, for example `'["198.51.100.7/32"]'`. In production they are the only way in to the Kubernetes API. Empty by default, so automated runs with `-input=false` never stop to ask; staging plans without it, and production's plan fails until it is set | Not committed: an operator's address is personal data in a public repository |

The zone's Cloudflare token needs these permissions, on that zone only:

| Permission | Used by |
| --- | --- |
| **Zone > Zone > Read** | Looking the zone up by name: Terraform's `cloudflare_zone` data source and `bun run setup origin-pull` both call `GET /zones?name=…`, which accepts only Zone Read ([List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)) |
| Zone > DNS > Edit | The three service records |
| Zone > SSL and Certificates > Edit | Authenticated origin pulls |
| Zone > Zone Settings > Edit | SSL mode, HTTPS redirect, TLS versions, HSTS |
| **Zone > Config Rules > Edit** | The `http_config_settings` ruleset (no browser check or challenge) |
| **Zone > Cache Rules > Edit** | The `http_request_cache_settings` ruleset (no cache except `/assets/`) |

The last two are missing from B0's original list ([config rules](https://developers.cloudflare.com/rules/configuration-rules/create-api/), [cache rules](https://developers.cloudflare.com/cache/how-to/cache-rules/create-api/)). B0's Zone WAF Edit is not used by these roots.

**The state is a secret in its own right.** The Civo provider stores the database administrator's username and password in state; Terraform cannot keep them out. With `write_kubeconfig = true`, which this root needs, it also stores the cluster's admin kubeconfig. The state further holds the deployer's token and the state credential's secret key. Anyone who reads the state bucket owns the cluster and the database, so the bucket and the credential that opens it (`STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY`) are guarded like `CIVO_TOKEN`: only the owner and the protected infra environment hold them, never the deploy workflow. One output carries the database password: `database_admin_url`, sensitive, which `bun run setup init-secrets` copies into the encrypted `postgres-admin` Secret for the bootstrap Job. Another carries the cluster: `admin_kubeconfig`, sensitive, is the cluster-admin credential, held in state like the rest, for break-glass and diagnostics only (`bun run setup database-ca` reads the database's certificate through it from a pod). The deploy never uses it.

## Who can reach the Kubernetes API

Civo clusters always have a public API endpoint (6443). The cluster firewall decides who may reach it.

- **Production**: only `TF_VAR_allowed_api_cidrs`. The cluster module refuses `api_open_to_internet = true` and `0.0.0.0/0` there.
- **Staging**: `api_open_to_internet = true` in `terraform.tfvars`, so the firewall admits the whole internet on 6443 and the operators' addresses become redundant. The coordinator decided this on 13 October 2026, because GitHub-hosted runners publish 5,508 IPv4 ranges (`api.github.com/meta`, `actions`), too many for a firewall.
- **How the deploy workflow gets in.** It connects over TLS to the public endpoint (`KUBE_SERVER`) and verifies it against the cluster CA (`KUBE_CA`). It then authenticates with the `deployer` ServiceAccount token (`KUBE_TOKEN`), which can manage only what `helm upgrade` of `charts/answerable` touches in the `answerable` namespace and can read no other namespace. It holds no Civo key and no admin certificate.
- **What the open endpoint costs.** Staging's security rests on the cluster's own authentication alone. A leaked deployer token works from anywhere until it is rotated (see "Day two"), and any flaw in the Kubernetes API server is reachable from the internet. The admin kubeconfig exists only in state, read through the sensitive `admin_kubeconfig` output by whoever holds the state credential.
- **The follow-up.** A later brief closes the endpoint again, either with a GitOps controller that pulls from inside the cluster or with a Cloudflare tunnel to the API. Then set `api_open_to_internet = false`.

## Before the first apply

- The Civo account for the environment exists and `CIVO_TOKEN` is its API key ([B0](../../docs/goals/civo-deploy/briefs/b0.md)).
- The zone's Cloudflare token has the six permissions above, Zone Read, Config Rules Edit and Cache Rules Edit included.
- Bot Fight Mode is off in the zone (Security settings in the dashboard). The token cannot change it.
- The zone has no `http_config_settings` or `http_request_cache_settings` ruleset made by hand. Cloudflare allows one per zone and phase; import an existing one with `terraform import 'module.edge.cloudflare_ruleset.config' 'zones/<zone id>/<ruleset id>'`.
- `charts/platform` exists on the branch, with its `values-civo-<environment>.yaml` overlay. The full apply installs it, and the plan fails, naming the path, if the overlay is missing.
- **The origin-pull CA.** Its public certificate is committed at `envs/<env>/edge-ca/ca.pem` and the zone's client certificate is uploaded to Cloudflare, both by `bun run setup origin-pull`, before the full apply (step 6) and before traffic is expected ([D19](../../docs/goals/civo-deploy/decisions.md)).
  - Terraform passes the certificate to the platform chart as `originPull.caPem`, and the chart turns it into the Secret Traefik verifies Cloudflare against.
  - The full plan stops, naming the file and the command, while the certificate is missing, and refuses a file that is not a PEM certificate or that holds a private key.
  - Until the client certificate is uploaded, Cloudflare presents its shared one, which Traefik refuses.

## First apply

Per environment, from a trusted machine. Staging shown; production is the same in `envs/production`.

1. Set the credentials.

   ```sh
   cd infra/civo/envs/staging
   export CIVO_TOKEN=… CLOUDFLARE_API_TOKEN=…
   export TF_VAR_allowed_api_cidrs='["<your address>/32"]'
   ```

2. Create the state bucket with local state. The override file is ignored by Git.

   ```sh
   printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf
   terraform init
   terraform apply -target=module.state
   ```

3. Move the state into the bucket.

   ```sh
   export STATE_ACCESS_KEY_ID="$(terraform output -raw state_access_key_id)"
   export STATE_SECRET_ACCESS_KEY="$(terraform output -raw state_secret_access_key)"
   rm backend_override.tf
   ../../terraform.sh init -migrate-state
   ../../terraform.sh state list   # now read from the bucket
   rm terraform.tfstate terraform.tfstate.backup
   ```

4. Prove the state lock. Start `../../terraform.sh plan` in two shells at once; the second must stop with `Error acquiring the state lock`. If instead the first plan fails writing `staging.tfstate.tflock` (Civo rejecting S3 conditional writes), set `use_lockfile = false` in both `backend.tf` files, record it in [`progress.md`](../../docs/goals/civo-deploy/progress.md), and keep to one operator at a time, CI included.

5. Create the cluster before anything that runs inside it. The kubernetes and helm providers are configured from the cluster's kubeconfig, which does not exist until the cluster does.

   ```sh
   ../../terraform.sh apply -target=module.cluster -target=module.database -target=module.ingress_firewall
   ```

6. Apply the rest: the namespaces, the platform chart, the deployer and the Cloudflare zone. This step needs `edge-ca/ca.pem` committed; until `bun run setup origin-pull --environment <env> --zone <zone>` has written it, the plan stops and names that command, while step 5 does not need it.

   ```sh
   ../../terraform.sh apply
   ```

7. Hand over the deploy credentials. On the environment's GitHub environment, set `KUBE_SERVER`, `KUBE_CA` and `KUBE_TOKEN`, and on the infra environment the state credential:

   ```sh
   ../../terraform.sh output -raw kube_server
   ../../terraform.sh output -raw kube_ca
   ../../terraform.sh output -raw kube_token
   ```

8. Pin the cluster version: read it with `civo kubernetes show answerable-staging-cluster` and set `kubernetes_version` in `terraform.tfvars`.

A cluster that is ever replaced needs step 5 again: the providers cannot be configured from a cluster that is being recreated in the same plan.

**With the setup commands.** `bun run setup` runs these steps for you without printing a secret; the whole first run, in order, is in [`infra/setup/README.md`](../setup/README.md).

| Step | Command |
| --- | --- |
| 2, 3, 5 and 6 | `first-apply --environment <env>`, which prints step 4 as a check, stops before step 6 until both CA files exist, and continues with `--resume` |
| Before 6 | `origin-pull --environment <env> --zone <zone>` writes `envs/<env>/edge-ca/ca.pem` and uploads the zone's origin-pull certificate; `database-ca --environment <env>` writes `envs/<env>/database-ca.pem` |
| 7 | `publish-env --environment <env>` |

## What the first apply must confirm

Each of these could not be proved without a Civo account. Record the answer in [`progress.md`](../../docs/goals/civo-deploy/progress.md) and fix the code where it differs.

| Question | How to check | If it differs |
| --- | --- | --- |
| Does Civo's object store honour `use_lockfile`? | Step 4 | `use_lockfile = false`, one operator at a time |
| Is Traefik absent? The root removes `Traefik-v2-nodeport`, the name Civo's CLI documentation uses | Automatic: a postcondition fails the apply when the cluster reports a Traefik application | Correct the name in `modules/cluster/main.tf` and recreate the cluster, or `civo kubernetes applications remove` |
| Does the load balancer reach the ingress node ports through the cluster firewall? It admits TCP 30000-32767 from the private network | `curl` through Cloudflare once the records are live | Find the load balancer's source address and admit it on the node ports |
| Does the load balancer work with outbound limited to the private network? | As above | Widen its egress rule |
| Do production's nodes join and stay Ready with 6443 closed to the private network? k3s wants its server's 6443 reachable by every node; Civo runs the control plane and does not say whether nodes reach it through this firewall | `kubectl get nodes` after the cluster step, in production (staging's open API hides the question) | Bring it back to the coordinator: admitting 6443 from the network conflicts with 6443 answering the two variables only |
| Do `kubectl logs` and `exec` work? The control plane reaches each kubelet on 10250, admitted from the private network only | `kubectl logs` on any pod | Admit 10250 from the control plane's address |
| Does Civo's Cilium tunnel over VXLAN (UDP 8472)? | `kubectl -n kube-system exec ds/cilium -- cilium status` | Admit Geneve (UDP 6081), or nothing for native routing |
| What address does Traefik see? No PROXY protocol is configured, so it should be the load balancer's private address, which is why the private range is in Traefik's `trustedIPs` and in `trusted_proxy_cidrs` | Read `X-Forwarded-For` at ID through the audit API | Enable `kubernetes.civo.com/loadbalancer-enable-proxy-protocol` with Traefik's `ports.websecure.proxyProtocol.trustedIPs` |
| Is the pod range k3s's default 10.42.0.0/16? | `kubectl get nodes -o jsonpath='{.items[*].spec.podCIDR}'` | Set `pod_cidr` |
| Which certificate does the database present, and does it name the private address that `database_admin_url` and the services use? `verify-full` needs its CA (`bun run setup database-ca`) and a matching host | `openssl s_client -starttls postgres -connect <host>:5432` from a pod; the first `bootstrap` Job connects with `verify-full` | Switch the host in `modules/database` (output `admin_url`) and the services to `database_dns_endpoint` |
| Is Civo's default database `postgres`? The `database_admin_url` output assumes it (variable `database_admin_database`) | `civo database credential answerable-staging-database`; the first `bootstrap` Job ([B3](../../docs/goals/civo-deploy/briefs/b3.md)) connects with the URL | Set `database_admin_database` in `terraform.tfvars`, then rerun `bun run setup init-secrets --force` |
| Do standbys and backups work with the database's outbound traffic limited to the private network? | The restore drill ([B7](../../docs/goals/civo-deploy/briefs/b7.md)) | Widen the database firewall's egress |
| Does the platform chart accept the values Terraform sets (`traefik.service.annotations`, `traefik.ports.websecure.forwardedHeaders.trustedIPs`)? | `helm get values platform -n platform`; `kubectl -n platform get svc` shows the reserved address | Match the keys in `modules/platform/main.tf` to the chart |

## Day two

- **Plan and apply**: `../../terraform.sh plan` and `../../terraform.sh apply` in the environment's root with the credentials above. A change in Cloudflare's published ranges shows as a plan diff (output `cloudflare_ranges_etag`).
- **Rotate the deployer token**: `../../terraform.sh apply -replace=module.deployer.kubernetes_secret_v1.token`, then update `KUBE_TOKEN`. Deleting the Secret revokes the old token.
- **Change who reaches the API**: change `TF_VAR_allowed_api_cidrs` (or, in staging, `api_open_to_internet`) and apply.
- **Destroy**: the database and the state bucket carry `prevent_destroy`; removing it is a reviewed change.

## Known limits

- **PostgreSQL admits the private network, not the cluster's nodes alone.** Civo firewall rules match CIDRs. Node addresses come from the network and change as the pool changes, and no Civo resource puts a node pool in a range of its own (`civo_vpc_subnet` takes no range, and the cluster and node pool take a network, nothing narrower). By policy the network holds only this environment's nodes, the load balancer Traefik's Service creates (which forwards only 443 to the node port and cannot open a connection to 5432), and the database with its standbys. Anything else that joined could reach 5432, but would still need a per-database login over `verify-full` TLS. Details in [`modules/database/README.md`](modules/database/README.md).

## Not yet

- **A closed Kubernetes API that CI can still reach.** Staging opens its API to the internet in the meantime (see "Who can reach the Kubernetes API"). Production's API admits the listed addresses only. GitHub-hosted runners can therefore neither deploy production nor run a CI `terraform apply` of its root, because the kubernetes and helm providers talk to the API. Both wait for the GitOps or tunnel follow-up.
- **Bot Fight Mode as code.** `cloudflare_bot_management` can turn it off, but the token would need Bot Management Edit; it stays a dashboard toggle.
- **Roots for other clouds.** Written in a later brief.
