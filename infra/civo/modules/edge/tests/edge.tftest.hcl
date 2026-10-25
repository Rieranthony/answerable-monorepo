# The environment's Cloudflare zone (D18, D19): four proxied records to the load balancer, TLS strict to the origin,
# origin pulls on with the zone's own client certificate, the origin's certificate from Cloudflare's Origin CA, and for
# the four machine-facing hostnames no browser check, no challenge and no cache except /assets/. Nothing here may
# touch any other name in the zone, above all production's www, which Vercel serves.
mock_provider "cloudflare" {
  override_during = plan
}

mock_provider "tls" {
  override_during = plan
}

# Placeholders for what the tls provider and the Origin CA would generate, one per resource so that the wiring below
# can tell them apart. The tests assert on arguments and wiring, never on certificate contents.
override_resource {
  target          = tls_private_key.origin_pull_ca
  override_during = plan
  values = {
    private_key_pem = "placeholder: origin-pull CA key"
  }
}

override_resource {
  target          = tls_self_signed_cert.origin_pull_ca
  override_during = plan
  values = {
    cert_pem = "placeholder: origin-pull CA certificate"
  }
}

override_resource {
  target          = tls_private_key.origin_pull_client
  override_during = plan
  values = {
    private_key_pem = "placeholder: origin-pull client key"
  }
}

override_resource {
  target          = tls_cert_request.origin_pull_client
  override_during = plan
  values = {
    cert_request_pem = "placeholder: origin-pull client request"
  }
}

override_resource {
  target          = tls_locally_signed_cert.origin_pull_client
  override_during = plan
  values = {
    cert_pem = "placeholder: origin-pull client certificate"
  }
}

override_resource {
  target          = tls_private_key.origin
  override_during = plan
  values = {
    private_key_pem = "placeholder: origin key"
  }
}

override_resource {
  target          = tls_cert_request.origin
  override_during = plan
  values = {
    cert_request_pem = "placeholder: origin request"
  }
}

override_resource {
  target          = cloudflare_origin_ca_certificate.this
  override_during = plan
  values = {
    certificate = "placeholder: origin certificate"
    expires_on  = "2041-10-15T12:00:00Z"
  }
}

variables {
  environment = "staging"
  zone_id     = "0123456789abcdef0123456789abcdef"
  zone_name   = "answerable-staging.uk"
  origin_ip   = "192.0.2.10"
  hostnames = {
    id        = "id.answerable-staging.uk"
    toolbox   = "toolbox.answerable-staging.uk"
    admin_mcp = "admin-mcp.answerable-staging.uk"
    mcp       = "mcp.answerable-staging.uk"
  }
}

