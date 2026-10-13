terraform {
  required_version = "~> 1.16"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "3.3.0"
    }
  }
}
