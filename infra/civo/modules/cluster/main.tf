locals {
  name = "answerable-${var.environment}-cluster"

  # Marketplace applications, comma-separated, a leading "-" removing a default one. Civo installs Traefik by default
  # (marketplace name `traefik2-nodeport`); ingress-nginx from the platform chart is the one controller (D22), so
  # Traefik goes. metrics-server, also a default, stays: the HorizontalPodAutoscalers read it.
  applications = "-traefik2-nodeport"
}

# Civo clusters always have a public address. This firewall keeps everything outside the private network away from it
# except the Kubernetes API, and the API only from the listed addresses. The private network's own range is admitted
# so that the load balancer reaches the ingress controller's node ports and the nodes reach one another.
resource "civo_vpc_firewall" "this" {
  name                 = local.name
  network_id           = var.network_id
  create_default_rules = false

  ingress_rule {
    label      = "kubernetes-api"
    protocol   = "tcp"
    port_range = "6443"
    cidr       = var.allowed_api_cidrs
    action     = "allow"
  }

  ingress_rule {
    label      = "private-network-tcp"
    protocol   = "tcp"
    port_range = "1-65535"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  ingress_rule {
    label      = "private-network-udp"
    protocol   = "udp"
    port_range = "1-65535"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  egress_rule {
    label      = "all-tcp"
    protocol   = "tcp"
    port_range = "1-65535"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }

  egress_rule {
    label      = "all-udp"
    protocol   = "udp"
    port_range = "1-65535"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }

  egress_rule {
    label    = "all-icmp"
    protocol = "icmp"
    cidr     = ["0.0.0.0/0"]
    action   = "allow"
  }
}

# The cluster. Its kubeconfig is written to state (`write_kubeconfig`) because this root configures the kubernetes and
# helm providers from it; the state therefore holds the cluster's admin credential and is kept in the environment's
# private object store (see the README).
resource "civo_kubernetes_cluster" "this" {
  name               = local.name
  network_id         = var.network_id
  firewall_id        = civo_vpc_firewall.this.id
  cluster_type       = "k3s"
  cni                = "cilium"
  applications       = local.applications
  kubernetes_version = var.kubernetes_version
  write_kubeconfig   = true

  pools {
    label      = "answerable-${var.environment}-nodes"
    size       = var.node_size
    node_count = var.node_count
  }
}
