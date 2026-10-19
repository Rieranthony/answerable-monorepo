output "hostnames" {
  description = "The service hostnames the zone now proxies to the origin."
  value       = sort([for record in cloudflare_dns_record.service : record.name])
}

output "config_ruleset_id" {
  description = "The ID of the zone's http_config_settings ruleset."
  value       = cloudflare_ruleset.config.id
}

output "cache_ruleset_id" {
  description = "The ID of the zone's http_request_cache_settings ruleset."
  value       = cloudflare_ruleset.cache.id
}

output "origin_pull_ca_pem" {
  description = "The origin-pull CA's certificate (PEM, public): the platform chart's originPull.caPem, which Traefik verifies Cloudflare's client certificate against."
  value       = tls_self_signed_cert.origin_pull_ca.cert_pem
}

output "origin_certificate_pem" {
  description = "The origin's server certificate (PEM) from Cloudflare's Origin CA, for the three hostnames: tls.crt in the origin-tls Secret."
  value       = cloudflare_origin_ca_certificate.this.certificate
}

output "origin_private_key_pem" {
  description = "The origin certificate's private key (PEM): tls.key in the origin-tls Secret."
  value       = tls_private_key.origin.private_key_pem
  sensitive   = true
}

output "origin_certificate_expires_on" {
  description = "When the origin certificate expires. Cloudflare sends no notice; renew with `terraform apply -replace=module.edge.tls_private_key.origin` before then."
  value       = cloudflare_origin_ca_certificate.this.expires_on
}
