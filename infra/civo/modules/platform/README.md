# Module `platform`

The cluster's platform layer:

- **The namespaces.** `answerable`, where the restricted Pod Security Standard is enforced, and `platform`, which only warns and audits.
- **The `platform` release of `charts/platform`.** It carries Traefik (D31), cert-manager and the Grafana agent, pinned as chart dependencies.

Terraform installs the release with the cluster's admin credential, because the chart carries cluster-wide objects that the namespace-scoped deployer may not touch. The runbook is in [`infra/civo/README.md`](../../README.md).

## Values

The release receives, in order:

1. **The chart's own overlay**, `charts/platform/values-civo-<environment>.yaml`, named by `platform_values_files` in each root's `terraform.tfvars`. A missing file fails the plan, naming the path.
2. **The values only Terraform knows**, which therefore win. `originPull` is charts/platform's own key (the first-run contract). The `traefik` keys are the upstream Traefik chart's ([`values.yaml` at chart v41.7.1](https://github.com/traefik/traefik-helm-chart/blob/v41.7.1/traefik/values.yaml), Traefik v3.7.14), under the dependency's name:

| Key | Value | Why |
| --- | --- | --- |
| `originPull.caPem` | The origin-pull CA's public certificate (PEM), read from `infra/civo/envs/<env>/edge-ca/ca.pem` (root variable `origin_pull_ca_file`) | The chart renders the Secret `cloudflare-origin-pull-ca` (key `ca.crt`), which Traefik's TLS option verifies Cloudflare's client certificate against (D19) |
| `traefik.service.annotations."kubernetes.civo.com/firewall-id"` | The load balancer firewall's ID | Without it Civo gives the load balancer an open default firewall |
| `traefik.service.annotations."kubernetes.civo.com/ipv4-address"` | The reserved address | The Cloudflare records point at it |
| `traefik.ports.websecure.forwardedHeaders.trustedIPs` | A list: Cloudflare's IPv4 and IPv6 ranges, and the private network | Traefik keeps `X-Forwarded-For` only from a trusted peer, and appends the peer's address (`notAppendXForwardedFor` stays false) |

**Why the private network is in `trustedIPs`.** Without PROXY protocol the peer Traefik sees is the load balancer's private address, so the private network is what makes Cloudflare's header survive. Cloudflare's ranges cover the day PROXY protocol is switched on. From an untrusted peer Traefik deletes every `X-Forwarded-*` header before adding its own ([`forwarded_header.go` at v3.7.14](https://github.com/traefik/traefik/blob/v3.7.14/pkg/middlewares/forwardedheaders/forwarded_header.go)). ID would then see only the load balancer's address and resolve no client.

Nothing else is set here. Replicas, TLS options (the origin-pull `clientAuth`), the `web` entry point and the rest belong to the chart's own values.

## The origin-pull CA and the first apply

The certificate file is read only when the platform release is planned. The first apply can therefore create the cluster, the database and the firewalls (`terraform apply -target=module.cluster -target=module.database -target=module.ingress_firewall`) before `bun run setup origin-pull` has written the file. Two preconditions on the release then guard the full apply:

- **A missing file** stops the plan with a message naming the file and the command that writes it: `bun run setup origin-pull --environment <env> --zone <zone>`.
- **A wrong file** also stops it: one with no `BEGIN CERTIFICATE` block, or one that holds a private key. The origin-pull CA's key never enters the repository or Terraform.
