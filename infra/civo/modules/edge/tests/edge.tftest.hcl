# The environment's Cloudflare zone (D18, D19): three proxied records to the load balancer, TLS strict to the origin,
# origin pulls on, and for the three machine-facing hostnames no browser check, no challenge and no cache except
# /assets/. Nothing here may touch any other name in the zone, above all production's www, which Vercel serves.
mock_provider "cloudflare" {}

variables {
  environment = "staging"
  zone_id     = "0123456789abcdef0123456789abcdef"
  zone_name   = "answerable-staging.uk"
  origin_ip   = "192.0.2.10"
  hostnames = {
    id        = "id.answerable-staging.uk"
    toolbox   = "toolbox.answerable-staging.uk"
    admin_mcp = "admin-mcp.answerable-staging.uk"
  }
}

run "points_three_proxied_records_at_the_load_balancer" {
  command = plan

  assert {
    condition     = toset([for record in cloudflare_dns_record.service : record.name]) == toset(["id.answerable-staging.uk", "toolbox.answerable-staging.uk", "admin-mcp.answerable-staging.uk"])
    error_message = "The module must write exactly the three service records."
  }

  assert {
    condition = alltrue([
      for record in cloudflare_dns_record.service :
      record.type == "A" && record.content == "192.0.2.10" && record.proxied && record.ttl == 1 && record.zone_id == "0123456789abcdef0123456789abcdef"
    ])
    error_message = "Every service record must be a proxied A record to the load balancer's reserved address."
  }
}

run "holds_tls_strict_with_origin_pulls" {
  command = plan

  assert {
    condition     = cloudflare_zone_setting.ssl.setting_id == "ssl" && cloudflare_zone_setting.ssl.value == "strict"
    error_message = "Cloudflare must verify the origin's certificate (Full strict)."
  }

  assert {
    condition     = cloudflare_zone_setting.always_use_https.value == "on" && cloudflare_zone_setting.min_tls_version.value == "1.2" && cloudflare_zone_setting.tls_1_3.value == "on"
    error_message = "HTTPS only, TLS 1.2 at least, TLS 1.3 on."
  }

  assert {
    condition = (
      cloudflare_zone_setting.security_header.setting_id == "security_header"
      && cloudflare_zone_setting.security_header.value.strict_transport_security.enabled
      && cloudflare_zone_setting.security_header.value.strict_transport_security.max_age == 31536000
      && !cloudflare_zone_setting.security_header.value.strict_transport_security.include_subdomains
      && !cloudflare_zone_setting.security_header.value.strict_transport_security.preload
    )
    error_message = "HSTS for a year at the edge, without subdomains or preload for now."
  }

  assert {
    condition     = cloudflare_authenticated_origin_pulls_settings.this.enabled && cloudflare_authenticated_origin_pulls_settings.this.zone_id == "0123456789abcdef0123456789abcdef"
    error_message = "Zone-level authenticated origin pulls must be on."
  }
}

run "turns_challenges_off_for_the_three_hostnames_only" {
  command = plan

  assert {
    condition     = cloudflare_ruleset.config.phase == "http_config_settings" && cloudflare_ruleset.config.kind == "zone" && length(cloudflare_ruleset.config.rules) == 1
    error_message = "One configuration rule in the zone's http_config_settings phase."
  }

  assert {
    condition     = cloudflare_ruleset.config.rules[0].expression == "(http.host in {\"admin-mcp.answerable-staging.uk\" \"id.answerable-staging.uk\" \"toolbox.answerable-staging.uk\"})"
    error_message = "The configuration rule must match exactly the three service hostnames."
  }

  assert {
    condition = (
      cloudflare_ruleset.config.rules[0].action == "set_config"
      && cloudflare_ruleset.config.rules[0].action_parameters.bic == false
      && cloudflare_ruleset.config.rules[0].action_parameters.security_level == "essentially_off"
    )
    error_message = "MCP hosts and machine clients must never meet a browser check or a challenge page."
  }
}

run "caches_nothing_but_assets" {
  command = plan

  assert {
    condition     = cloudflare_ruleset.cache.phase == "http_request_cache_settings" && length(cloudflare_ruleset.cache.rules) == 1
    error_message = "One cache rule in the zone's http_request_cache_settings phase."
  }

  assert {
    condition = (
      cloudflare_ruleset.cache.rules[0].expression == "(http.host in {\"admin-mcp.answerable-staging.uk\" \"id.answerable-staging.uk\" \"toolbox.answerable-staging.uk\"} and not starts_with(http.request.uri.path, \"/assets/\"))"
      && cloudflare_ruleset.cache.rules[0].action == "set_cache_settings"
      && cloudflare_ruleset.cache.rules[0].action_parameters.cache == false
    )
    error_message = "Every response from the three hostnames except /assets/ must bypass Cloudflare's cache."
  }
}

run "leaves_production_www_alone" {
  command = plan

  variables {
    environment = "production"
    zone_name   = "answerable.org"
    hostnames = {
      id        = "id.answerable.org"
      toolbox   = "toolbox.answerable.org"
      admin_mcp = "admin-mcp.answerable.org"
    }
  }

  assert {
    condition = alltrue([
      for text in concat(
        [for record in cloudflare_dns_record.service : record.name],
        [cloudflare_ruleset.config.rules[0].expression, cloudflare_ruleset.cache.rules[0].expression],
      ) : !strcontains(text, "www") && text != "answerable.org"
    ])
    error_message = "Nothing the edge module writes may name www.answerable.org or the apex."
  }

  assert {
    condition     = cloudflare_ruleset.config.name == "answerable-production-config" && cloudflare_ruleset.cache.name == "answerable-production-cache"
    error_message = "The rulesets must be named answerable-<environment>-config and -cache."
  }
}

run "refuses_a_second_level_hostname_universal_ssl_does_not_cover" {
  command = plan

  variables {
    hostnames = {
      id        = "id.staging.answerable-staging.uk"
      toolbox   = "toolbox.answerable-staging.uk"
      admin_mcp = "admin-mcp.answerable-staging.uk"
    }
  }

  expect_failures = [var.hostnames]
}

run "refuses_www" {
  command = plan

  variables {
    hostnames = {
      id        = "www.answerable-staging.uk"
      toolbox   = "toolbox.answerable-staging.uk"
      admin_mcp = "admin-mcp.answerable-staging.uk"
    }
  }

  expect_failures = [var.hostnames]
}

run "refuses_a_missing_service" {
  command = plan

  variables {
    hostnames = {
      id      = "id.answerable-staging.uk"
      toolbox = "toolbox.answerable-staging.uk"
    }
  }

  expect_failures = [var.hostnames]
}
