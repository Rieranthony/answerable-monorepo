# The cluster's platform layer: the two namespaces under the restricted Pod Security Standard, the objects the
# answerable chart and its Jobs read (trusted-proxies, postgres-admin, origin-tls), and the platform chart (Traefik, D31)
# installed with the values only Terraform knows: the load balancer's firewall and reserved address, the ranges Traefik
# trusts for X-Forwarded-For on the websecure entry point, and the origin-pull CA certificate.
mock_provider "kubernetes" {}
mock_provider "helm" {}

variables {
  chart_path                = "../../../../charts/platform"
  load_balancer_firewall_id = "44444444-4444-4444-8444-444444444444"
  load_balancer_ip          = "192.0.2.10"
  trusted_proxy_cidrs       = ["173.245.48.0/20", "2400:cb00::/32", "10.10.0.0/24"]
  pod_cidr                  = "10.42.0.0/16"
  origin_pull_ca_pem        = "placeholder: origin-pull CA certificate"
  database_admin_url        = "postgres://civo:secret@10.10.0.7:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
  origin_certificate_pem    = "placeholder: origin certificate"
  origin_private_key_pem    = "placeholder: origin key"
}

run "creates_the_namespaces_under_the_restricted_standard" {
  command = plan

  assert {
    condition     = kubernetes_namespace_v1.answerable.metadata[0].name == "answerable" && kubernetes_namespace_v1.platform.metadata[0].name == "platform"
    error_message = "The namespaces must be answerable (the application) and platform (the platform chart)."
  }

  assert {
    condition = alltrue([
      for namespace in [kubernetes_namespace_v1.answerable, kubernetes_namespace_v1.platform] :
      namespace.metadata[0].labels["pod-security.kubernetes.io/enforce"] == "restricted"
    ])
    error_message = "Both namespaces must enforce the restricted Pod Security Standard; nothing in either needs more."
  }
}

# ID's TRUSTED_PROXY_CIDRS: Traefik's trusted peers (Cloudflare and the private network), then the pod range Traefik
# reaches ID from.
run "writes_the_trusted_proxies_configmap" {
  command = plan

  assert {
    condition = (
      kubernetes_config_map_v1.trusted_proxies.metadata[0].name == "trusted-proxies"
      && kubernetes_config_map_v1.trusted_proxies.metadata[0].namespace == "answerable"
      && keys(kubernetes_config_map_v1.trusted_proxies.data) == tolist(["cidrs"])
    )
    error_message = "The ConfigMap must be answerable/trusted-proxies with the one key cidrs."
  }

  assert {
    condition     = kubernetes_config_map_v1.trusted_proxies.data["cidrs"] == "173.245.48.0/20,2400:cb00::/32,10.10.0.0/24,10.42.0.0/16"
    error_message = "cidrs must be Traefik's trusted ranges then the pod range, comma-separated."
  }

  assert {
    condition     = output.trusted_proxy_cidrs == "173.245.48.0/20,2400:cb00::/32,10.10.0.0/24,10.42.0.0/16"
    error_message = "The module must report the ConfigMap's cidrs."
  }
}

run "writes_the_postgres_admin_secret" {
  command = plan

  assert {
    condition = (
      kubernetes_secret_v1.postgres_admin.metadata[0].name == "postgres-admin"
      && kubernetes_secret_v1.postgres_admin.metadata[0].namespace == "answerable"
      && nonsensitive(keys(kubernetes_secret_v1.postgres_admin.data)) == tolist(["OPS_DATABASE_ADMIN_URL"])
    )
    error_message = "The Secret must be answerable/postgres-admin with the one key OPS_DATABASE_ADMIN_URL."
  }

  assert {
    condition     = nonsensitive(kubernetes_secret_v1.postgres_admin.data["OPS_DATABASE_ADMIN_URL"]) == "postgres://civo:secret@10.10.0.7:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
    error_message = "OPS_DATABASE_ADMIN_URL must be the database module's administrator URL, unchanged."
  }
}

