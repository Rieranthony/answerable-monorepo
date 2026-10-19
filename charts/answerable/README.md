# charts/answerable

Answerable ID, the Toolbox and the admin MCP, with their migrations and the ops Jobs. Release `answerable`, namespace `answerable`. The deploy upgrades it (`infra/pipeline`); the kind stack installs it with `values-local.yaml` (`infra/k8s/local`).

## What it creates and what it expects

- **It renders** the Deployments, Services, Ingresses, autoscalers, disruption budgets and NetworkPolicies of the three servers, the three migration Jobs, and the ops Jobs when switched on (`infra/ops/README.md`). It renders no namespace, Secret or ConfigMap.
- **It expects**, in its namespace:

| Object | Written by | Read by |
| --- | --- | --- |
| ConfigMap `trusted-proxies`, key `cidrs` | Terraform | ID's `TRUSTED_PROXY_CIDRS` (`trustedProxies.configMap`); ID's pods do not start without it |
| Secret `origin-tls`, type `kubernetes.io/tls` | Terraform (Cloudflare's Origin CA) | The three Ingresses (`ingress.tlsSecret`) |
| Secret `postgres-admin`, key `OPS_DATABASE_ADMIN_URL` | Terraform | The ops bootstrap Job |
| Secret `id-env` | The deploy, from the GitHub environment | ID (`envFrom`); the register and make-admin Jobs (`ROOT_ADMIN_SECRET`) |
| ConfigMap `postgres-ca`, key `ca.pem` | The ops bootstrap Job, on first use | The servers and the migrations, at `/etc/ssl/db/ca.pem`. The ops Jobs do not mount it |
| The six database URL Secrets, `toolbox-id-client`, `admin-id-client` | The ops Jobs | The servers and the migrations |

`charts/platform` renders the TLS option `default`, which demands Cloudflare's origin-pull certificate on every host, and `cloudflare-origin-pull-ca`. The Ingresses name no TLS option and no issuer.

## Values supplied at install

| Value | Who passes it | Empty |
| --- | --- | --- |
| `image.tag`, `images.<image>.digest` | The deploy | Images run as `:unset`, which fails to pull |
| `idEnvChecksum` | The deploy: the SHA-256 of `id-env`'s values | Nothing rolls ID when a secret changes |
| `ops.bootstrap`, `ops.register`, `ops.makeAdmin` with `ops.adminEmail` | The deploy (`bootstrap` every time, `register` on the first install), `deploy.ts run-job` for one upgrade | No ops Job. `ops.makeAdmin` without `ops.adminEmail` fails the render |
| `id.staffDomain`, `id.entraTenant` | The overlay | `register` connects no staff directory |

The Toolbox and the admin MCP render at zero replicas until their client Secret exists; `ops register` writes it and scales them up. `helm template` has no cluster to look in, so it always shows them at zero.

## Tests

`infra/k8s/charts.test.ts` renders the defaults and every overlay, including each failure message; `bun run infra:test` installs the chart in the kind stack. `bun run infra:check` lints it and validates it with kubeconform.
