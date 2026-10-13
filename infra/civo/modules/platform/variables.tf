variable "chart_path" {
  description = "The path to charts/platform, relative to the root module that calls this one."
  type        = string

  validation {
    condition     = length(trimspace(var.chart_path)) > 0
    error_message = "The chart path must not be empty."
  }
}

variable "values" {
  description = "Values documents (YAML text) for the platform chart, applied in order before the values Terraform owns."
  type        = list(string)
  default     = []
}

variable "load_balancer_firewall_id" {
  description = "The ID of the load balancer's firewall, which the ingress Service names so that Civo attaches it."
  type        = string

  validation {
    condition     = length(trimspace(var.load_balancer_firewall_id)) > 0
    error_message = "The load balancer must have a firewall."
  }
}

variable "load_balancer_ip" {
  description = "The reserved public IPv4 address the ingress Service claims for its load balancer."
  type        = string

  validation {
    condition     = can(cidrhost("${var.load_balancer_ip}/32", 0))
    error_message = "The load balancer address must be an IPv4 address."
  }
}

variable "proxy_real_ip_cidrs" {
  description = "The ranges whose X-Forwarded-For ingress-nginx trusts (its proxy-real-ip-cidr): Cloudflare's ranges and the private network the load balancer forwards from."
  type        = list(string)

  validation {
    condition     = length(var.proxy_real_ip_cidrs) > 0 && alltrue([for cidr in var.proxy_real_ip_cidrs : can(cidrhost(cidr, 0))])
    error_message = "List at least one range, each a CIDR."
  }

  validation {
    condition     = alltrue([for cidr in var.proxy_real_ip_cidrs : try(tonumber(split("/", cidr)[1]) > 0, false)])
    error_message = "Trusting X-Forwarded-For from the whole internet would let any client choose its own address."
  }
}
