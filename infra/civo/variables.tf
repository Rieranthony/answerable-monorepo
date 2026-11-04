variable "environment" {
  description = "The environment this run builds, `staging` or `production`; it must match the Civo account CIVO_TOKEN belongs to and the GitHub environment the workflow runs in."
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
  description = "The number of database nodes: 1 in both environments until the failover of additional nodes is measured."
  type        = number
}

variable "zone_name" {
  description = "The environment's Cloudflare zone (D12)."
  type        = string
}

variable "hostnames" {
  description = "The four service hostnames in the zone, keyed id, toolbox, admin_mcp and mcp (where the Toolbox serves every standalone MCP by path)."
  type        = map(string)
}

variable "mail_records" {
  description = <<-EOT
    Postmark's DNS records for the mail domain id.<zone>: { dkim_host, dkim_value, return_path_host, dmarc_value }, copied from
    the DNS Settings page of that environment's Postmark domain (infra/README.md, Send mail through Postmark); null, the
    default, writes none. Public values, no secret. Set in envs/<environment>.tfvars once Postmark shows them.
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
