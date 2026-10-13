output "id" {
  description = "The cluster's ID."
  value       = civo_kubernetes_cluster.this.id
}

output "name" {
  description = "The cluster's name."
  value       = civo_kubernetes_cluster.this.name
}

output "api_endpoint" {
  description = "The Kubernetes API's URL, the deploy workflow's KUBE_SERVER."
  value       = civo_kubernetes_cluster.this.api_endpoint
}

output "kubeconfig" {
  description = "The cluster's admin kubeconfig, for the kubernetes and helm providers of this root only."
  value       = civo_kubernetes_cluster.this.kubeconfig
  sensitive   = true
}

output "firewall_id" {
  description = "The ID of the cluster's firewall."
  value       = civo_vpc_firewall.this.id
}

output "firewall_name" {
  description = "The name of the cluster's firewall."
  value       = civo_vpc_firewall.this.name
}

output "node_count" {
  description = "The number of nodes in the cluster's pool."
  value       = civo_kubernetes_cluster.this.pools[0].node_count
}

output "node_pool_name" {
  description = "The name of the cluster's node pool."
  value       = civo_kubernetes_cluster.this.pools[0].label
}
