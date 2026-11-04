output "cluster_name" {
  description = "The cluster's name, for `civo kubernetes config <name>`."
  value       = module.cluster.name
}

output "kube_server" {
  description = "The Kubernetes API's URL, also written to the GitHub environment as KUBE_SERVER."
  value       = module.cluster.api_endpoint
}

output "load_balancer_ip" {
  description = "The load balancer's reserved public address, where the Cloudflare records point."
  value       = module.ingress_firewall.ip
}

output "hostnames" {
  description = "The service hostnames Cloudflare proxies to this environment."
  value       = module.edge.hostnames
}

output "database_name" {
  description = "The Civo database's name, for `civo database show` and `civo database credential`."
  value       = module.database.name
}

output "origin_certificate_expires_on" {
  description = "When the origin's Origin CA certificate expires; Cloudflare sends no notice (README, \"Certificates\")."
  value       = module.edge.origin_certificate_expires_on
}

output "admin_kubeconfig" {
  description = "The cluster's admin kubeconfig: cluster-admin, for break-glass and diagnostics only. No workflow uses it; the deploy holds the deployer's token."
  value       = module.cluster.kubeconfig
  sensitive   = true
}

output "database_admin_url" {
  description = "The database administrator's URL, for break-glass only; the postgres-admin Secret already carries it to the bootstrap Job."
  value       = module.database.admin_url
  sensitive   = true
}
