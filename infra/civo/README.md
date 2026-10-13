# Civo infrastructure

Terraform for Answerable's two environments on Civo, each in its own Civo account in LON1 ([D28](../../docs/goals/aws-deploy/decisions.md)). One root per environment builds the network, the cluster, PostgreSQL 17, the load balancer's firewall and address, the state bucket, the platform chart, the deploy identity and the Cloudflare zone. The application itself is deployed by `helm upgrade` from GitHub Actions, not by Terraform.

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
| `cluster` | `civo_vpc_firewall`, `civo_kubernetes_cluster` | API (6443) from `allowed_api_cidrs` only, never `0.0.0.0/0`; the private network's own range; nothing else inbound; k3s with Cilium; Civo's Traefik removed; at least two nodes |
| `database` | `civo_vpc_firewall`, `civo_database` | PostgreSQL 17; 5432 from the private network only; outbound to the private network only; 1, 3 or 5 nodes; `prevent_destroy` |
| `ingress-firewall` | `civo_vpc_firewall`, `civo_vpc_reserved_ip` | 443 from exactly Cloudflare's IPv4 ranges; no port 80; outbound to the private network only |
| `state` | `civo_object_store_credential`, `civo_object_store` | One 500 GB block, its own credential; `prevent_destroy` |
| `platform` | the `answerable` and `platform` namespaces, `helm_release.platform` | The restricted Pod Security Standard enforced on `answerable`; the ingress Service names the firewall and claims the reserved address; ingress-nginx trusts `X-Forwarded-For` only from the ranges given |
| `deployer` | ServiceAccount `deployer`, its Roles and bindings, a token Secret | Manages only what `helm upgrade` of `charts/answerable` touches, in `answerable`; reads `platform` without its Secrets; no wildcards, no `escalate`, `bind`, `impersonate` or `exec` |
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

## Credentials

Nothing secret is committed. Terraform reads these from the environment:

| Variable | What | Where it is kept |
| --- | --- | --- |
| `CIVO_TOKEN` | The environment's Civo account API key | The owner, and the protected infra GitHub environment; never the deploy workflow ([D25](../../docs/goals/aws-deploy/decisions.md)) |
| `CLOUDFLARE_API_TOKEN` | A token scoped to the environment's zone only: DNS Edit, SSL and Certificates Edit, Zone Settings Edit, Config Rules Edit, Cache Rules Edit | As `CIVO_TOKEN` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The state bucket's credential (outputs `state_access_key_id`, `state_secret_access_key`) | As `CIVO_TOKEN` |
| `TF_VAR_allowed_api_cidrs` | The addresses allowed to reach the Kubernetes API, for example `'["198.51.100.7/32"]'` | Not committed: an operator's address is personal data in a public repository |

The state holds secrets the providers put there: the cluster's admin kubeconfig (`write_kubeconfig`), the database administrator's password, the deployer's token and the state credential. It lives only in the environment's private bucket.

## Before the first apply

