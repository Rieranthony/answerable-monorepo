variable "environment" {
  description = "The environment this zone serves, `staging` or `production`; ruleset names start `answerable-<environment>-`."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "zone_id" {
  description = "The Cloudflare zone's ID, the environment's own zone (D12)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.zone_id))
    error_message = "A Cloudflare zone ID is 32 lowercase hexadecimal characters."
  }
}

variable "zone_name" {
  description = "The zone's domain: answerable-staging.uk for staging, answerable.org for production."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$", var.zone_name))
    error_message = "The zone name must be a domain such as answerable-staging.uk."
  }
}

variable "origin_ip" {
  description = "The load balancer's reserved public IPv4 address, which the records point at."
  type        = string

  validation {
    condition     = can(cidrhost("${var.origin_ip}/32", 0))
    error_message = "The origin must be an IPv4 address."
  }
}

variable "hostnames" {
  description = "The four service hostnames, keyed id, toolbox, admin_mcp and mcp (the standalone server, which serves every standalone MCP by path), each a first-level name in the zone (Universal SSL covers no deeper name)."
  type        = map(string)

  validation {
    condition     = toset(keys(var.hostnames)) == toset(["id", "toolbox", "admin_mcp", "mcp"])
    error_message = "Give exactly the hostnames id, toolbox, admin_mcp and mcp."
  }

  validation {
    condition     = alltrue([for host in values(var.hostnames) : can(regex("^[a-z0-9-]+\\.${replace(var.zone_name, ".", "\\.")}$", host))])
    error_message = "Every hostname must be one label directly under the zone, such as id.<zone>."
  }

  validation {
    condition     = alltrue([for host in values(var.hostnames) : !startswith(host, "www.")])
    error_message = "www belongs to the web app on Vercel; the edge module must never write it."
  }
}
