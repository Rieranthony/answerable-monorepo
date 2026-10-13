# The cluster and its firewall: the Kubernetes API answers only the listed addresses, nothing else outside the private
# network gets in, Cilium is the CNI and Civo's marketplace Traefik is never installed: the one ingress controller is
# the Traefik charts/platform pins (D31).
mock_provider "civo" {
  override_during = plan

  mock_resource "civo_vpc_firewall" {
    defaults = {
      id = "11111111-1111-4111-8111-111111111111"
    }
  }
}

variables {
  environment       = "staging"
  network_id        = "22222222-2222-4222-8222-222222222222"
  network_cidr      = "10.10.0.0/24"
  allowed_api_cidrs = ["198.51.100.7/32", "203.0.113.0/28"]
  node_size         = "g4s.kube.medium"
  node_count        = 2
}

run "builds_the_cluster_on_the_private_network" {
  command = plan

  assert {
    condition     = civo_kubernetes_cluster.this.name == "answerable-staging-cluster"
    error_message = "The cluster must be named answerable-<environment>-cluster."
  }

  assert {
    condition     = civo_kubernetes_cluster.this.network_id == "22222222-2222-4222-8222-222222222222"
    error_message = "The cluster must join the environment's private network."
  }

  assert {
    condition     = civo_kubernetes_cluster.this.firewall_id == "11111111-1111-4111-8111-111111111111"
    error_message = "The cluster must sit behind its own firewall, not the network's default one."
  }

  assert {
    condition     = civo_kubernetes_cluster.this.cluster_type == "k3s" && civo_kubernetes_cluster.this.cni == "cilium"
    error_message = "The cluster must be k3s with the Cilium CNI (Flannel lacks NetworkPolicy enforcement and is being deprecated)."
  }

  assert {
    condition     = contains(split(",", civo_kubernetes_cluster.this.applications), "-Traefik-v2-nodeport")
    error_message = "The cluster must remove Civo's marketplace Traefik so that charts/platform's Traefik is the only ingress controller."
  }

  assert {
    condition     = civo_kubernetes_cluster.this.write_kubeconfig
    error_message = "The kubeconfig must be readable by the kubernetes and helm providers in the same root."
  }

  assert {
    condition     = civo_kubernetes_cluster.this.pools[0].size == "g4s.kube.medium" && civo_kubernetes_cluster.this.pools[0].node_count == 2
    error_message = "The node pool must have the size and count it was given."
  }

  assert {
    condition     = civo_kubernetes_cluster.this.pools[0].label == "answerable-staging-nodes"
    error_message = "The node pool must be named answerable-<environment>-nodes."
  }
}

run "admits_the_api_from_the_listed_addresses_only" {
  command = plan

  assert {
    condition     = civo_vpc_firewall.this.name == "answerable-staging-cluster" && civo_vpc_firewall.this.network_id == "22222222-2222-4222-8222-222222222222"
    error_message = "The cluster firewall must be named answerable-<environment>-cluster and belong to the private network."
  }

  assert {
    condition     = civo_vpc_firewall.this.create_default_rules == false
    error_message = "Civo's default rules open ports to everyone; the firewall must carry only its declared rules."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      rule.cidr == toset(["198.51.100.7/32", "203.0.113.0/28"]) if rule.port_range == "6443"
    ]) && length([for rule in civo_vpc_firewall.this.ingress_rule : rule if rule.port_range == "6443"]) == 1
    error_message = "Exactly one rule may admit the Kubernetes API, from exactly the listed addresses."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      rule.cidr == toset(["10.10.0.0/24"]) if rule.port_range != "6443"
    ])
    error_message = "Every other inbound rule must admit the private network's own range and nothing wider."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      !contains(rule.cidr, "0.0.0.0/0") && !contains(rule.cidr, "::/0") && rule.action == "allow"
    ])
    error_message = "No inbound rule may admit the whole internet."
  }

  assert {
    condition     = length(civo_vpc_firewall.this.ingress_rule) == 6
    error_message = "The cluster firewall admits the API and five node-to-node rules, nothing else."
  }
}

# From the private network the firewall admits only what the load balancer and the nodes need of one another (see the
# module README for the sources). A rule spanning every port, or any rule from the network reaching 6443, would let
# anything on the network past allowed_api_cidrs, so neither may come back.
run "admits_only_named_ports_from_the_private_network" {
  command = plan

  assert {
    condition = toset([
      for rule in civo_vpc_firewall.this.ingress_rule : "${rule.protocol}/${coalesce(rule.port_range, "-")}"
      if rule.cidr == toset(["10.10.0.0/24"])
      ]) == toset([
      "tcp/30000-32767", # node ports: the load balancer to Traefik
      "tcp/10250",       # kubelet: metrics-server and the API server's logs and exec
      "udp/8472",        # Cilium's VXLAN tunnel
      "tcp/4240",        # cilium-health
      "icmp/-",          # cilium-health's ping
    ])
    error_message = "From the private network: node ports, kubelet, Cilium's tunnel and health checks, and nothing else."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule : (
        rule.protocol == "icmp" ? true : (
          strcontains(rule.port_range, "-")
          ? !(tonumber(split("-", rule.port_range)[0]) <= 6443 && tonumber(split("-", rule.port_range)[1]) >= 6443)
          : rule.port_range != "6443"
        )
      ) if rule.cidr == toset(["10.10.0.0/24"])
    ])
    error_message = "No rule from the private network may reach 6443; the API answers allowed_api_cidrs and api_open_to_internet only."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      rule.port_range != "1-65535" && rule.port_range != "0-65535"
    ])
    error_message = "No inbound rule may span every port."
  }
}

