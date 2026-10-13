# charts/answerable

Answerable ID, the Toolbox and the admin MCP, with their migrations and the ops Jobs. Release `answerable`, namespace `answerable`. The deploy upgrades it (`infra/pipeline`); the kind stack installs it with `values-local.yaml` (`infra/k8s/local`).

## What it creates and what it expects

- **It renders** the Deployments, Services, Ingresses, autoscalers, disruption budgets and NetworkPolicies of the three servers, the three migration Jobs, and the ops Jobs when switched on (`infra/ops/README.md`). It also renders the ConfigMap `postgres-ca` (key `ca.pem`) from `database.caPem`, as a pre-install and pre-upgrade hook, because the migrations and the ops bootstrap mount it before the release's own resources exist.
- **It expects** the namespace, which Terraform creates. The deploy applies `id-env`, `postgres-admin` and `cloudflare-api-token` from the `sops` file. The ops Jobs write the database URL Secrets and the client Secrets. `charts/platform` renders the Issuer `letsencrypt`, the TLS options and `cloudflare-origin-pull-ca`.

The Ingresses take their certificates from `ingress.issuer`: the Issuer `letsencrypt` in this namespace, or, in the kind stack, the ClusterIssuer `local`.

## Values supplied at install

| Value | Who passes it | Empty |
| --- | --- | --- |
| `image.tag`, `images.<image>.digest` | The deploy | Images run as `:unset`, which fails to pull |
| `database.caPem` | The deploy, `--set-file database.caPem=infra/civo/envs/<environment>/database-ca.pem` (`bun run setup database-ca`); the kind stack, its database's CA | The render fails, naming the value. One that is not PEM fails too |
| `ops.bootstrap`, `ops.register` | `deploy.ts run-job`, for one upgrade | No ops Job |

The Toolbox and the admin MCP render at zero replicas until their client Secret exists; `ops register` writes it and scales them up. `helm template` has no cluster to look in, so it always shows them at zero.

## Tests

`infra/k8s/charts.test.ts` renders the defaults and every overlay, including each failure message; `bun run infra:test` installs the chart in the kind stack. `bun run infra:check` lints it and validates it with kubeconform, with a placeholder certificate for `database.caPem`.
