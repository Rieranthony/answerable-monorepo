variable "environment" {
  description = "The environment this database belongs to, `staging` or `production`; every name starts `answerable-<environment>-`."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "network_id" {
  description = "The ID of the environment's private network, which the database and its firewall join."
  type        = string
}

variable "network_cidr" {
  description = "The private network's IPv4 range, the only source the firewall admits on 5432."
  type        = string

  validation {
    condition     = can(cidrhost(var.network_cidr, 0))
    error_message = "The network range must be an IPv4 CIDR."
  }
}

variable "size" {
  description = "The Civo database size: g3.db.small (2 vCPU, 4 GB, 40 GB) for staging, g3.db.medium (4 vCPU, 8 GB, 80 GB) for production."
  type        = string

  validation {
    condition     = can(regex("^g3\\.db\\.[a-z0-9]+$", var.size))
    error_message = "The size must be a Civo database size such as g3.db.small."
  }
}

variable "nodes" {
  description = "The number of database nodes: 1, or 3 or 5 for a primary with standbys (Civo advises an odd count)."
  type        = number

  validation {
    condition     = contains([1, 3, 5], var.nodes)
    error_message = "The database runs 1, 3 or 5 nodes."
  }
}

variable "admin_database" {
  description = "The database the administrator's URL names. Civo does not document its default; the first real bootstrap confirms it (`civo database credential`)."
  type        = string
  default     = "postgres"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]{0,62}$", var.admin_database))
    error_message = "The administrator's database must be a plain PostgreSQL name (letters, digits, underscores), so that the URL needs no encoding."
  }
}
