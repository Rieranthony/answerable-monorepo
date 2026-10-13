output "answerable_namespace" {
  description = "The application's namespace, where the deployer works."
  value       = kubernetes_namespace_v1.answerable.metadata[0].name
}

output "platform_namespace" {
  description = "The shared controllers' namespace."
  value       = kubernetes_namespace_v1.platform.metadata[0].name
}

output "release" {
  description = "The platform chart's release name."
  value       = helm_release.platform.name
}
