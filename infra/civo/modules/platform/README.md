# Module `platform`

The cluster's platform layer, installed with the cluster's admin credential: the chart carries cluster-wide objects (CRDs, ClusterRoles) that the namespace-scoped deployer may not touch, and the namespaces must exist before the deployer can. The runbook is in [`infra/civo/README.md`](../../README.md).

- **The namespaces** `answerable` and `platform`, both enforcing the restricted Pod Security Standard. Traefik meets it on Civo: non-root, seccomp `RuntimeDefault`, no capabilities, a read-only root and no `hostPort`.
- **The `platform` release of `charts/platform`**: Traefik (D31), pinned as a chart dependency.
- **Three objects in `answerable`** that the application reads and nothing else writes:

| Object | Key | Value | Read by |
| --- | --- | --- | --- |
| ConfigMap `trusted-proxies` | `cidrs` | Comma-separated: Cloudflare's IPv4 and IPv6 ranges, the private network, the pod range | ID's `TRUSTED_PROXY_CIDRS` |
| Secret `postgres-admin` | `OPS_DATABASE_ADMIN_URL` | The database module's `admin_url` | The bootstrap Job |
| Secret `origin-tls`, type `kubernetes.io/tls` | `tls.crt`, `tls.key` | The edge module's Origin CA certificate and its key | The three Ingresses |

## Values

The release receives, in order:

1. **The chart's own overlay**, `charts/platform/values-civo-<environment>.yaml`, which the root names from `environment`. A missing file fails the plan, naming the path.
2. **The values only Terraform knows**, which therefore win. `originPull` is charts/platform's own key. The `traefik` keys are the upstream Traefik chart's ([`values.yaml` at chart v41.7.1](https://github.com/traefik/traefik-helm-chart/blob/v41.7.1/traefik/values.yaml), Traefik v3.7.14), under the dependency's name:

| Key | Value | Why |
| --- | --- | --- |
| `originPull.caPem` | The origin-pull CA's certificate (PEM), the edge module's `origin_pull_ca_pem` | The chart renders the Secret `cloudflare-origin-pull-ca` (key `ca.crt`), which Traefik's `default` TLS option verifies Cloudflare's client certificate against (D19) |
| `traefik.service.annotations."kubernetes.civo.com/firewall-id"` | The load balancer firewall's ID | Without it Civo gives the load balancer an open default firewall |
| `traefik.service.annotations."kubernetes.civo.com/ipv4-address"` | The reserved address | The Cloudflare records point at it |
| `traefik.ports.websecure.forwardedHeaders.trustedIPs` | A list: Cloudflare's IPv4 and IPv6 ranges, and the private network | Traefik keeps `X-Forwarded-For` only from a trusted peer, and appends the peer's address (`notAppendXForwardedFor` stays false) |

**Why the private network is in `trustedIPs`.** Without PROXY protocol the peer Traefik sees is the load balancer's private address, so the private network is what makes Cloudflare's header survive. Cloudflare's ranges cover the day PROXY protocol is switched on. From an untrusted peer Traefik deletes every `X-Forwarded-*` header before adding its own ([`forwarded_header.go` at v3.7.14](https://github.com/traefik/traefik/blob/v3.7.14/pkg/middlewares/forwardedheaders/forwarded_header.go)). ID would then see only the load balancer's address and resolve no client.

**Why the pod range is in `cidrs` and not in `trustedIPs`.** Traefik reaches ID from a pod address, so ID must trust that hop too. No proxy in the pod range sits in front of Traefik, so Traefik trusts none.

Nothing else is set here. Replicas, the TLS option, the `web` entry point and the rest belong to the chart's own values.
