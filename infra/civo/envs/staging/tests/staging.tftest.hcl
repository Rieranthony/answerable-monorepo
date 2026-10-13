# Staging as terraform.tfvars describes it: every name answerable-staging-, two nodes, one database node, the
# staging zone's three hostnames, and the edge wired to Cloudflare's ranges as the data source returns them.
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
    id = "0123456789abcdef0123456789abcdef"
  }
}

variables {
  allowed_api_cidrs = ["198.51.100.7/32"]
}

run "names_everything_for_staging" {
  command = plan

  assert {
    condition = alltrue([
      for name in [
        module.network.name, module.cluster.name, module.cluster.firewall_name, module.cluster.node_pool_name,
        module.database.name, module.database.firewall_name, module.ingress_firewall.firewall_name,
        module.ingress_firewall.reserved_ip_name, module.state.bucket, module.state.credential_name,
      ] : startswith(name, "answerable-staging-")
    ])
    error_message = "Every Civo resource in staging must be named answerable-staging-<what>."
  }
}

run "sizes_staging_small" {
  command = plan

  assert {
    condition     = module.cluster.node_count == 2 && var.node_size == "g4s.kube.medium"
    error_message = "Staging runs two Medium nodes."
  }

  assert {
    condition     = module.database.nodes == 1 && var.database_size == "g3.db.small"
    error_message = "Staging runs one Small database node."
  }
}

run "admits_and_trusts_cloudflare" {
  command = plan

  assert {
    condition     = output.https_sources == tolist(sort(["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"]))
    error_message = "The load balancer must admit exactly the IPv4 ranges Cloudflare publishes."
  }

  assert {
    condition     = output.trusted_proxy_cidrs == "173.245.48.0/20,103.21.244.0/22,104.16.0.0/13,2400:cb00::/32,2606:4700::/32,10.10.0.0/24,10.42.0.0/16"
    error_message = "TRUSTED_PROXY_CIDRS must be Cloudflare's ranges, the private network and the pod range, nothing else."
  }

  assert {
    condition     = output.cloudflare_ranges_etag == "38f79d050aa027e3be3865e495dcc9bc"
    error_message = "The ranges' digest must be an output so that a change is visible."
  }
}

run "serves_the_staging_zone" {
  command = plan

  assert {
    condition     = output.hostnames == tolist(["admin-mcp.answerable-staging.uk", "id.answerable-staging.uk", "toolbox.answerable-staging.uk"])
    error_message = "Staging serves id, toolbox and admin-mcp under answerable-staging.uk (D12)."
  }

  assert {
    condition     = output.state_bucket == "answerable-staging-tfstate" && output.state_endpoint == "https://objectstore.lon1.civo.com"
    error_message = "The state bucket and endpoint must be the ones backend.tf names."
  }
}
