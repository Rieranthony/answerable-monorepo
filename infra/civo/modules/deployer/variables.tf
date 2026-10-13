variable "namespace" {
  description = "The namespace the deployer deploys into and lives in: the application's."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", var.namespace)) && !contains(["default", "kube-system", "kube-public", "kube-node-lease"], var.namespace)
    error_message = "The namespace must be a valid name and not one of Kubernetes' own."
  }
}

variable "read_namespaces" {
  description = "Namespaces the deployer may read (pods, logs, events, workloads; never Secrets), to explain a failed rollout."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for namespace in var.read_namespaces : !contains(["kube-system", "kube-public", "kube-node-lease"], namespace)])
    error_message = "The deployer reads no namespace of Kubernetes' own."
  }
}
