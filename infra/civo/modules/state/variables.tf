variable "environment" {
  description = "The environment whose state the bucket holds, `staging` or `production`; every name starts `answerable-<environment>-`."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "The environment must be staging or production."
  }
}

variable "region" {
  description = "The Civo region of the bucket and its credential; the S3 endpoint is https://objectstore.<region>.civo.com."
  type        = string
  default     = "LON1"

  validation {
    condition     = can(regex("^[A-Z]{3}[0-9]$", var.region))
    error_message = "The region must be a Civo region code such as LON1."
  }
}

variable "max_size_gb" {
  description = "The bucket's size in GB; Civo sells object storage in 500 GB blocks."
  type        = number
  default     = 500

  validation {
    condition     = var.max_size_gb >= 500 && var.max_size_gb % 500 == 0
    error_message = "The size must be a whole number of 500 GB blocks."
  }
}
