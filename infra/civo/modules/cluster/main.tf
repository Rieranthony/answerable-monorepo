locals {
  name = "answerable-${var.environment}-cluster"

  # Marketplace applications, comma-separated, a leading "-" removing a default one. Civo installs Traefik by default,
  # named Traefik-v2-nodeport in `civo kubernetes show` and in the Civo CLI's own removal example; ingress-nginx from
  # the platform chart is the one controller (D22), so Traefik goes. metrics-server, also a default, stays: the
  # HorizontalPodAutoscalers read it. Civo cannot change applications after creation.
  applications = "-Traefik-v2-nodeport"

  # Who may reach the Kubernetes API: the operators' addresses, plus the whole internet while api_open_to_internet
  # is true (staging's stopgap for GitHub-hosted runners; see the variable).
  api_sources = var.api_open_to_internet ? distinct(concat(var.allowed_api_cidrs, ["0.0.0.0/0"])) : var.allowed_api_cidrs
}

# Civo clusters always have a public address. This firewall admits the Kubernetes API from local.api_sources only,
# and from the private network only the ports the load balancer and the nodes need of one another, each named below
# with its source in the README. 6443 is never admitted from the network as such.
resource "civo_vpc_firewall" "this" {
  name                 = local.name
  network_id           = var.network_id
  create_default_rules = false

  ingress_rule {
    label      = "kubernetes-api"
    protocol   = "tcp"
    port_range = "6443"
    cidr       = local.api_sources
    action     = "allow"
  }

  # Kubernetes' NodePort range: the Civo load balancer forwards 443 to ingress-nginx's node port on every node.
  ingress_rule {
    label      = "node-ports"
    protocol   = "tcp"
    port_range = "30000-32767"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  # k3s: the kubelet, which metrics-server scrapes and the API server reaches for logs and exec.
  ingress_rule {
    label      = "kubelet"
    protocol   = "tcp"
    port_range = "10250"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  # Cilium: the VXLAN overlay between nodes, which carries all pod-to-pod traffic.
  ingress_rule {
    label      = "cilium-vxlan"
    protocol   = "udp"
    port_range = "8472"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  # Cilium: cilium-health's HTTP and ping probes between nodes.
  ingress_rule {
    label      = "cilium-health"
    protocol   = "tcp"
    port_range = "4240"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  ingress_rule {
    label    = "cilium-health-ping"
    protocol = "icmp"
    cidr     = [var.network_cidr]
    action   = "allow"
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

  lifecycle {
    postcondition {
      condition     = !anytrue([for app in self.installed_applications : strcontains(lower(app.application), "traefik")])
      error_message = "Civo installed Traefik despite the removal in `applications`; correct the application's name in modules/cluster/main.tf and recreate the cluster, or remove it with `civo kubernetes applications remove`."
    }
  }
}
