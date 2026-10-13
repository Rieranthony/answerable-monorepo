variable "environment" {
  description = "The environment this cluster belongs to, `staging` or `production`; every name starts `answerable-<environment>-`."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "network_id" {
  description = "The ID of the environment's private network, which the cluster and its firewall join."
  type        = string
}

variable "network_cidr" {
  description = "The private network's IPv4 range, admitted by the firewall for the load balancer and node-to-node traffic."
  type        = string

  validation {
    condition     = can(cidrhost(var.network_cidr, 0))
    error_message = "The network range must be an IPv4 CIDR."
  }
}

variable "allowed_api_cidrs" {
  description = "The addresses allowed to reach the Kubernetes API on 6443, as CIDRs: the operators' and the deploy runners' egress. Never the whole internet."
  type        = list(string)

  validation {
    condition     = length(var.allowed_api_cidrs) > 0
    error_message = "List at least one address for the Kubernetes API, or nobody can deploy."
  }

  validation {
    condition     = alltrue([for cidr in var.allowed_api_cidrs : can(cidrhost(cidr, 0)) && strcontains(cidr, "/")])
    error_message = "Every API address must be a CIDR such as 198.51.100.7/32."
  }

  validation {
    condition     = alltrue([for cidr in var.allowed_api_cidrs : try(tonumber(split("/", cidr)[1]) > 0, true)])
    error_message = "The Kubernetes API must not be open to the whole internet (0.0.0.0/0 or ::/0)."
  }
}

variable "node_size" {
  description = "The Civo size of every node, a Kubernetes size such as g4s.kube.medium (2 vCPU, 4 GB)."
  type        = string

  validation {
    condition     = can(regex("^g4[a-z]\\.kube\\.[a-z0-9]+$", var.node_size))
    error_message = "The node size must be a Civo Kubernetes size such as g4s.kube.medium."
  }
}

variable "node_count" {
  description = "The number of nodes; at least two, so that two replicas of a service can run on different nodes."
  type        = number

  validation {
    condition     = var.node_count >= 2 && var.node_count <= 10 && floor(var.node_count) == var.node_count
    error_message = "The node count must be a whole number from 2 to 10."
  }
}

variable "kubernetes_version" {
  description = "The k3s version to create the cluster with, for example 1.33.1-k3s1; null takes Civo's latest stable. Upgrades are done in Civo, then written here."
  type        = string
  default     = null
}
