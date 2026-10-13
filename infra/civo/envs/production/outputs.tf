output "load_balancer_ip" {
  description = "The load balancer's reserved public address, where the Cloudflare records point."
  value       = module.ingress_firewall.ip
}

output "load_balancer_firewall_id" {
  description = "The load balancer firewall's ID, named in the ingress Service's annotation."
  value       = module.ingress_firewall.firewall_id
}

output "https_sources" {
  description = "The ranges the load balancer admits on 443: Cloudflare's IPv4 ranges at the last apply."
  value       = module.ingress_firewall.https_sources
}

output "cloudflare_ranges_etag" {
  description = "The digest of Cloudflare's published ranges at the last apply; a new one means the firewall and trusted proxies changed."
  value       = data.cloudflare_ip_ranges.this.etag
}

output "trusted_proxy_cidrs" {
  description = "TRUSTED_PROXY_CIDRS for ID, comma-separated: Cloudflare's ranges, the private network (the load balancer) and the pod range (Traefik)."
  value       = join(",", local.trusted_proxy_cidrs)
}

output "network_cidr" {
  description = "The private network's range."
  value       = module.network.cidr_v4
}

output "cluster_name" {
  description = "The cluster's name, for `civo kubernetes config <name>`."
  value       = module.cluster.name
}

output "kube_server" {
  description = "The Kubernetes API's URL: the deploy environment's KUBE_SERVER secret."
  value       = module.cluster.api_endpoint
}

output "kube_ca" {
  description = "The cluster's CA certificate (PEM): the deploy environment's KUBE_CA secret."
  value       = module.deployer.ca_certificate
  sensitive   = true
}

output "kube_token" {
  description = "The deployer ServiceAccount's token: the deploy environment's KUBE_TOKEN secret."
  value       = module.deployer.token
  sensitive   = true
}

output "deployer" {
  description = "The deployer ServiceAccount, as namespace/name."
  value       = module.deployer.service_account
}

output "database_name" {
  description = "The Civo database's name, for `civo database credential` and `civo database show`."
  value       = module.database.name
}

output "database_host" {
  description = "The database's address on the private network."
  value       = module.database.host
}

output "database_dns_endpoint" {
  description = "The database's DNS name, should its certificate name that rather than the private address."
  value       = module.database.dns_endpoint
}

output "database_port" {
  description = "The database's port."
  value       = module.database.port
}

output "state_bucket" {
  description = "The state bucket, as backend.tf names it."
  value       = module.state.bucket
}

output "state_endpoint" {
  description = "The object store's S3 endpoint, as backend.tf names it."
  value       = module.state.endpoint
}

output "state_access_key_id" {
  description = "The state credential's access key: AWS_ACCESS_KEY_ID for the backend."
  value       = module.state.access_key_id
}

output "state_secret_access_key" {
  description = "The state credential's secret key: AWS_SECRET_ACCESS_KEY for the backend."
  value       = module.state.secret_access_key
  sensitive   = true
}

output "hostnames" {
  description = "The service hostnames Cloudflare proxies to this environment."
  value       = module.edge.hostnames
}
