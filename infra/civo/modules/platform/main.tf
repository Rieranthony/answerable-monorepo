# The application's namespace. The restricted Pod Security Standard is enforced: a pod that runs as root, keeps a
# capability other than NET_BIND_SERVICE, allows privilege escalation or lacks a seccomp profile is refused at admission.
resource "kubernetes_namespace_v1" "answerable" {
  metadata {
    name = "answerable"
    labels = {
      "pod-security.kubernetes.io/enforce" = "restricted"
      "pod-security.kubernetes.io/warn"    = "restricted"
      "pod-security.kubernetes.io/audit"   = "restricted"
    }
  }
}

# The shared controllers' namespace. The Grafana agent's log collector reads the nodes' log files through a hostPath,
# which no Pod Security Standard but privileged allows, so this namespace warns and audits rather than enforcing.
resource "kubernetes_namespace_v1" "platform" {
  metadata {
    name = "platform"
    labels = {
      "pod-security.kubernetes.io/warn"  = "restricted"
      "pod-security.kubernetes.io/audit" = "restricted"
    }
  }
}

locals {
  # The origin-pull CA certificate, read only when the release is planned, so that targeted applies of the cluster,
  # the database and the firewalls work before `bun run setup origin-pull` has written it. A missing file reads as
  # empty here and the release's precondition explains what to do.
  origin_pull_ca     = fileexists(var.origin_pull_ca_file) ? file(var.origin_pull_ca_file) : ""
  origin_pull_writer = "bun run setup origin-pull --environment ${var.environment} --zone ${var.zone_name}"

  # The values only Terraform knows, applied after every values file so that they win.
  # - originPull.caPem: charts/platform renders it as the Secret cloudflare-origin-pull-ca (key ca.crt) that Traefik's
  #   TLS option verifies Cloudflare's client certificate against (D19, the first-run contract).
  # - traefik: the upstream Traefik chart's keys (traefik/traefik-helm-chart, values.yaml at v41.7.1) under the
  #   dependency's name, the Service's annotations and the websecure entry point's trusted ranges for X-Forwarded-*.
  #   Traefik keeps a trusted peer's X-Forwarded-For and appends the peer's address, so ID's right-to-left walk is
  #   unchanged (D22, D31); an untrusted peer's X-Forwarded-* headers are deleted (README.md).
  cloud_values = yamlencode({
    originPull = {
      caPem = local.origin_pull_ca
    }
    traefik = {
      service = {
        annotations = {
          "kubernetes.civo.com/firewall-id"  = var.load_balancer_firewall_id
          "kubernetes.civo.com/ipv4-address" = var.load_balancer_ip
        }
      }
      ports = {
        websecure = {
          forwardedHeaders = {
            trustedIPs = var.trusted_proxy_cidrs
          }
        }
      }
    }
  })
}

# charts/platform: Traefik (D31), cert-manager and the Grafana agent, pinned as chart dependencies. Terraform installs
# it with the cluster's admin credential because it carries cluster-wide objects (CRDs, ClusterRoles) that the
# namespace-scoped deployer may not touch; the deploy workflow upgrades only charts/answerable.
resource "helm_release" "platform" {
  name              = "platform"
  namespace         = kubernetes_namespace_v1.platform.metadata[0].name
  chart             = var.chart_path
  dependency_update = true
  atomic            = true
  cleanup_on_fail   = true
  wait              = true
  timeout           = 900
  max_history       = 10
  values            = concat([for path in var.values_files : file(path)], [local.cloud_values])

  lifecycle {
    precondition {
      condition     = fileexists(var.origin_pull_ca_file)
      error_message = "The origin-pull CA certificate ${var.origin_pull_ca_file} is missing. Write it with `${local.origin_pull_writer}`, commit it, and plan again. Targeted applies of the cluster, the database and the firewalls do not need it."
    }

    precondition {
      condition     = !fileexists(var.origin_pull_ca_file) || (strcontains(local.origin_pull_ca, "-----BEGIN CERTIFICATE-----") && !strcontains(local.origin_pull_ca, "PRIVATE KEY"))
      error_message = "${var.origin_pull_ca_file} must hold the origin-pull CA's public certificate (PEM) and nothing else: no private key belongs in the repository or in Terraform. Rewrite it with `${local.origin_pull_writer}`."
    }
  }
}
