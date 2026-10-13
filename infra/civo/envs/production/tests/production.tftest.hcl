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
  # charts/platform is not on every branch these tests run on; the platform module checks the overlay exists at plan
  # time, and the run below checks terraform.tfvars names it.
  platform_values_files = []
  # edge-ca/ca.pem is written by `bun run setup origin-pull` once the cluster exists; the module's fixture stands in.
  origin_pull_ca_file = "../../modules/platform/tests/fixtures/edge-ca.pem"
}

run "names_the_platform_charts_production_overlay" {
  command = plan

  assert {
    condition = can(regex(
      "platform_values_files\\s*=\\s*\\[\\s*\"\\.\\./\\.\\./\\.\\./\\.\\./charts/platform/values-civo-${var.environment}\\.yaml\"\\s*\\]",
      file("terraform.tfvars"),
    ))
    error_message = "terraform.tfvars must give the platform chart its production overlay, ../../../../charts/platform/values-civo-production.yaml."
  }
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

run "keeps_production_api_closed" {
  command = plan

  assert {
    condition     = !var.api_open_to_internet && !module.cluster.api_open_to_internet
    error_message = "Production's Kubernetes API admits the listed addresses only."
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

# Without TF_VAR_allowed_api_cidrs production's API would admit nobody: the plan fails loudly instead.
run "refuses_to_plan_without_operator_addresses" {
  command = plan

  variables {
    allowed_api_cidrs = []
  }

  expect_failures = [var.allowed_api_cidrs]
}

run "lets_the_deployer_read_nothing_outside_answerable" {
  command = plan

  assert {
    condition     = length(module.deployer.read_namespaces) == 0
    error_message = "The pipeline reads nothing outside answerable, so the deployer may not either."
  }
}

# The bootstrap Job's OPS_DATABASE_ADMIN_URL (the first-run contract): Civo's administrator login, percent-encoded,
# on the private address, verify-full against the CA the answerable chart mounts.
run "outputs_the_database_admin_url" {
  command = plan

  override_resource {
    target          = module.database.civo_database.this
    override_during = plan
    values = {
      username     = "civo"
      password     = "a/b c+d@e"
      private_ipv4 = "10.0.0.5"
      port         = 5432
    }
  }

  assert {
    condition     = output.database_admin_url == "postgres://civo:a%2Fb%20c%2Bd%40e@10.0.0.5:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
    error_message = "database_admin_url must be postgres://<user>:<encoded password>@<private address>:<port>/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem."
  }
}

# The first apply creates the cluster, the database and the firewalls before the origin-pull CA exists.
run "plans_the_targeted_first_apply_without_the_origin_pull_ca" {
  command = plan

  variables {
    origin_pull_ca_file = "edge-ca/not-written-yet.pem"
  }

  plan_options {
    target = [module.cluster, module.database, module.ingress_firewall]
  }

  assert {
    condition     = module.cluster.name == "answerable-production-cluster"
    error_message = "A plan targeting the cluster, the database and the firewalls must not need the origin-pull CA."
  }
}
