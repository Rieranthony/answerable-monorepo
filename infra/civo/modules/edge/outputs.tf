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
