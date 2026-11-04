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
  description = "The four service hostnames, keyed id, toolbox, admin_mcp and mcp (where the Toolbox serves every standalone MCP by path), each a first-level name in the zone (Universal SSL covers no deeper name)."
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

variable "mail_records" {
  description = <<-EOT
    Postmark's DNS records for the mail domain id.<zone>, which the owner copies from the DNS Settings page of that
    environment's Postmark domain after adding it; null writes none. dkim_host is <selector>._domainkey.id.<zone>
    and dkim_value the TXT value that starts k=rsa; return_path_host is Postmark's Return-Path host, one label
    under id.<zone>, which becomes a DNS-only CNAME to pm.mtasv.net; dmarc_value is the TXT value of
    _dmarc.id.<zone>, which starts v=DMARC1; p=. Public values, no secret. There is no SPF record: Postmark asks for none on
    the From domain, and the apex's Microsoft 365 records are not this module's.
  EOT
  type = object({
    dkim_host        = string
    dkim_value       = string
    return_path_host = string
    dmarc_value      = string
  })
  default = null

  validation {
    condition     = var.mail_records == null ? true : can(regex("^[a-z0-9-]+\\._domainkey\\.${replace(var.hostnames["id"], ".", "\\.")}$", var.mail_records.dkim_host))
    error_message = "dkim_host must be <selector>._domainkey.id.<zone>: one label, then _domainkey, under the mail domain id.<zone>, never the apex."
  }

  validation {
    condition     = var.mail_records == null ? true : can(regex("^[a-z0-9-]+\\.${replace(var.hostnames["id"], ".", "\\.")}$", var.mail_records.return_path_host))
    error_message = "return_path_host must be one label under id.<zone>, such as pm-bounces.id.<zone> (Postmark's DNS Settings page names it), never the apex."
  }

  validation {
    condition     = var.mail_records == null ? true : can(regex("^k=rsa; ?p=[A-Za-z0-9+/=]+$", var.mail_records.dkim_value))
    error_message = "dkim_value must be Postmark's DKIM public key as the TXT value it shows: k=rsa;p= and the base64 key, without quotes."
  }

  validation {
    condition     = var.mail_records == null ? true : can(regex("^v=DMARC1; ?p=(none|quarantine|reject)(;|$)", var.mail_records.dmarc_value)) && !strcontains(var.mail_records.dmarc_value, "\"")
    error_message = "dmarc_value must start v=DMARC1; p=none, quarantine or reject, and carry no quotes (the module quotes it)."
  }
}