run "lets_the_nodes_reach_out" {
  command = plan

  assert {
    condition = length([
      for rule in civo_vpc_firewall.this.egress_rule : rule
      if rule.cidr == toset(["0.0.0.0/0"]) && rule.action == "allow"
    ]) == 3
    error_message = "The nodes need outbound TCP, UDP and ICMP: images from GHCR, DNS, the identity providers, Let's Encrypt."
  }
}

run "refuses_an_api_open_to_everyone" {
  command = plan

  variables {
    allowed_api_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.allowed_api_cidrs]
}

run "refuses_no_api_addresses" {
  command = plan

  variables {
    allowed_api_cidrs = []
  }

  expect_failures = [var.allowed_api_cidrs]
}

run "reports_a_closed_api_by_default" {
  command = plan

  assert {
    condition     = output.api_open_to_internet == false
    error_message = "By default the Kubernetes API admits the listed addresses only."
  }
}

# The staging stopgap: GitHub-hosted runners have no fixed address, so staging's API admits the internet and the
# cluster's own authentication is the barrier, until GitOps or a Cloudflare tunnel closes it again.
run "opens_the_api_when_asked_and_nothing_else" {
  command = plan

  variables {
    api_open_to_internet = true
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      rule.cidr == toset(["198.51.100.7/32", "203.0.113.0/28", "0.0.0.0/0"]) if rule.port_range == "6443"
    ]) && length([for rule in civo_vpc_firewall.this.ingress_rule : rule if rule.port_range == "6443"]) == 1
    error_message = "An open API admits the internet on 6443 and keeps the operators' addresses."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      !contains(rule.cidr, "0.0.0.0/0") && !contains(rule.cidr, "::/0") if rule.port_range != "6443"
    ]) && length(civo_vpc_firewall.this.ingress_rule) == 6
    error_message = "Opening the API must open nothing but 6443."
  }

  assert {
    condition     = output.api_open_to_internet
    error_message = "The module must report an open API."
  }
}

run "accepts_the_whole_internet_in_the_list_when_open" {
  command = plan

  variables {
    api_open_to_internet = true
    allowed_api_cidrs    = ["0.0.0.0/0"]
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule : rule.cidr == toset(["0.0.0.0/0"]) if rule.port_range == "6443"
    ])
    error_message = "The internet listed once is admitted once."
  }
}

run "accepts_no_operator_addresses_when_open" {
  command = plan

  variables {
    api_open_to_internet = true
    allowed_api_cidrs    = []
  }

  assert {
    condition     = output.api_open_to_internet
    error_message = "An open API needs no operator address to be reachable."
  }
}

run "refuses_an_open_api_in_production" {
  command = plan

  variables {
    environment          = "production"
    api_open_to_internet = true
  }

  expect_failures = [var.api_open_to_internet]
}

run "refuses_a_malformed_api_address" {
  command = plan

  variables {
    allowed_api_cidrs = ["198.51.100.7"]
  }

  expect_failures = [var.allowed_api_cidrs]
}

run "refuses_a_node_size_that_is_not_a_kubernetes_size" {
  command = plan

  variables {
    node_size = "g3.db.small"
  }

  expect_failures = [var.node_size]
}

run "refuses_a_single_node" {
  command = plan

  variables {
    node_count = 1
  }

  expect_failures = [var.node_count]
}

# The removal above names Traefik as Civo's CLI documentation does; if Civo installs it all the same, the apply fails
# rather than leaving a second ingress controller in the cluster.
run "fails_when_civo_installs_traefik_anyway" {
  command = plan

  override_resource {
    target          = civo_kubernetes_cluster.this
    override_during = plan
    values = {
      installed_applications = [
        { application = "Traefik-v2-nodeport", category = "architecture", installed = true, version = "2.9.4" },
        { application = "metrics-server", category = "architecture", installed = true, version = "(default)" },
      ]
    }
  }

  expect_failures = [civo_kubernetes_cluster.this]
}

run "accepts_a_cluster_without_traefik" {
  command = plan

  override_resource {
    target          = civo_kubernetes_cluster.this
    override_during = plan
    values = {
      installed_applications = [
        { application = "metrics-server", category = "architecture", installed = true, version = "(default)" },
      ]
    }
  }

  assert {
    condition     = length(civo_kubernetes_cluster.this.installed_applications) == 1
    error_message = "A cluster with metrics-server alone must be accepted."
  }
}

# The admin kubeconfig leaves the module only as a sensitive value: the providers of the root read it, and the root's
# admin_kubeconfig output hands it to an operator for break-glass and diagnostics.
run "hands_out_the_admin_kubeconfig_only_as_a_sensitive_value" {
  command = plan

  override_resource {
    target          = civo_kubernetes_cluster.this
    override_during = plan
    values = {
      kubeconfig = "apiVersion: v1\nkind: Config\n"
    }
  }

  assert {
    condition     = issensitive(output.kubeconfig)
    error_message = "The cluster's admin kubeconfig must be a sensitive output."
  }

  assert {
    condition     = nonsensitive(output.kubeconfig) == "apiVersion: v1\nkind: Config\n"
    error_message = "The kubeconfig output must be the cluster's own kubeconfig attribute."
  }
}
