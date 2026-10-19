# charts/platform

The cluster's edge: Traefik (D31) and the Traefik TLS option that demands Cloudflare's origin-pull certificate. Release `platform`, namespace `platform`. Terraform installs it with the cluster's admin credential (`infra/civo/modules/platform`); the kind stack installs it with `values-local.yaml` (`infra/k8s/local`). Its one dependency is Traefik's OCI chart.

## What it renders outside its namespace

Both in `answerable`, beside the Ingresses they guard:

| Object | From | Notes |
| --- | --- | --- |
| TLSOption `default` | always | Every TLS connection must present a client certificate the origin-pull CA signed (D19). Traefik applies it to every router that names no option, which every Ingress of `charts/answerable` is; only `answerable` may define it (`defaultTLSResourcesNamespace`), and a router naming a conflicting option is refused (`strictTLSOptions`) |
| Secret `cloudflare-origin-pull-ca`, key `ca.crt` | `originPull.caPem` | Cloudflare's origin-pull CA, which the option names |

The certificate Traefik serves is the Secret `origin-tls` in `answerable`, which the Ingresses name: Terraform writes it from Cloudflare's Origin CA; the kind stack writes one from its own CA.

## Values supplied at install

| Value | Who passes it | Empty |
| --- | --- | --- |
| `originPull.caPem` | Terraform, from its edge module's origin-pull CA; the kind stack, its stand-in's | The render fails on the Civo overlays (`originPull.caRequired`), naming the value. Elsewhere no Secret is rendered, and Traefik refuses every client certificate |
| `traefik.ports.websecure.forwardedHeaders.trustedIPs`, `traefik.service.annotations` | Terraform | Traefik keeps no forwarded header; the load balancer has no firewall |

A `caPem` that is not PEM fails the render too.

## Tests

`infra/k8s/charts.test.ts` renders every overlay (`bun --filter @answerable/infra-k8s test:charts`); `bun run infra:check` lints it and validates it with kubeconform, with a placeholder certificate for `originPull.caPem`. `bun run infra:test` proves in a kind cluster that the `default` option alone keeps every host closed.