run "points_four_proxied_records_at_the_load_balancer" {
  command = plan

  assert {
    condition     = toset([for record in cloudflare_dns_record.service : record.name]) == toset(["id.answerable-staging.uk", "toolbox.answerable-staging.uk", "admin-mcp.answerable-staging.uk", "mcp.answerable-staging.uk"])
    error_message = "The module must write exactly the four service records."
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

# The origin-pull CA: ECDSA P-256, ten years, a CA that signs certificates and nothing else, named after the zone.
run "makes_the_origin_pull_ca" {
  command = plan

  assert {
    condition     = tls_private_key.origin_pull_ca.algorithm == "ECDSA" && tls_private_key.origin_pull_ca.ecdsa_curve == "P256"
    error_message = "The origin-pull CA's key must be ECDSA P-256."
  }

  assert {
    condition = (
      tls_self_signed_cert.origin_pull_ca.is_ca_certificate
      && tls_self_signed_cert.origin_pull_ca.validity_period_hours == 87600
      && toset(tls_self_signed_cert.origin_pull_ca.allowed_uses) == toset(["cert_signing", "crl_signing"])
      && tls_self_signed_cert.origin_pull_ca.subject[0].common_name == "Answerable origin-pull CA (answerable-staging.uk)"
    )
    error_message = "The origin-pull CA must be a CA for ten years, signing certificates and revocation lists only, named Answerable origin-pull CA (<zone>)."
  }

  assert {
    condition     = nonsensitive(tls_self_signed_cert.origin_pull_ca.private_key_pem) == "placeholder: origin-pull CA key"
    error_message = "The CA certificate must be self-signed with the CA's own key."
  }

  assert {
    condition     = output.origin_pull_ca_pem == "placeholder: origin-pull CA certificate" && !issensitive(output.origin_pull_ca_pem)
    error_message = "origin_pull_ca_pem must be the CA's certificate, a public value."
  }
}

# The client certificate Cloudflare presents: a leaf the CA signs, for client authentication, five years, uploaded to
# the zone with its own key.
run "signs_and_uploads_the_client_certificate" {
  command = plan

  assert {
    condition     = tls_private_key.origin_pull_client.algorithm == "ECDSA" && tls_private_key.origin_pull_client.ecdsa_curve == "P256"
    error_message = "The client certificate's key must be ECDSA P-256."
  }

  assert {
    condition = (
      tls_cert_request.origin_pull_client.subject[0].common_name == "cloudflare-origin-pull.answerable-staging.uk"
      && nonsensitive(tls_cert_request.origin_pull_client.private_key_pem) == "placeholder: origin-pull client key"
    )
    error_message = "The client's request must be cloudflare-origin-pull.<zone>, made with the client's own key."
  }

  assert {
    condition = (
      tls_locally_signed_cert.origin_pull_client.cert_request_pem == "placeholder: origin-pull client request"
      && tls_locally_signed_cert.origin_pull_client.ca_cert_pem == "placeholder: origin-pull CA certificate"
      && nonsensitive(tls_locally_signed_cert.origin_pull_client.ca_private_key_pem) == "placeholder: origin-pull CA key"
    )
    error_message = "The origin-pull CA must sign the client's request."
  }

  assert {
    condition = (
      toset(tls_locally_signed_cert.origin_pull_client.allowed_uses) == toset(["client_auth", "digital_signature"])
      && tls_locally_signed_cert.origin_pull_client.validity_period_hours == 43800
    )
    error_message = "The client certificate must serve client authentication only (Traefik checks client_auth), for five years."
  }

  assert {
    condition = (
      cloudflare_authenticated_origin_pulls_certificate.this.zone_id == "0123456789abcdef0123456789abcdef"
      && cloudflare_authenticated_origin_pulls_certificate.this.certificate == "placeholder: origin-pull client certificate"
      && nonsensitive(cloudflare_authenticated_origin_pulls_certificate.this.private_key) == "placeholder: origin-pull client key"
    )
    error_message = "The zone's upload must be the signed client certificate with the client's key, never the CA."
  }
}

# The origin's server certificate: Cloudflare's Origin CA, exactly the four hostnames, ECDSA, 5475 days. Adding mcp reissues it once, before
# the old one is revoked (create_before_destroy).
run "requests_the_origin_certificate_for_the_four_hostnames" {
  command = plan

  assert {
    condition     = tls_private_key.origin.algorithm == "ECDSA" && tls_private_key.origin.ecdsa_curve == "P256"
    error_message = "The origin certificate's key must be ECDSA P-256, which origin-ecc signs."
  }

  assert {
    condition = (
      tls_cert_request.origin.dns_names == tolist(["admin-mcp.answerable-staging.uk", "id.answerable-staging.uk", "mcp.answerable-staging.uk", "toolbox.answerable-staging.uk"])
      && tls_cert_request.origin.subject[0].common_name == "id.answerable-staging.uk"
      && nonsensitive(tls_cert_request.origin.private_key_pem) == "placeholder: origin key"
    )
    error_message = "The origin's request must name the four hostnames, with ID's as the common name, made with the origin's key."
  }

  assert {
    condition = (
      cloudflare_origin_ca_certificate.this.hostnames == tolist(["admin-mcp.answerable-staging.uk", "id.answerable-staging.uk", "mcp.answerable-staging.uk", "toolbox.answerable-staging.uk"])
      && cloudflare_origin_ca_certificate.this.request_type == "origin-ecc"
      && cloudflare_origin_ca_certificate.this.requested_validity == 5475
      && cloudflare_origin_ca_certificate.this.csr == "placeholder: origin request"
    )
    error_message = "The Origin CA request must name exactly the four hostnames, ECC, for 5475 days, from the origin's own request."
  }

  assert {
    condition = (
      output.origin_certificate_pem == "placeholder: origin certificate"
      && output.origin_certificate_expires_on == "2041-10-15T12:00:00Z"
      && issensitive(output.origin_private_key_pem)
      && nonsensitive(output.origin_private_key_pem) == "placeholder: origin key"
    )
    error_message = "The module must hand out the Origin CA certificate, its expiry and, as a sensitive value, its key."
  }
}

run "turns_challenges_off_for_the_four_hostnames_only" {
  command = plan

  assert {
    condition     = cloudflare_ruleset.config.phase == "http_config_settings" && cloudflare_ruleset.config.kind == "zone" && length(cloudflare_ruleset.config.rules) == 1
    error_message = "One configuration rule in the zone's http_config_settings phase."
  }

  assert {
    condition     = cloudflare_ruleset.config.rules[0].expression == "(http.host in {\"admin-mcp.answerable-staging.uk\" \"id.answerable-staging.uk\" \"mcp.answerable-staging.uk\" \"toolbox.answerable-staging.uk\"})"
    error_message = "The configuration rule must match exactly the four service hostnames."
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
      cloudflare_ruleset.cache.rules[0].expression == "(http.host in {\"admin-mcp.answerable-staging.uk\" \"id.answerable-staging.uk\" \"mcp.answerable-staging.uk\" \"toolbox.answerable-staging.uk\"} and not starts_with(http.request.uri.path, \"/assets/\"))"
      && cloudflare_ruleset.cache.rules[0].action == "set_cache_settings"
      && cloudflare_ruleset.cache.rules[0].action_parameters.cache == false
    )
    error_message = "Every response from the four hostnames except /assets/ must bypass Cloudflare's cache."
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
      mcp       = "mcp.answerable.org"
    }
  }

  assert {
    condition = alltrue([
      for text in concat(
        [for record in cloudflare_dns_record.service : record.name],
        [cloudflare_ruleset.config.rules[0].expression, cloudflare_ruleset.cache.rules[0].expression],
        cloudflare_origin_ca_certificate.this.hostnames,
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
      mcp       = "mcp.answerable-staging.uk"
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
      mcp       = "mcp.answerable-staging.uk"
    }
  }

  expect_failures = [var.hostnames]
}

run "refuses_a_missing_service" {
  command = plan

  variables {
    hostnames = {
      id        = "id.answerable-staging.uk"
      toolbox   = "toolbox.answerable-staging.uk"
      admin_mcp = "admin-mcp.answerable-staging.uk"
    }
  }

  expect_failures = [var.hostnames]
}
