# Module `platform`

The cluster's platform layer, installed with the cluster's admin credential: the chart carries cluster-wide objects (CRDs, ClusterRoles) that the namespace-scoped deployer may not touch, and the namespaces must exist before the deployer can. The runbook is in [`infra/civo/README.md`](../../README.md).

- **The namespaces** `answerable` and `platform`, both enforcing the restricted Pod Security Standard. Traefik meets it on Civo: non-root, seccomp `RuntimeDefault`, no capabilities, a read-only root and no `hostPort`.
- **The `platform` release of `charts/platform`**: Traefik (D31), pinned as a chart dependency.
- **Two Secrets in `answerable`** that the application reads and nothing else writes:

| Object | Key | Value | Read by |
| --- | --- | --- | --- |
| Secret `postgres-admin` | `OPS_DATABASE_ADMIN_URL` | The database module's `admin_url` | The bootstrap Job |
| Secret `origin-tls`, type `kubernetes.io/tls` | `tls.crt`, `tls.key` | The edge module's Origin CA certificate and its key | Every Ingress, one per hostname |

## Values

The release receives, in order:

1. **The chart's own overlay**, `charts/platform/values-civo-<environment>.yaml`, which the root names from `environment`. A missing file fails the plan, naming the path.
2. **The values only Terraform knows**, which therefore win. `originPull` is charts/platform's own key. The `traefik` keys are the upstream Traefik chart's ([`values.yaml` at chart v41.7.1](https://github.com/traefik/traefik-helm-chart/blob/v41.7.1/traefik/values.yaml), Traefik v3.7.14), under the dependency's name:

| Key | Value | Why |
| --- | --- | --- |
| `originPull.caPem` | The origin-pull CA's certificate (PEM), the edge module's `origin_pull_ca_pem` | The chart renders the Secret `cloudflare-origin-pull-ca` (key `ca.crt`), which Traefik's `default` TLS option verifies Cloudflare's client certificate against (D19) |
| `traefik.service.annotations."kubernetes.civo.com/firewall-id"` | The load balancer firewall's ID | Without it Civo gives the load balancer an open default firewall |
| `traefik.service.annotations."kubernetes.civo.com/ipv4-address"` | The reserved address | The Cloudflare records point at it |

Nothing else is set here. Replicas, the TLS option, the `web` entry point and the rest belong to the chart's own values.
