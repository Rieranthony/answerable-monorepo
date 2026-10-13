terraform {
  required_version = "~> 1.16"

  required_providers {
    civo = {
      source  = "civo/civo"
      version = "1.3.3"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "3.3.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "3.3.0"
    }
  }
}