- The Civo account for the environment exists and `CIVO_TOKEN` is its API key ([B0](../../docs/goals/aws-deploy/briefs/b0.md)).
- The zone's Cloudflare token has the five permissions above. The rulesets need Config Rules Edit and Cache Rules Edit.
- Bot Fight Mode is off in the zone (Security settings in the dashboard). The token cannot change it.
- The zone has no `http_config_settings` or `http_request_cache_settings` ruleset made by hand. Cloudflare allows one per zone and phase; import an existing one with `terraform import 'module.edge.cloudflare_ruleset.config' 'zones/<zone id>/<ruleset id>'`.
- `charts/platform` exists on the branch: the full apply installs it.
- The zone's origin-pull certificate is uploaded before traffic is expected ([D19](../../docs/goals/aws-deploy/decisions.md)). Until then Cloudflare presents its shared certificate, which ingress-nginx refuses.

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
   export AWS_ACCESS_KEY_ID="$(terraform output -raw state_access_key_id)"
   export AWS_SECRET_ACCESS_KEY="$(terraform output -raw state_secret_access_key)"
   rm backend_override.tf
   terraform init -migrate-state
   terraform state list   # now read from the bucket
   rm terraform.tfstate terraform.tfstate.backup
   ```

4. Prove the state lock. Start `terraform plan` in two shells at once; the second must stop with `Error acquiring the state lock`. If instead the first plan fails writing `staging.tfstate.tflock` (Civo rejecting S3 conditional writes), set `use_lockfile = false` in both `backend.tf` files, record it in [`progress.md`](../../docs/goals/aws-deploy/progress.md), and keep to one operator at a time, CI included.

5. Create the cluster before anything that runs inside it. The kubernetes and helm providers are configured from the cluster's kubeconfig, which does not exist until the cluster does.

   ```sh
   terraform apply -target=module.cluster -target=module.database -target=module.ingress_firewall
   ```

6. Apply the rest: the namespaces, the platform chart, the deployer and the Cloudflare zone.

   ```sh
   terraform apply
   ```

7. Hand over the deploy credentials. On the environment's GitHub environment, set `KUBE_SERVER`, `KUBE_CA` and `KUBE_TOKEN`, and on the infra environment the state credential:

   ```sh
   terraform output -raw kube_server
   terraform output -raw kube_ca
   terraform output -raw kube_token
   ```

8. Pin the cluster version: read it with `civo kubernetes show answerable-staging-cluster` and set `kubernetes_version` in `terraform.tfvars`.

A cluster that is ever replaced needs step 5 again: the providers cannot be configured from a cluster that is being recreated in the same plan.

## What the first apply must confirm

Each of these could not be proved without a Civo account. Record the answer in [`progress.md`](../../docs/goals/aws-deploy/progress.md) and fix the code where it differs.

| Question | How to check | If it differs |
| --- | --- | --- |
| Does Civo's object store honour `use_lockfile`? | Step 4 | `use_lockfile = false`, one operator at a time |
| Is Traefik absent? The marketplace name is `traefik2-nodeport` | `kubectl get pods -A`; `civo kubernetes show` lists the installed applications | Correct the name in `modules/cluster/main.tf` |
| Does the load balancer reach the ingress node ports through the cluster firewall? The firewall admits the private network's range for this | `curl` through Cloudflare once the records are live | Admit the node port range from the load balancer's private address |
| Does the load balancer work with outbound limited to the private network? | As above | Widen its egress rule |
| What address does ingress-nginx see? No PROXY protocol is configured, so it should be the load balancer's private address, which is why the private range is in `trusted_proxy_cidrs` | Read `X-Forwarded-For` at ID through the audit API | Enable `kubernetes.civo.com/loadbalancer-enable-proxy-protocol` with ingress-nginx's `use-proxy-protocol` |
| Is the pod range k3s's default 10.42.0.0/16? | `kubectl get nodes -o jsonpath='{.items[*].spec.podCIDR}'` | Set `pod_cidr` |
| Which certificate does the database present, and for which name? `verify-full` needs its CA and a matching host | `civo database show`; `openssl s_client -starttls postgres -connect <host>:5432` from a pod | Use `database_dns_endpoint` as the host, or ship the CA the dashboard offers |
| The administrator's login and default database | `civo database credential answerable-staging-database` | Feed them to the `bootstrap` Job ([B3](../../docs/goals/aws-deploy/briefs/b3.md)) |
| Do standbys and backups work with the database's outbound traffic limited to the private network? | The restore drill ([B7](../../docs/goals/aws-deploy/briefs/b7.md)) | Widen the database firewall's egress |
| Does the platform chart accept the values Terraform sets (`ingress-nginx.controller.service.annotations`, `ingress-nginx.controller.config.proxy-real-ip-cidr`)? | `helm get values platform -n platform` | Match the keys in `modules/platform/main.tf` to the chart |

## Day two

- **Plan and apply**: `terraform plan` and `terraform apply` in the environment's root with the credentials above. A change in Cloudflare's published ranges shows as a plan diff (output `cloudflare_ranges_etag`).
- **Rotate the deployer token**: `terraform apply -replace=module.deployer.kubernetes_secret_v1.token`, then update `KUBE_TOKEN`. Deleting the Secret revokes the old token.
- **Change who reaches the API**: change `TF_VAR_allowed_api_cidrs` and apply.
- **Destroy**: the database and the state bucket carry `prevent_destroy`; removing it is a reviewed change.

## Not yet

- **Deploys from GitHub-hosted runners.** The Kubernetes API admits `allowed_api_cidrs` only, and GitHub's hosted runners publish 5,508 IPv4 ranges (`https://api.github.com/meta`, `actions`, 13 October 2026), too many for a firewall. The deploy workflow needs a fixed egress address (a self-hosted runner or a tunnel) or a decision to open the API; the module refuses `0.0.0.0/0`.
- **Bot Fight Mode as code.** `cloudflare_bot_management` can turn it off, but the token would need Bot Management Edit; it stays a dashboard toggle.
- **The AWS and Google roots.** Written in a later brief.
