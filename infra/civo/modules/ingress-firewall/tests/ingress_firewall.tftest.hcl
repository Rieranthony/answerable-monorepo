# The load balancer's firewall and address: HTTPS from Cloudflare's published ranges and from nothing else, no plain
# HTTP at all (Cloudflare redirects), and a reserved address that the DNS records and the Service annotation share.
mock_provider "civo" {}

variables {
  environment  = "staging"
  network_id   = "22222222-2222-4222-8222-222222222222"
  network_cidr = "10.10.0.0/24"
  cloudflare_ipv4_cidrs = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
}

run "admits_https_from_cloudflare_only" {
  command = plan

  assert {
    condition     = civo_vpc_firewall.this.name == "answerable-staging-load-balancer" && civo_vpc_firewall.this.network_id == "22222222-2222-4222-8222-222222222222"
    error_message = "The firewall must be answerable-<environment>-load-balancer on the private network."
  }

  assert {
    condition     = civo_vpc_firewall.this.create_default_rules == false
    error_message = "Civo's default rules open ports to everyone; the firewall must carry only its declared rules."
  }

  assert {
    condition     = length(civo_vpc_firewall.this.ingress_rule) == 1
    error_message = "The load balancer admits one thing: HTTPS from Cloudflare."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.ingress_rule :
      rule.protocol == "tcp" && rule.port_range == "443" && rule.action == "allow"
      && rule.cidr == toset(var.cloudflare_ipv4_cidrs)
    ])
    error_message = "443 must be admitted from exactly Cloudflare's published IPv4 ranges."
  }

  assert {
    condition = alltrue([
      for rule in setunion(civo_vpc_firewall.this.ingress_rule, civo_vpc_firewall.this.egress_rule) :
      !contains(rule.cidr, "0.0.0.0/0") && !contains(rule.cidr, "::/0")
    ])
    error_message = "Nothing in the load balancer's firewall may involve the whole internet."
  }

  assert {
    condition = alltrue([
      for rule in civo_vpc_firewall.this.egress_rule : rule.cidr == toset(["10.10.0.0/24"])
    ]) && length(civo_vpc_firewall.this.egress_rule) == 1
    error_message = "The load balancer may only reach its backends, on the private network."
  }
}

run "reserves_the_load_balancer_address" {
  command = plan

  assert {
    condition     = civo_vpc_reserved_ip.this.name == "answerable-staging-load-balancer"
    error_message = "The reserved address must be named answerable-<environment>-load-balancer."
  }
}

run "refuses_no_ranges" {
  command = plan

  variables {
    cloudflare_ipv4_cidrs = []
  }

  expect_failures = [var.cloudflare_ipv4_cidrs]
}

run "refuses_the_whole_internet" {
  command = plan

  variables {
    cloudflare_ipv4_cidrs = ["173.245.48.0/20", "0.0.0.0/0"]
  }

  expect_failures = [var.cloudflare_ipv4_cidrs]
}

run "refuses_ipv6_ranges_the_ipv4_load_balancer_never_sees" {
  command = plan

  variables {
    cloudflare_ipv4_cidrs = ["2400:cb00::/32"]
  }

  expect_failures = [var.cloudflare_ipv4_cidrs]
}
