# charts/answerable

Answerable ID, the Toolbox, the admin MCP and the standalone server, every MCP of `mcps.json`, their migrations and the ops Jobs. Release `answerable`, namespace `answerable`. The deploy upgrades it (`infra/pipeline`); the kind stack installs it with `values-local.yaml` (`infra/k8s/local`).

## What it creates and what it expects

- **It renders** the Deployments, Services, Ingresses, autoscalers, disruption budgets and NetworkPolicies of ID, the Toolbox, the admin MCP and, while `mcps.json` has a `standalone` or `both` MCP, the standalone server; the five migration Jobs; and the ops Jobs when switched on (`infra/ops/README.md`). It renders no namespace, Secret or ConfigMap.
- **It reads `mcps.json`**, the list of MCPs `bun mcp` writes from each `mcps/<name>/mcp.json` (never edit it by hand), with `.Files.Get … | fromJson`. Its root is an object, `{ "mcps": [{ name, serve, database, scopes, grants }] }`, because `fromJson` reads an array as an error map; anything else fails the render, naming the file. It is not named `values-*.yaml`, which `infra/check.ts` would take for an overlay. From it the chart renders: the bootstrap's and register's `OPS_MCPS` (`name`, `serve`, `database` and `scopes`; register gives each standalone MCP's resource its scopes) and the ops Role's Secret names; `mcps-migrate`'s `MCPS_DECLARED` and each own MCP's owner URL; each own MCP's runtime URL for the Toolbox (`TOOLBOX_MCP_<NAME>_DATABASE_URL`) and the standalone server (`STANDALONE_MCP_<NAME>_DATABASE_URL`); and the standalone server, its Ingress on `hostnames.mcp` with two `Prefix` paths per MCP, `/<name>/` and `/.well-known/oauth-protected-resource/<name>/`, its NetworkPolicy, autoscaler and disruption budget. A new MCP changes no template and no value.
- **The migrations**, one at a time in weight order: `id-migrate` (-10) from the `id` image; `toolbox-migrate` (-9), `admin-migrate` (-8), `standalone-migrate` (-7) and `mcps-migrate` (-6) from the `mcps` image. Each mounts only the owner logins of its own databases. At 200 MCPs the rendered release Helm stores is 54,040 bytes, 5.2% of the 1 MiB a Secret holds (`charts.test.ts`, 25 October 2026).
- **It expects**, in its namespace:

| Object | Written by | Read by |
| --- | --- | --- |
| ConfigMap `trusted-proxies`, key `cidrs` | Terraform | ID's `TRUSTED_PROXY_CIDRS` (`trustedProxies.configMap`); ID's pods do not start without it |
| Secret `origin-tls`, type `kubernetes.io/tls` | Terraform (Cloudflare's Origin CA) | Every Ingress (`ingress.tlsSecret`) |
| Secret `postgres-admin`, key `OPS_DATABASE_ADMIN_URL` | Terraform | The ops bootstrap Job |
| Secret `id-env` | The deploy, from the GitHub environment | ID (`envFrom`); the register and make-admin Jobs (`ROOT_ADMIN_SECRET`) |
| ConfigMap `postgres-ca`, key `ca.pem` | The ops bootstrap Job, on first use | The servers and the migrations, at `/etc/ssl/db/ca.pem`. The ops Jobs do not mount it |
| The database URL Secrets (`infra/ops/README.md`, Bootstrap), `toolbox-id-client`, `admin-id-client`, `standalone-id-client` | The ops Jobs | The servers and the migrations |

`charts/platform` renders the TLS option `default`, which demands Cloudflare's origin-pull certificate on every host, and `cloudflare-origin-pull-ca`. The Ingresses name no TLS option and no issuer.

## Values supplied at install

| Value | Who passes it | Empty |
| --- | --- | --- |
| `image.tag`, `images.<image>.digest` | The deploy | Images run as `:unset`, which fails to pull |
| `idEnvChecksum` | The deploy: the SHA-256 of `id-env`'s values | Nothing rolls ID when a secret changes |
| `ops.bootstrap`, `ops.register`, `ops.makeAdmin` with `ops.adminEmail` | The deploy (`bootstrap` and `register` every time), `deploy.ts run-job` for one upgrade | No ops Job. `ops.makeAdmin` without `ops.adminEmail` fails the render |
| `id.staffDomain`, `id.entraTenant` | The overlay | `register` connects no staff directory |

The Toolbox, the admin MCP and the standalone server render at zero replicas until their client Secret exists; `ops register` writes it and scales them up. The chart never sets `TOOLBOX_MCPS_ROLE_PREFIX` or `STANDALONE_MCPS_ROLE_PREFIX`, which only tests use. `helm template` has no cluster to look in, so it always shows them at zero.

## Tests

`infra/k8s/charts.test.ts` renders the defaults and every overlay, including each failure message, and copies of the chart with 0, 1, 3 and 200 MCPs in `mcps.json`; `bun run infra:test` installs the chart in the kind stack. `bun run infra:check` lints it and validates it with kubeconform.
