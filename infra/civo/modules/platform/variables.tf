variable "chart_path" {
  description = "The path to charts/platform, relative to the root module that calls this one."
  type        = string

  validation {
    condition     = length(trimspace(var.chart_path)) > 0
    error_message = "The chart path must not be empty."
  }
}

variable "values_files" {
  description = "Values files for the platform chart, as paths Terraform can open from the root module's directory (the chart's own values-civo-<environment>.yaml), applied in order before the values Terraform owns."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for path in var.values_files : fileexists(path)])
    error_message = "A platform values file is missing: ${join(", ", [for path in var.values_files : path if !fileexists(path)])}. charts/platform ships values-civo-<environment>.yaml; check platform_values_files in terraform.tfvars and that the chart is on this branch."
  }
}

variable "environment" {
  description = "The environment, `staging` or `production`, named in the command an error message gives."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "zone_name" {
  description = "The environment's Cloudflare zone, named in the command that writes the origin-pull CA."
  type        = string
}

variable "origin_pull_ca_file" {
  description = "The origin-pull CA's public certificate (PEM), as a path Terraform can open from the root module's directory: infra/civo/envs/<environment>/edge-ca/ca.pem, written by `bun run setup origin-pull`. Read only when the platform release is planned."
  type        = string
}

variable "load_balancer_firewall_id" {
  description = "The ID of the load balancer's firewall, which Traefik's Service names so that Civo attaches it."
  type        = string

  validation {
    condition     = length(trimspace(var.load_balancer_firewall_id)) > 0
    error_message = "The load balancer must have a firewall."
  }
}

variable "load_balancer_ip" {
  description = "The reserved public IPv4 address Traefik's Service claims for its load balancer."
  type        = string

  validation {
    condition     = can(cidrhost("${var.load_balancer_ip}/32", 0))
    error_message = "The load balancer address must be an IPv4 address."
  }
}

variable "trusted_proxy_cidrs" {
  description = "The peers whose X-Forwarded-* headers Traefik's websecure entry point trusts (ports.websecure.forwardedHeaders.trustedIPs): the private network the load balancer forwards from, which is the peer Traefik sees without PROXY protocol, and Cloudflare's ranges, the peer it would see with it."
  type        = list(string)

  validation {
    condition     = length(var.trusted_proxy_cidrs) > 0 && alltrue([for cidr in var.trusted_proxy_cidrs : can(cidrhost(cidr, 0))])
    error_message = "List at least one range, each a CIDR."
  }

  validation {
    condition     = alltrue([for cidr in var.trusted_proxy_cidrs : try(tonumber(split("/", cidr)[1]) > 0, false)])
    error_message = "Trusting X-Forwarded-For from the whole internet would let any client choose its own address."
  }
}
