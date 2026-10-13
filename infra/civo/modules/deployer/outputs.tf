output "service_account" {
  description = "The deployer's ServiceAccount, as namespace/name."
  value       = "${var.namespace}/${kubernetes_service_account_v1.this.metadata[0].name}"
}

output "token" {
  description = "The deployer's long-lived token, the deploy workflow's KUBE_TOKEN."
  value       = kubernetes_secret_v1.token.data["token"]
  sensitive   = true
}

output "ca_certificate" {
  description = "The cluster's CA certificate (PEM) from the token Secret, the deploy workflow's KUBE_CA."
  value       = kubernetes_secret_v1.token.data["ca.crt"]
  sensitive   = true
}
