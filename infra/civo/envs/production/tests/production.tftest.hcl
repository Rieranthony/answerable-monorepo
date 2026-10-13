# Production as terraform.tfvars describes it: every name answerable-production-, three nodes, a three-node database,
# the answerable.org zone's three hostnames and never www, which Vercel serves.
mock_provider "civo" {}
mock_provider "cloudflare" {}
mock_provider "kubernetes" {}
mock_provider "helm" {}

override_data {
  target = data.cloudflare_ip_ranges.this
  values = {
    etag       = "38f79d050aa027e3be3865e495dcc9bc"
    ipv4_cidrs = ["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"]
    ipv6_cidrs = ["2400:cb00::/32", "2606:4700::/32"]
  }
}

override_data {
  target = data.cloudflare_zone.this
  values = {
    id = "fedcba9876543210fedcba9876543210"
  }
}

variables {
  allowed_api_cidrs = ["198.51.100.7/32"]
}

run "names_everything_for_production" {
  command = plan

  assert {
    condition = alltrue([
      for name in [
        module.network.name, module.cluster.name, module.cluster.firewall_name, module.cluster.node_pool_name,
        module.database.name, module.database.firewall_name, module.ingress_firewall.firewall_name,
        module.ingress_firewall.reserved_ip_name, module.state.bucket, module.state.credential_name,
      ] : startswith(name, "answerable-production-")
    ])
    error_message = "Every Civo resource in production must be named answerable-production-<what>."
  }
}

run "sizes_production_for_two_replicas_and_a_standby" {
  command = plan

  assert {
    condition     = module.cluster.node_count == 3 && var.node_size == "g4s.kube.medium"
    error_message = "Production runs three Medium nodes."
  }

  assert {
    condition     = module.database.nodes == 3 && var.database_size == "g3.db.medium"
    error_message = "Production runs a Medium database with two additional nodes."
  }

  assert {
    condition     = output.network_cidr == "10.20.0.0/24"
    error_message = "Production's private network must not overlap staging's 10.10.0.0/24."
  }
}

run "serves_answerable_org_without_touching_www" {
  command = plan

  assert {
    condition     = output.hostnames == tolist(["admin-mcp.answerable.org", "id.answerable.org", "toolbox.answerable.org"])
    error_message = "Production serves id, toolbox and admin-mcp under answerable.org (D12)."
  }

  assert {
    condition     = alltrue([for host in output.hostnames : !startswith(host, "www.") && host != "answerable.org"])
    error_message = "Production's edge must never write www.answerable.org or the apex."
  }

  assert {
    condition     = output.state_bucket == "answerable-production-tfstate"
    error_message = "Production's state must live in production's own bucket."
  }
}
