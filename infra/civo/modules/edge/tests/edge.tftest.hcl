# The environment's Cloudflare zone (D18, D19): four proxied records to the load balancer, Postmark's three DNS-only mail
# records once the owner gives their values, TLS strict to the origin,
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

run "limits_the_sign_in_form_per_client_address_within_the_free_plan" {
  command = plan

  assert {
    condition     = cloudflare_ruleset.rate_limit.phase == "http_ratelimit" && cloudflare_ruleset.rate_limit.kind == "zone" && length(cloudflare_ruleset.rate_limit.rules) == 1
    error_message = "One rate limiting rule in the zone's http_ratelimit phase: the free plan allows no more."
  }

  assert {
    condition = (
      cloudflare_ruleset.rate_limit.rules[0].expression == "(http.request.uri.path eq \"/login\")"
      && cloudflare_ruleset.rate_limit.rules[0].action == "block"
    )
    error_message = "The rule must match ID's sign-in form by path alone, the one field the free plan allows, so that machine clients are never counted."
  }

  assert {
    condition = (
      cloudflare_ruleset.rate_limit.rules[0].ratelimit.characteristics == tolist(["cf.colo.id", "ip.src"])
      && cloudflare_ruleset.rate_limit.rules[0].ratelimit.period == 10
      && cloudflare_ruleset.rate_limit.rules[0].ratelimit.mitigation_timeout == 10
      && cloudflare_ruleset.rate_limit.rules[0].ratelimit.requests_per_period == 60
    )
    error_message = "The rule must count per client address over 10 seconds and block for 10 seconds, the free plan's only values."
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
        [cloudflare_ruleset.config.rules[0].expression, cloudflare_ruleset.cache.rules[0].expression, cloudflare_ruleset.rate_limit.rules[0].expression],
        cloudflare_origin_ca_certificate.this.hostnames,
      ) : !strcontains(text, "www") && text != "answerable.org"
    ])
    error_message = "Nothing the edge module writes may name www.answerable.org or the apex."
  }

  assert {
    condition     = cloudflare_ruleset.config.name == "answerable-production-config" && cloudflare_ruleset.cache.name == "answerable-production-cache" && cloudflare_ruleset.rate_limit.name == "answerable-production-rate-limit"
    error_message = "The rulesets must be named answerable-<environment>-config, -cache and -rate-limit."
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

# Postmark's records for the mail domain id.<zone>. None without values: the owner sends them after adding the domain in
# Postmark. With them, exactly three DNS-only records under id.<zone>: the DKIM TXT, the Return-Path CNAME to pm.mtasv.net
# (a proxied one does not verify) and the DMARC TXT. Never SPF, never a name at the apex.
run "writes_no_mail_record_without_the_values" {
  command = plan

  assert {
    condition     = length(cloudflare_dns_record.mail) == 0 && length(output.mail_records) == 0
    error_message = "Without mail_records the module must write no mail record."
  }

  assert {
    condition     = length(cloudflare_dns_record.service) == 4 && toset([for record in cloudflare_dns_record.service : record.name]) == toset(["id.answerable-staging.uk", "toolbox.answerable-staging.uk", "admin-mcp.answerable-staging.uk", "mcp.answerable-staging.uk"])
    error_message = "Without mail_records the zone must hold exactly today's four service records and no other."
  }
}

run "writes_postmarks_three_records_dns_only_when_given_the_values" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDexample"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none; rua=mailto:dmarc@answerable-staging.uk"
    }
  }

  assert {
    condition     = toset(keys(cloudflare_dns_record.mail)) == toset(["dkim", "return_path", "dmarc"])
    error_message = "Postmark's three records, DKIM, Return-Path and DMARC, and no other."
  }

  assert {
    condition = (
      cloudflare_dns_record.mail["dkim"].type == "TXT"
      && cloudflare_dns_record.mail["dkim"].name == "20260101000000pm._domainkey.id.answerable-staging.uk"
      && cloudflare_dns_record.mail["dkim"].content == "\"k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDexample\""
      && cloudflare_dns_record.mail["dkim"].proxied == false
    )
    error_message = "The DKIM record must be a DNS-only TXT at <selector>._domainkey.id.<zone>, its value quoted as Cloudflare keeps TXT content."
  }

  assert {
    condition = (
      cloudflare_dns_record.mail["return_path"].type == "CNAME"
      && cloudflare_dns_record.mail["return_path"].name == "pm-bounces.id.answerable-staging.uk"
      && cloudflare_dns_record.mail["return_path"].content == "pm.mtasv.net"
      && cloudflare_dns_record.mail["return_path"].proxied == false
    )
    error_message = "The Return-Path must be a DNS-only CNAME to pm.mtasv.net: a proxied one does not verify."
  }

  assert {
    condition = (
      cloudflare_dns_record.mail["dmarc"].type == "TXT"
      && cloudflare_dns_record.mail["dmarc"].name == "_dmarc.id.answerable-staging.uk"
      && cloudflare_dns_record.mail["dmarc"].content == "\"v=DMARC1; p=none; rua=mailto:dmarc@answerable-staging.uk\""
      && cloudflare_dns_record.mail["dmarc"].proxied == false
    )
    error_message = "The DMARC record must be a DNS-only TXT at _dmarc.id.<zone>, its value quoted."
  }

  assert {
    condition = alltrue([
      for record in cloudflare_dns_record.mail :
      record.zone_id == "0123456789abcdef0123456789abcdef" && record.ttl == 1 && endswith(record.name, ".id.answerable-staging.uk")
    ])
    error_message = "Every mail record sits in the zone, on automatic TTL, under id.<zone>: never the apex, and never an SPF record."
  }

  assert {
    condition     = output.mail_records == tolist(["CNAME pm-bounces.id.answerable-staging.uk", "TXT 20260101000000pm._domainkey.id.answerable-staging.uk", "TXT _dmarc.id.answerable-staging.uk"])
    error_message = "The module must report the three mail records it writes."
  }

  assert {
    condition     = length(cloudflare_dns_record.service) == 4 && alltrue([for record in cloudflare_dns_record.service : record.type == "A" && record.proxied])
    error_message = "The mail records must leave the four proxied service records as they are."
  }
}

