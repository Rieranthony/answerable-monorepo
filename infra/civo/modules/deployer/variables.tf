variable "namespace" {
  description = "The namespace the deployer deploys into and lives in: the application's."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.namespace)) && !contains(["default", "kube-system", "kube-public", "kube-node-lease"], var.namespace)
    error_message = "The namespace must be a valid name and not one of Kubernetes' own."
  }
}
