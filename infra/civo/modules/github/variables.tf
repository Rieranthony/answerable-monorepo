variable "environment" {
  description = "The GitHub environment to configure, named as the Answerable environment: `staging` or `production`."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "repository" {
  description = "The repository's name, without its owner (the provider's owner)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+$", var.repository))
    error_message = "Give the repository's name alone, such as answerable-monorepo."
  }
}

variable "kube_server" {
  description = "The Kubernetes API's URL: the KUBE_SERVER secret."
  type        = string
}

variable "kube_ca" {
  description = "The cluster's CA certificate (PEM): the KUBE_CA secret."
  type        = string
  sensitive   = true
}

variable "kube_token" {
  description = "The deployer ServiceAccount's token: the KUBE_TOKEN secret."
  type        = string
  sensitive   = true
}