# A 2048-bit key is 392 characters of base64, over the 255 bytes of one TXT character string. Cloudflare splits a longer
# string itself and keeps it as quoted strings (developers.cloudflare.com, the API's create call), and the provider
# normalises nothing, so the content is written as Cloudflare keeps it, or every plan would show drift.
run "writes_a_key_over_255_bytes_as_two_quoted_strings" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAbjQLnP+zepicpUTmu3gKLHiQHT+zNzh2hRGjBhevoB1L9RIvNEVUxTveLruM0rfj0WAK1jHDhaXXzOI8d4VFmtvBtMkA/+SNV1tdpcY4BAEl9l2w/j4kSUt26phkV9mGCE/tCLl4r019GWp0RqhrWACeY2thHbFiEbZamq3/KcXlLZxQjFAjRzRNjAetkcvWBor8df9ikvBioJyjgcieced7mprp4wsNvbb1EKJk753ngVAde2uSronrBZxat0PbZ1humPrSfaC5lovAOaHvNMk5ubjlI6i++J1HhgjF7PbKNYdY9tJ+bPRScpN5d6dI/Yg5HbZ5ztp9x78fAF7oebIDAQAB"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  assert {
    condition     = cloudflare_dns_record.mail["dkim"].content == "\"k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAbjQLnP+zepicpUTmu3gKLHiQHT+zNzh2hRGjBhevoB1L9RIvNEVUxTveLruM0rfj0WAK1jHDhaXXzOI8d4VFmtvBtMkA/+SNV1tdpcY4BAEl9l2w/j4kSUt26phkV9mGCE/tCLl4r019GWp0RqhrWACeY2thHbFiEbZamq3/KcXlLZxQjFAjRzRNjAetkcvWBor8df9ikvB\" \"ioJyjgcieced7mprp4wsNvbb1EKJk753ngVAde2uSronrBZxat0PbZ1humPrSfaC5lovAOaHvNMk5ubjlI6i++J1HhgjF7PbKNYdY9tJ+bPRScpN5d6dI/Yg5HbZ5ztp9x78fAF7oebIDAQAB\""
    error_message = "A DKIM value over 255 bytes must be written as quoted strings of 255 bytes and the rest, separated by a space."
  }

  assert {
    condition     = replace(cloudflare_dns_record.mail["dkim"].content, "\" \"", "") == "\"${var.mail_records.dkim_value}\""
    error_message = "Joining the strings must give back the key exactly."
  }
}

run "writes_a_key_of_exactly_255_bytes_as_one_string" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAbjQLnP+zepicpUTmu3gKLHiQHT+zNzh2hRGjBhevoB1L9RIvNEVUxTveLruM0rfj0WAK1jHDhaXXzOI8d4VFmtvBtMkA/+SNV1tdpcY4BAEl9l2w/j4kSUt26phkV9mGCE/tCLl4r019GWp0RqhrWACeY2thHbFiEbZamq3/KcXlLZxQjFAjRzRNjAetkcvWBor8df9ikvB"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  assert {
    condition     = cloudflare_dns_record.mail["dkim"].content == "\"${var.mail_records.dkim_value}\""
    error_message = "A value of exactly 255 bytes must stay one quoted string."
  }
}

# Production's records sit beside Vercel's DNS-only www; the mail records go under the mail domain and nowhere else.
run "writes_production_mail_records_under_the_mail_domain_and_never_at_the_apex_or_www" {
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
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable.org"
      dkim_value       = "k=rsa;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDexample"
      return_path_host = "pm-bounces.id.answerable.org"
      dmarc_value      = "v=DMARC1; p=none; rua=mailto:dmarc@answerable.org"
    }
  }

  assert {
    condition = alltrue([
      for record in cloudflare_dns_record.mail :
      endswith(record.name, ".id.answerable.org") && !strcontains(record.name, "www") && record.name != "answerable.org"
    ])
    error_message = "Production's mail records must sit under id.answerable.org, never at the apex and never www."
  }

  assert {
    condition     = alltrue([for record in cloudflare_dns_record.mail : record.type != "TXT" || !strcontains(record.content, "spf1")])
    error_message = "No SPF record: Postmark asks for none on the From domain, and the apex's Microsoft 365 records are not this module's."
  }
}

run "refuses_a_dkim_host_at_the_apex_or_off_the_mail_domain" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_dkim_host_that_is_not_a_domainkey_name" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "selector.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_return_path_host_at_the_apex" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_return_path_host_that_is_the_mail_domain_itself" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_return_path_host_beside_the_mail_domain_not_under_it" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_dkim_value_that_is_not_a_public_key" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "v=spf1 include:spf.protection.outlook.com ~all"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_dmarc_value_that_is_not_dmarc" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=spf1 -all"
    }
  }

  expect_failures = [var.mail_records]
}

run "refuses_a_quoted_value_which_the_module_quotes_itself" {
  command = plan

  variables {
    mail_records = {
      dkim_host        = "20260101000000pm._domainkey.id.answerable-staging.uk"
      dkim_value       = "k=rsa;p=MIGfMA0G"
      return_path_host = "pm-bounces.id.answerable-staging.uk"
      dmarc_value      = "v=DMARC1; p=none; rua=\"mailto:dmarc@answerable-staging.uk\""
    }
  }

  expect_failures = [var.mail_records]
}
