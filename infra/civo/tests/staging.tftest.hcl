# Staging as envs/staging.tfvars describes it, run as terraform.sh plans it: `terraform test
# -filter=tests/staging.tftest.hcl -var-file=envs/staging.tfvars` (bun run infra:check does). Every name
# answerable-staging-, two nodes, one database node, the staging zone's four hostnames, the edge wired to Cloudflare's
# ranges as the data source returns them, and the GitHub environment staging.
mock_provider "civo" {}
mock_provider "cloudflare" {}
mock_provider "kubernetes" {}
mock_provider "helm" {}
mock_provider "tls" {}
mock_provider "github" {}

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

run "plans_staging_from_its_own_values" {
  command = plan

  assert {
    condition     = var.environment == "staging" && module.network.cidr_v4 == "10.10.0.0/24"
    error_message = "envs/staging.tfvars must describe staging on 10.10.0.0/24."
  }

  assert {
    condition     = fileexists("../../charts/platform/values-civo-${var.environment}.yaml")
    error_message = "The platform chart must ship its staging overlay, charts/platform/values-civo-staging.yaml."
  }
}

run "names_everything_for_staging" {
  command = plan

  assert {
    condition = alltrue([
      for name in [
        module.network.name, module.cluster.name, module.cluster.firewall_name, module.cluster.node_pool_name,
        module.database.name, module.database.firewall_name, module.ingress_firewall.firewall_name,
        module.ingress_firewall.reserved_ip_name,
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

# Cloudflare's ranges reach the load balancer's firewall (IPv4, the load balancer has no IPv6) and the trusted-proxies
# ConfigMap ID reads, after which come the private network and the pod range.
run "admits_and_trusts_cloudflare" {
  command = plan

  assert {
    condition     = module.ingress_firewall.https_sources == tolist(sort(["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"]))
    error_message = "The load balancer must admit exactly the IPv4 ranges Cloudflare publishes."
  }

  assert {
    condition     = module.platform.trusted_proxy_cidrs == "173.245.48.0/20,103.21.244.0/22,104.16.0.0/13,2400:cb00::/32,2606:4700::/32,10.10.0.0/24,10.42.0.0/16"
    error_message = "TRUSTED_PROXY_CIDRS must be Cloudflare's ranges, the private network and the pod range, nothing else."
  }
}

run "serves_the_staging_zone" {
  command = plan

  assert {
    condition     = output.hostnames == tolist(["admin-mcp.answerable-staging.uk", "id.answerable-staging.uk", "mcp.answerable-staging.uk", "toolbox.answerable-staging.uk"])
    error_message = "Staging serves id, toolbox, admin-mcp and mcp, the standalone server, under answerable-staging.uk (D12)."
  }
}

run "writes_the_kube_secrets_into_the_staging_environment" {
  command = plan

  assert {
    condition     = module.github.environment == "staging" && module.github.secret_names == tolist(["KUBE_CA", "KUBE_SERVER", "KUBE_TOKEN"])
    error_message = "Terraform writes KUBE_SERVER, KUBE_CA and KUBE_TOKEN into the GitHub environment staging."
  }
}

# The postgres-admin Secret's OPS_DATABASE_ADMIN_URL, also the break-glass output: Civo's administrator login,
# percent-encoded, on the private address, Civo's default database, verify-full against the CA every pod mounts.
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
    condition     = issensitive(output.database_admin_url)
    error_message = "database_admin_url carries the administrator's password: it must be a sensitive output."
  }

  assert {
    condition     = nonsensitive(output.database_admin_url) == "postgres://civo:a%2Fb%20c%2Bd%40e@10.0.0.5:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
    error_message = "database_admin_url must be postgres://<user>:<encoded password>@<private address>:<port>/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem."
  }
}

# The first apply in CI creates the cluster, the database and the firewalls alone, because the kubernetes and helm
# providers are configured from a kubeconfig that does not exist before the cluster does.
run "plans_the_targeted_first_apply" {
  command = plan

  plan_options {
    target = [module.cluster, module.database, module.ingress_firewall]
  }

  assert {
    condition     = module.cluster.name == "answerable-staging-cluster" && module.database.name == "answerable-staging-database"
    error_message = "A plan targeting the cluster, the database and the firewalls must stand on its own."
  }
}

# The cluster-admin credential reaches an operator only as a sensitive output, for break-glass and diagnostics; the
# deploy holds the deployer's token instead.
run "outputs_the_admin_kubeconfig_as_a_sensitive_value" {
  command = plan

  override_resource {
    target          = module.cluster.civo_kubernetes_cluster.this
    override_during = plan
    values = {
      api_endpoint = "https://74.220.1.2:6443"
      kubeconfig   = <<-EOT
        apiVersion: v1
        kind: Config
        clusters:
          - name: answerable
            cluster:
              server: https://74.220.1.2:6443
              certificate-authority-data: Y2E=
        users:
          - name: admin
            user:
              client-certificate-data: Y2VydA==
              client-key-data: a2V5
        contexts:
          - name: answerable
            context:
              cluster: answerable
              user: admin
        current-context: answerable
      EOT
    }
  }

  assert {
    condition     = issensitive(output.admin_kubeconfig)
    error_message = "admin_kubeconfig is the cluster-admin credential: it must be a sensitive output."
  }

  assert {
    condition     = yamldecode(nonsensitive(output.admin_kubeconfig)).clusters[0].cluster.server == "https://74.220.1.2:6443"
    error_message = "admin_kubeconfig must be the cluster's own kubeconfig."
  }

  assert {
    condition     = output.kube_server == "https://74.220.1.2:6443" && !issensitive(output.kube_server)
    error_message = "kube_server must be the cluster's API endpoint, a public value."
  }
}
