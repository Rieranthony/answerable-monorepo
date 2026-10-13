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
  description = "The addresses allowed to reach the Kubernetes API on 6443, as CIDRs: the operators' own, for kubectl. The whole internet only when api_open_to_internet is true. Sensitive so that plans posted on a public repository do not print an operator's address."
  type        = list(string)
  sensitive   = true

  validation {
    condition     = length(var.allowed_api_cidrs) > 0 || var.api_open_to_internet
    error_message = "List at least one address for the Kubernetes API, or nobody can reach it."
  }

  validation {
    condition     = alltrue([for cidr in var.allowed_api_cidrs : can(cidrhost(cidr, 0)) && strcontains(cidr, "/")])
    error_message = "Every API address must be a CIDR such as 198.51.100.7/32."
  }

  validation {
    condition     = var.api_open_to_internet || alltrue([for cidr in var.allowed_api_cidrs : try(tonumber(split("/", cidr)[1]) > 0, true)])
    error_message = "The Kubernetes API must not be open to the whole internet (0.0.0.0/0 or ::/0) unless api_open_to_internet is true."
  }
}

variable "api_open_to_internet" {
  description = <<-EOT
    Whether the Kubernetes API on 6443 admits the whole internet. When true, the firewall stops nobody and the
    cluster's own authentication is the only barrier: TLS to the public endpoint, then a credential (the
    namespace-scoped deployer token or the admin client certificate). A leaked deployer token is then usable from
    anywhere, and every Kubernetes API vulnerability is exposed to the internet. A stopgap for staging only, because
    GitHub-hosted runners publish thousands of address ranges and cannot be listed; a later brief closes it with a
    GitOps controller that pulls from inside the cluster or a Cloudflare tunnel to the API. Refused in production.
  EOT
  type        = bool
  default     = false

  validation {
    condition     = !(var.api_open_to_internet && var.environment == "production")
    error_message = "Production's Kubernetes API stays closed to the internet; reach it from the listed addresses or through the follow-up's tunnel."
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
