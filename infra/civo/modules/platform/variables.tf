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

variable "trusted_proxy_cidrs" {
  description = "The peers whose X-Forwarded-* headers Traefik's websecure entry point trusts (ports.websecure.forwardedHeaders.trustedIPs): Cloudflare's ranges, the peer Traefik would see with PROXY protocol, and the private network the load balancer forwards from, the peer it sees without."
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

variable "pod_cidr" {
  description = "The cluster's pod range, from which Traefik reaches the services: ID trusts it as a proxy hop after Traefik's own trusted peers."
  type        = string

  validation {
    condition     = can(cidrhost(var.pod_cidr, 0)) && try(tonumber(split("/", var.pod_cidr)[1]) > 0, false)
    error_message = "The pod range must be a CIDR narrower than the whole internet."
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
