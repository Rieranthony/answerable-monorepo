variable "environment" {
  description = "The environment this load balancer serves, `staging` or `production`; every name starts `answerable-<environment>-`."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "network_id" {
  description = "The ID of the environment's private network, which the firewall belongs to."
  type        = string
}

variable "network_cidr" {
  description = "The private network's IPv4 range, where the load balancer's backends (the nodes) live."
  type        = string

  validation {
    condition     = can(cidrhost(var.network_cidr, 0))
    error_message = "The network range must be an IPv4 CIDR."
  }
}

variable "cloudflare_ipv4_cidrs" {
  description = "Cloudflare's published IPv4 ranges (the `cloudflare_ip_ranges` data source), the only sources admitted on 443. The load balancer is IPv4, so Cloudflare reaches it over IPv4 only."
  type        = list(string)

  validation {
    condition     = length(var.cloudflare_ipv4_cidrs) > 0
    error_message = "Cloudflare's ranges are empty; refusing to write a firewall that admits nobody."
  }

  validation {
    condition     = alltrue([for cidr in var.cloudflare_ipv4_cidrs : can(cidrnetmask(cidr))])
    error_message = "Every range must be an IPv4 CIDR."
  }

  validation {
    condition     = alltrue([for cidr in var.cloudflare_ipv4_cidrs : try(tonumber(split("/", cidr)[1]) >= 8, false)])
    error_message = "No range may be wider than a /8: the load balancer must never be open to the whole internet."
  }
}
