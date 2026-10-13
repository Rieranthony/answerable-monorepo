variable "environment" {
  description = "The environment this network belongs to, `staging` or `production`; every name starts `answerable-<environment>-`."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "cidr_v4" {
  description = "The network's IPv4 range: a /16 to /28 inside 10.0.0.0/8 that avoids 10.42.0.0/16 and 10.43.0.0/16, the cluster's pod and service ranges."
  type        = string

  validation {
    condition = (
      can(cidrhost(var.cidr_v4, 0))
      && can(regex("^10\\.", var.cidr_v4))
      && !can(regex("^10\\.4[23]\\.", var.cidr_v4))
      && tonumber(try(split("/", var.cidr_v4)[1], "0")) >= 16
      && tonumber(try(split("/", var.cidr_v4)[1], "0")) <= 28
    )
    error_message = "The range must be a /16 to /28 inside 10.0.0.0/8, outside 10.42.0.0/16 and 10.43.0.0/16."
  }
}
