locals {
  prefix = "answerable-${var.environment}"

  # Cloudflare's Rules language: a set of quoted names, sorted so the expression is stable.
  host_set = "{${join(" ", [for host in sort(values(var.hostnames)) : "\"${host}\""])}}"
}

# The three service hostnames, proxied, to the load balancer's reserved address. Every name is first-level, so
# Universal SSL covers it and no certificate add-on is needed (D12). An A record because the origin is an address.
resource "cloudflare_dns_record" "service" {
  for_each = var.hostnames

  zone_id = var.zone_id
  name    = each.value
  type    = "A"
  content = var.origin_ip
  proxied = true
  ttl     = 1
  comment = "${local.prefix} ${replace(each.key, "_", "-")}, managed by Terraform in infra/civo"
}

# Zone-wide TLS. Full (strict): Cloudflare verifies the origin's certificate, the Origin CA one below. These settings
# apply to proxied records only, so a DNS-only record such as production's www is untouched (D19).
resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.zone_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = var.zone_id
  setting_id = "min_tls_version"
  value      = "1.2"
}

resource "cloudflare_zone_setting" "tls_1_3" {
  zone_id    = var.zone_id
  setting_id = "tls_1_3"
  value      = "on"
}

# HSTS at the edge for a year; subdomains and preload stay off until every name in the zone is HTTPS-only by design.
resource "cloudflare_zone_setting" "security_header" {
  zone_id    = var.zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 31536000
      include_subdomains = false
      preload            = false
      nosniff            = true
    }
  }
}

# Zone-level authenticated origin pulls: on every proxied request Cloudflare presents the zone's own client
# certificate (below) to the origin, and Traefik's default TLSOption refuses any connection without one signed by the
# origin-pull CA (charts/platform, originPull.caPem). Another Cloudflare customer cannot present it, so the origin
# answers this zone's proxy alone (D19, D31).
resource "cloudflare_authenticated_origin_pulls_settings" "this" {
  zone_id = var.zone_id
  enabled = true
}

# The origin-pull certificate and the origin certificate below, and their keys, are made here and kept in state only:
# no person and no file holds them. Rotating either is `terraform apply -replace` on its key:
# module.edge.tls_private_key.origin_pull_ca for the origin-pull CA and the client certificate it signs,
# module.edge.tls_private_key.origin_pull_client for the client certificate alone, module.edge.tls_private_key.origin
# for the origin certificate. The apply uploads the new certificate before it deletes the old one, but there is a
# short interruption while Cloudflare and Traefik switch: Cloudflare presents the newest client certificate as soon as
# it is uploaded, and Traefik trusts a new CA, or serves a new origin certificate, only once the platform release or
# the origin-tls Secret has been updated.

# The origin-pull CA: ECDSA P-256, ten years, signing certificates and nothing else. Its certificate is public
# (output origin_pull_ca_pem, the platform chart's originPull.caPem).
resource "tls_private_key" "origin_pull_ca" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_self_signed_cert" "origin_pull_ca" {
  private_key_pem       = tls_private_key.origin_pull_ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 87600
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name = "Answerable origin-pull CA (${var.zone_name})"
  }
}

# The client certificate Cloudflare presents: a leaf (Cloudflare refuses a CA here) signed by the origin-pull CA, for
# client authentication only, five years.
resource "tls_private_key" "origin_pull_client" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin_pull_client" {
  private_key_pem = tls_private_key.origin_pull_client.private_key_pem

  subject {
    common_name = "cloudflare-origin-pull.${var.zone_name}"
  }
}

resource "tls_locally_signed_cert" "origin_pull_client" {
  cert_request_pem      = tls_cert_request.origin_pull_client.cert_request_pem
  ca_private_key_pem    = tls_private_key.origin_pull_ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.origin_pull_ca.cert_pem
  validity_period_hours = 43800
  allowed_uses          = ["client_auth", "digital_signature"]
}

# The zone-level upload. Cloudflare uses the most recently uploaded certificate, so the replacement is created first.
resource "cloudflare_authenticated_origin_pulls_certificate" "this" {
  zone_id     = var.zone_id
  certificate = tls_locally_signed_cert.origin_pull_client.cert_pem
  private_key = tls_private_key.origin_pull_client.private_key_pem

  lifecycle {
    create_before_destroy = true
  }
}

# The origin's server certificate, from Cloudflare's Origin CA: the three hostnames, ECDSA, fifteen years (Cloudflare's
# longest). Cloudflare alone trusts it, which is all Full (strict) needs, and it only ever encrypts Cloudflare to the
# origin. The key never leaves Terraform but for the origin-tls Secret the platform module writes. Cloudflare sends no
# expiry notice: output origin_certificate_expires_on says when.
resource "tls_private_key" "origin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  dns_names       = sort(values(var.hostnames))

  subject {
    common_name = var.hostnames["id"]
  }
}

resource "cloudflare_origin_ca_certificate" "this" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = sort(values(var.hostnames))
  request_type       = "origin-ecc"
  requested_validity = 5475

  # Deleting an Origin CA certificate revokes it: the replacement is issued, and the Secret updated, first.
  lifecycle {
    create_before_destroy = true
  }
}

# For the three machine-facing hostnames, no Browser Integrity Check and no challenge: MCP hosts, Claude Code and the
# servers' calls to ID are not browsers and would receive an HTML challenge instead of JSON (D18). Elsewhere in the
# zone the defaults stand. One ruleset per zone and phase: an existing one must be imported first (see the README).
resource "cloudflare_ruleset" "config" {
  zone_id     = var.zone_id
  name        = "${local.prefix}-config"
  description = "Answerable ${var.environment}: no browser check or challenge for the machine-facing hostnames"
  kind        = "zone"
  phase       = "http_config_settings"

  rules = [
    {
      ref         = "answerable_machine_hosts"
      description = "Machine clients: no Browser Integrity Check, Security Level essentially off"
      expression  = "(http.host in ${local.host_set})"
      action      = "set_config"
      action_parameters = {
        bic            = false
        security_level = "essentially_off"
      }
      enabled = true
    },
  ]
}

# Cloudflare caches nothing from the three hostnames except their static /assets/: tokens, discovery documents and
# MCP responses must always come from the origin.
resource "cloudflare_ruleset" "cache" {
  zone_id     = var.zone_id
  name        = "${local.prefix}-cache"
  description = "Answerable ${var.environment}: bypass the cache except /assets/"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [
    {
      ref         = "answerable_no_cache"
      description = "Bypass the cache for everything but /assets/"
      expression  = "(http.host in ${local.host_set} and not starts_with(http.request.uri.path, \"/assets/\"))"
      action      = "set_cache_settings"
      action_parameters = {
        cache = false
      }
      enabled = true
    },
  ]
}