run "writes_the_origin_tls_secret" {
  command = plan

  assert {
    condition = (
      kubernetes_secret_v1.origin_tls.metadata[0].name == "origin-tls"
      && kubernetes_secret_v1.origin_tls.metadata[0].namespace == "answerable"
      && kubernetes_secret_v1.origin_tls.type == "kubernetes.io/tls"
    )
    error_message = "The Secret must be answerable/origin-tls of type kubernetes.io/tls, which the three Ingresses name."
  }

  assert {
    condition = (
      nonsensitive(kubernetes_secret_v1.origin_tls.data["tls.crt"]) == "placeholder: origin certificate"
      && nonsensitive(kubernetes_secret_v1.origin_tls.data["tls.key"]) == "placeholder: origin key"
      && length(kubernetes_secret_v1.origin_tls.data) == 2
    )
    error_message = "tls.crt must be the Origin CA certificate and tls.key its key, and nothing else."
  }
}

run "installs_the_platform_chart_with_the_load_balancer_wiring" {
  command = plan

  assert {
    condition     = helm_release.platform.name == "platform" && helm_release.platform.namespace == "platform"
    error_message = "The platform chart must be the release platform in the namespace platform."
  }

  assert {
    condition     = helm_release.platform.chart == "../../../../charts/platform"
    error_message = "The release must install the repository's own platform chart."
  }

  assert {
    condition     = helm_release.platform.atomic && helm_release.platform.dependency_update
    error_message = "The release must roll back a failed upgrade and fetch the chart's pinned dependencies."
  }

  assert {
    condition = (
      yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["traefik"]["service"]["annotations"]
      == {
        "kubernetes.civo.com/firewall-id"  = "44444444-4444-4444-8444-444444444444"
        "kubernetes.civo.com/ipv4-address" = "192.0.2.10"
      }
    )
    error_message = "Traefik's Service must name the load balancer firewall and claim the reserved address the DNS records point at."
  }

  assert {
    condition = (
      yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["traefik"]["ports"]["websecure"]["forwardedHeaders"]["trustedIPs"]
      == ["173.245.48.0/20", "2400:cb00::/32", "10.10.0.0/24"]
    )
    error_message = "Traefik's websecure entry point must trust X-Forwarded-For only from the ranges it was given, as a list, without the pod range."
  }

  assert {
    condition = (
      keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])) == ["originPull", "traefik"]
      && keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["originPull"]) == ["caPem"]
      && keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["traefik"]) == ["ports", "service"]
      && keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["traefik"]["ports"]) == ["websecure"]
    )
    error_message = "Terraform owns the origin-pull CA, the Traefik Service annotations and websecure's trusted ranges, nothing else."
  }
}

run "passes_the_origin_pull_ca_to_the_chart" {
  command = plan

  assert {
    condition = (
      yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["originPull"]["caPem"]
      == "placeholder: origin-pull CA certificate"
    )
    error_message = "The chart must receive the edge module's origin-pull CA certificate as originPull.caPem, byte for byte."
  }
}

run "reads_values_files_before_the_values_terraform_owns" {
  command = plan

  variables {
    values_files = ["tests/fixtures/values-civo-test.yaml"]
  }

  assert {
    condition     = length(helm_release.platform.values) == 2 && helm_release.platform.values[0] == file("tests/fixtures/values-civo-test.yaml")
    error_message = "The chart's own values files come first, so the values Terraform owns override them."
  }
}

run "fails_at_plan_when_a_values_file_is_missing" {
  command = plan

  variables {
    values_files = ["tests/fixtures/values-civo-test.yaml", "tests/fixtures/values-civo-missing.yaml"]
  }

  expect_failures = [var.values_files]
}

run "refuses_a_load_balancer_address_that_is_not_ipv4" {
  command = plan

  variables {
    load_balancer_ip = "lb.example"
  }

  expect_failures = [var.load_balancer_ip]
}

run "refuses_trusting_everyone" {
  command = plan

  variables {
    trusted_proxy_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.trusted_proxy_cidrs]
}

run "refuses_a_pod_range_that_is_everyone" {
  command = plan

  variables {
    pod_cidr = "0.0.0.0/0"
  }

  expect_failures = [var.pod_cidr]
}
