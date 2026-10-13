# charts/platform

The cluster's shared pieces: Traefik (the edge, D31), cert-manager and its issuers, the Traefik TLS options that demand Cloudflare's origin-pull certificate, and the Grafana agent (off until Grafana Cloud exists). Release `platform`, namespace `platform`. Terraform installs it with the cluster's admin credential (`infra/civo/modules/platform`); the kind stack installs it with `values-local.yaml` (`infra/k8s/local`).

## What it renders outside its namespace

All in `answerable`, beside the Ingresses that use them:

| Object | From | Notes |
| --- | --- | --- |
| TLSOptions `origin-pull` and `default` | always | Every TLS connection must present a client certificate the origin-pull CA signed (D19) |
| Secret `cloudflare-origin-pull-ca`, key `ca.crt` | `originPull.caPem` | Cloudflare's origin-pull CA, which both TLS options name |
| Issuer `letsencrypt` | `issuers.letsencrypt.enabled` (the Civo overlays) | Let's Encrypt through DNS-01 in the environment's Cloudflare zone. It reads the Secret `cloudflare-api-token`, key `api-token`, in `answerable`, which the deploy applies from the `sops` file. A post-install hook, after cert-manager's webhook is up |

The kind stack's issuer is the ClusterIssuer `local`, a self-signed CA (`issuers.local.enabled`). There is no ACME ClusterIssuer.

## Values supplied at install

| Value | Who passes it | Empty |
| --- | --- | --- |
| `originPull.caPem` | Terraform, from `infra/civo/envs/<environment>/edge-ca/ca.pem` (`bun run setup origin-pull`); the kind stack, its stand-in's CA | The render fails on the Civo overlays (`originPull.caRequired`), naming the value. Elsewhere no Secret is rendered, and Traefik refuses every client certificate |
| `traefik.ports.websecure.forwardedHeaders.trustedIPs`, `traefik.service.annotations` | Terraform | Traefik keeps no forwarded header; the load balancer has no firewall |

A `caPem` that is not PEM fails the render too.

## Tests

`infra/k8s/charts.test.ts` renders every overlay (`bun --filter @answerable/infra-k8s test:charts`); `bun run infra:check` lints it and validates it with kubeconform, with a placeholder certificate for `originPull.caPem`.
