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
  comment = "${local.prefix} ${replace(each.key, "_", "-")}, managed by Terraform in infra/civo/envs/${var.environment}"
}

# Zone-wide TLS. Full (strict): Cloudflare verifies the origin's certificate (cert-manager's Let's Encrypt one). These
# settings apply to proxied records only, so a DNS-only record such as production's www is untouched (D19).
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

# Zone-level authenticated origin pulls: Cloudflare presents the zone's own client certificate to the origin, which
# Traefik verifies (a TLSOption with clientAuth, D31). The certificate is uploaded once from a trusted machine and never passes through
# Terraform (D19); until it is uploaded Cloudflare presents its shared one, which the origin refuses.
resource "cloudflare_authenticated_origin_pulls_settings" "this" {
  zone_id = var.zone_id
  enabled = true
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
