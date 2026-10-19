output "answerable_namespace" {
  description = "The application's namespace, where the deployer works."
  value       = kubernetes_namespace_v1.answerable.metadata[0].name
}

output "platform_namespace" {
  description = "The platform chart's namespace."
  value       = kubernetes_namespace_v1.platform.metadata[0].name
}

output "release" {
  description = "The platform chart's release name."
  value       = helm_release.platform.name
}

output "trusted_proxy_cidrs" {
  description = "The trusted-proxies ConfigMap's cidrs, ID's TRUSTED_PROXY_CIDRS: Traefik's trusted peers, then the pod range."
  value       = kubernetes_config_map_v1.trusted_proxies.data["cidrs"]
}
