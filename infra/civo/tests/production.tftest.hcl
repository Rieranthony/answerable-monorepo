# Production as envs/production.tfvars describes it, run as terraform.sh plans it: `terraform test
# -filter=tests/production.tftest.hcl -var-file=envs/production.tfvars` (bun run infra:check does). Every name
# answerable-production-, three nodes, one database node until failover is measured, the answerable.org zone's four
# hostnames and never www, which Vercel serves, and the GitHub environment production.
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
    id = "fedcba9876543210fedcba9876543210"
  }
}

run "plans_production_from_its_own_values" {
  command = plan

  assert {
    condition     = var.environment == "production" && module.network.cidr_v4 == "10.20.0.0/24"
    error_message = "envs/production.tfvars must describe production on 10.20.0.0/24, clear of staging's 10.10.0.0/24."
  }

  assert {
    condition     = fileexists("../../charts/platform/values-civo-${var.environment}.yaml")
    error_message = "The platform chart must ship its production overlay, charts/platform/values-civo-production.yaml."
  }
}

run "names_everything_for_production" {
  command = plan

  assert {
    condition = alltrue([
      for name in [
        module.network.name, module.cluster.name, module.cluster.firewall_name, module.cluster.node_pool_name,
        module.database.name, module.database.firewall_name, module.ingress_firewall.firewall_name,
        module.ingress_firewall.reserved_ip_name,
      ] : startswith(name, "answerable-production-")
    ])
    error_message = "Every Civo resource in production must be named answerable-production-<what>."
  }
}

run "sizes_production_for_two_replicas_and_a_spare_node" {
  command = plan

  assert {
    condition     = module.cluster.node_count == 3 && var.node_size == "g4s.kube.medium"
    error_message = "Production runs three Medium nodes."
  }

  assert {
    condition     = module.database.nodes == 1 && var.database_size == "g3.db.medium"
    error_message = "Production runs one Medium database node until B7c has measured Civo's failover."
  }
}

run "trusts_cloudflare_production_network_and_pods" {
  command = plan

  assert {
    condition     = module.platform.trusted_proxy_cidrs == "10.20.0.0/24,10.42.0.0/16"
    error_message = "TRUSTED_PROXY_CIDRS must be the private network and the pod range, without Cloudflare's ranges."
  }
}

run "serves_answerable_org_without_touching_www" {
  command = plan

  assert {
    condition     = output.hostnames == tolist(["admin-mcp.answerable.org", "id.answerable.org", "mcp.answerable.org", "toolbox.answerable.org"])
    error_message = "Production serves id, toolbox, admin-mcp and mcp, the standalone MCPs, under answerable.org (D12)."
  }

  assert {
    condition     = alltrue([for host in output.hostnames : !startswith(host, "www.") && host != "answerable.org"])
    error_message = "Production's edge must never write www.answerable.org or the apex."
  }
}

run "writes_the_kube_secrets_into_the_production_environment" {
  command = plan

  assert {
    condition     = module.github.environment == "production" && module.github.secret_names == tolist(["KUBE_CA", "KUBE_SERVER", "KUBE_TOKEN"])
    error_message = "Terraform writes KUBE_SERVER, KUBE_CA and KUBE_TOKEN into the GitHub environment production."
  }
}

run "plans_the_targeted_first_apply" {
  command = plan

  plan_options {
    target = [module.cluster, module.database, module.ingress_firewall]
  }

  assert {
    condition     = module.cluster.name == "answerable-production-cluster" && module.database.name == "answerable-production-database"
    error_message = "A plan targeting the cluster, the database and the firewalls must stand on its own."
  }
}

# Postmark's DNS records for the mail domain id.answerable.org: none until the owner gives their values in envs/production.tfvars, and
# then exactly the DKIM and DMARC TXT records and the Return-Path CNAME, DNS-only, under id.answerable.org. These runs pass the
# values themselves, so that they hold whatever the tfvars carries.
run "writes_no_mail_record_without_the_values" {
  command = plan

  variables {
    mail_records = null
  }

  assert {
    condition     = length(module.edge.mail_records) == 0 && length(output.mail_records) == 0
    error_message = "Without mail_records, production must write no mail record."
  }

  assert {
    condition     = output.hostnames == tolist(["admin-mcp.answerable.org", "id.answerable.org", "mcp.answerable.org", "toolbox.answerable.org"])
    error_message = "Without mail_records, production's zone must hold its four service records and no other."
  }
}

run "writes_postmarks_records_for_the_mail_domain_when_given_the_values" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable.org"
      dkim_value       = "k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDexample"
      return_path_host = "pm-bounces.id.answerable.org"
      dmarc_value      = "v=DMARC1; p=none; rua=mailto:dmarc@answerable.org"
    }
  }

  assert {
    condition     = output.mail_records == tolist(["CNAME pm-bounces.id.answerable.org", "TXT 20260101000000pm._domainkey.id.answerable.org", "TXT _dmarc.id.answerable.org"])
    error_message = "production must write Postmark's three records under id.answerable.org: the Return-Path CNAME, the DKIM TXT and the DMARC TXT."
  }

  assert {
    condition     = output.hostnames == tolist(["admin-mcp.answerable.org", "id.answerable.org", "mcp.answerable.org", "toolbox.answerable.org"])
    error_message = "The mail records must leave the four service hostnames as they are."
  }
}

run "refuses_mail_records_off_the_mail_domain" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.answerable.org"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.id.answerable.org"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_return_path_host_off_the_mail_domain" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable.org"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.answerable.org"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_dkim_value_that_is_not_a_public_key" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable.org"
      dkim_value       = "v=spf1 include:spf.protection.outlook.com ~all"
      return_path_host = "pm-bounces.id.answerable.org"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_dmarc_value_that_is_not_dmarc" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable.org"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.id.answerable.org"
      dmarc_value      = "v=spf1 -all"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_quoted_dmarc_value" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable.org"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.id.answerable.org"
      dmarc_value      = "v=DMARC1; p=none; rua=\"mailto:dmarc@answerable.org\""
    }
  }

  expect_failures = [var.mail_records]
}
