# The cluster and its firewall: the Kubernetes API answers only the listed addresses, nothing else outside the private
# network gets in, Cilium is the CNI and Traefik is never installed, because ingress-nginx is the one ingress (D22).
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
    error_message = "The cluster must remove Civo's default Traefik so that ingress-nginx is the only ingress controller."
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
    condition     = length(civo_vpc_firewall.this.ingress_rule) == 3
    error_message = "The cluster firewall admits the API and the private network's TCP and UDP, nothing else."
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
