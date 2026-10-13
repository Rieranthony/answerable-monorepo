# The cluster's platform layer: the two namespaces, and the platform chart (Traefik, cert-manager, the Grafana agent;
# D31) installed with the values only Terraform knows: the load balancer's firewall and reserved address, the ranges
# Traefik trusts for X-Forwarded-For on the websecure entry point, and the origin-pull CA certificate.
mock_provider "kubernetes" {}
mock_provider "helm" {}

variables {
  chart_path                = "../../../../charts/platform"
  load_balancer_firewall_id = "44444444-4444-4444-8444-444444444444"
  load_balancer_ip          = "192.0.2.10"
  trusted_proxy_cidrs       = ["173.245.48.0/20", "2400:cb00::/32", "10.10.0.0/24"]
  environment               = "staging"
  zone_name                 = "answerable-staging.uk"
  origin_pull_ca_file       = "tests/fixtures/edge-ca.pem"
}

run "creates_the_namespaces_with_pod_security" {
  command = plan

  assert {
    condition     = kubernetes_namespace_v1.answerable.metadata[0].name == "answerable" && kubernetes_namespace_v1.platform.metadata[0].name == "platform"
    error_message = "The namespaces must be answerable (the application) and platform (the shared controllers)."
  }

  assert {
    condition     = kubernetes_namespace_v1.answerable.metadata[0].labels["pod-security.kubernetes.io/enforce"] == "restricted"
    error_message = "The application namespace must enforce the restricted Pod Security Standard."
  }

  assert {
    condition     = kubernetes_namespace_v1.platform.metadata[0].labels["pod-security.kubernetes.io/warn"] == "restricted"
    error_message = "The platform namespace must at least warn on pods that fall short of the restricted standard."
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
    error_message = "Traefik's websecure entry point must trust X-Forwarded-For only from the ranges it was given, as a list."
  }

  assert {
    condition = (
      keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])) == ["originPull", "traefik"]
      && keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["originPull"]) == ["caPem"]
      && keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["traefik"]) == ["ports", "service"]
      && keys(yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["traefik"]["ports"]) == ["websecure"]
    )
    error_message = "Terraform owns the origin-pull CA, the Traefik Service annotations and websecure's trusted ranges, nothing else; no ingress-nginx key survives (D31)."
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

run "passes_the_origin_pull_ca_to_the_chart" {
  command = plan

  assert {
    condition = (
      yamldecode(helm_release.platform.values[length(helm_release.platform.values) - 1])["originPull"]["caPem"]
      == file("tests/fixtures/edge-ca.pem")
    )
    error_message = "The chart must receive the committed origin-pull CA certificate as originPull.caPem, byte for byte."
  }
}

# The full apply needs edge-ca/ca.pem, which `bun run setup origin-pull` writes after the cluster exists; the error
# names the file and that command.
run "fails_at_plan_without_the_origin_pull_ca" {
  command = plan

  variables {
    origin_pull_ca_file = "tests/fixtures/missing-ca.pem"
  }

  expect_failures = [helm_release.platform]
}

run "refuses_a_file_that_is_not_a_certificate" {
  command = plan

  variables {
    origin_pull_ca_file = "tests/fixtures/values-civo-test.yaml"
  }

  expect_failures = [helm_release.platform]
}

run "refuses_a_file_that_holds_a_private_key" {
  command = plan

  variables {
    origin_pull_ca_file = "tests/fixtures/edge-ca-with-key-marker.pem"
  }

  expect_failures = [helm_release.platform]
}
