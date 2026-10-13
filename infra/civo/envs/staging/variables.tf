variable "environment" {
  description = "The environment this root builds, `staging` or `production`; it must match the Civo account CIVO_TOKEN belongs to."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "region" {
  description = "The Civo region for everything in this root (D28: London)."
  type        = string
  default     = "LON1"

  validation {
    condition     = var.region == "LON1"
    error_message = "Answerable runs in Civo's London region, LON1."
  }
}

variable "network_cidr" {
  description = "The private network's IPv4 range (module network): 10.10.0.0/24 for staging, 10.20.0.0/24 for production."
  type        = string
}

variable "allowed_api_cidrs" {
  description = "The addresses that may reach the Kubernetes API, as CIDRs. Not committed (an operator's address is personal data in a public repository): set TF_VAR_allowed_api_cidrs, for example '[\"198.51.100.7/32\"]'."
  type        = list(string)
  sensitive   = true
}

variable "api_open_to_internet" {
  description = "Whether the Kubernetes API admits the whole internet, authenticated by the cluster alone (module cluster explains the risk). True in staging only, until GitOps or a Cloudflare tunnel replaces it; the module refuses it in production."
  type        = bool
  default     = false
}

variable "node_size" {
  description = "The Civo size of every Kubernetes node."
  type        = string
}

variable "node_count" {
  description = "The number of Kubernetes nodes: 2 in staging, 3 in production."
  type        = number
}

variable "kubernetes_version" {
  description = "The k3s version to create the cluster with; null takes Civo's latest stable. Record the version Civo chose here after the first apply."
  type        = string
  default     = null
}

variable "pod_cidr" {
  description = "The cluster's pod range, trusted as a proxy hop; 10.42.0.0/16 is k3s's default, to be confirmed on the first apply."
  type        = string
  default     = "10.42.0.0/16"

  validation {
    condition     = can(cidrhost(var.pod_cidr, 0))
    error_message = "The pod range must be a CIDR."
  }
}

variable "database_size" {
  description = "The Civo database size."
  type        = string
}

variable "database_nodes" {
  description = "The number of database nodes: 1 in staging, 3 in production."
  type        = number
}

variable "zone_name" {
  description = "The environment's Cloudflare zone (D12)."
  type        = string
}

variable "hostnames" {
  description = "The three service hostnames in the zone, keyed id, toolbox and admin_mcp."
  type        = map(string)
}

variable "platform_values_files" {
  description = "Values files for charts/platform, relative to this directory, applied before the values Terraform owns."
  type        = list(string)
  default     = []
}
