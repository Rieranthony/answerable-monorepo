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
    error_message = "A platform values file is missing: ${join(", ", [for path in var.values_files : path if !fileexists(path)])}. charts/platform ships values-civo-<environment>.yaml for each environment."
  }
}

variable "origin_pull_ca_pem" {
  description = "The origin-pull CA's certificate (PEM, public), from the edge module: the chart's originPull.caPem."
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

variable "database_admin_url" {
  description = "The database administrator's URL, from the database module: OPS_DATABASE_ADMIN_URL in the postgres-admin Secret."
  type        = string
  sensitive   = true
}

variable "origin_certificate_pem" {
  description = "The origin's certificate (PEM) from Cloudflare's Origin CA, from the edge module: tls.crt in the origin-tls Secret."
  type        = string
}

variable "origin_private_key_pem" {
  description = "The origin certificate's private key (PEM), from the edge module: tls.key in the origin-tls Secret."
  type        = string
  sensitive   = true
}
