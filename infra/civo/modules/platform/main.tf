locals {
  # The restricted Pod Security Standard, enforced in both namespaces: a pod that runs as root, keeps a capability other
  # than NET_BIND_SERVICE, allows privilege escalation, lacks a seccomp profile or mounts a hostPath is refused at
  # admission. charts/platform's Traefik meets it on Civo (non-root, RuntimeDefault seccomp, no capabilities, read-only
  # root, no hostPort), and so does every pod charts/answerable renders.
  pod_security = {
    "pod-security.kubernetes.io/enforce" = "restricted"
    "pod-security.kubernetes.io/warn"    = "restricted"
    "pod-security.kubernetes.io/audit"   = "restricted"
  }
}

# The application's namespace: ID, the Toolbox, the admin MCP, their Jobs, and the objects below.
resource "kubernetes_namespace_v1" "answerable" {
  metadata {
    name   = "answerable"
    labels = local.pod_security
  }
}

# The platform chart's namespace: Traefik.
resource "kubernetes_namespace_v1" "platform" {
  metadata {
    name   = "platform"
    labels = local.pod_security
  }
}

# The proxies whose X-Forwarded-For ID trusts (TRUSTED_PROXY_CIDRS, read from this ConfigMap's key cidrs): Traefik's own
# trusted peers, then the pod range Traefik reaches the services from (D31).
resource "kubernetes_config_map_v1" "trusted_proxies" {
  metadata {
    name      = "trusted-proxies"
    namespace = kubernetes_namespace_v1.answerable.metadata[0].name
  }

  data = {
    cidrs = join(",", concat(var.trusted_proxy_cidrs, [var.pod_cidr]))
  }
}

# The database administrator's URL for the bootstrap Job, which creates the databases and logins. It never leaves the
# cluster and Terraform's state.
resource "kubernetes_secret_v1" "postgres_admin" {
  metadata {
    name      = "postgres-admin"
    namespace = kubernetes_namespace_v1.answerable.metadata[0].name
  }

  data = {
    OPS_DATABASE_ADMIN_URL = var.database_admin_url
  }
}

# The origin's certificate from Cloudflare's Origin CA and its key, which the three Ingresses serve.
resource "kubernetes_secret_v1" "origin_tls" {
  metadata {
    name      = "origin-tls"
    namespace = kubernetes_namespace_v1.answerable.metadata[0].name
  }

  type = "kubernetes.io/tls"

  data = {
    "tls.crt" = var.origin_certificate_pem
    "tls.key" = var.origin_private_key_pem
  }
}

locals {
  # The values only Terraform knows, applied after every values file so that they win.
  # - originPull.caPem: charts/platform renders it as the Secret cloudflare-origin-pull-ca (key ca.crt) that Traefik's
  #   default TLS option verifies Cloudflare's client certificate against (D19).
  # - traefik: the upstream Traefik chart's keys (traefik/traefik-helm-chart, values.yaml at v41.7.1) under the
  #   dependency's name, the Service's annotations and the websecure entry point's trusted ranges for X-Forwarded-*.
  #   Traefik keeps a trusted peer's X-Forwarded-For and appends the peer's address, so ID's right-to-left walk is
  #   unchanged (D22, D31); an untrusted peer's X-Forwarded-* headers are deleted (README.md).
  cloud_values = yamlencode({
    originPull = {
      caPem = var.origin_pull_ca_pem
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

# charts/platform: Traefik (D31), pinned as a chart dependency. Terraform installs it with the cluster's admin
# credential because it carries cluster-wide objects (CRDs, ClusterRoles) that the namespace-scoped deployer may not
# touch; the deploy workflow upgrades only charts/answerable.
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
}
