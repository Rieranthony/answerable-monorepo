terraform {
  required_version = "~> 1.16"

  required_providers {
    civo = {
      source  = "civo/civo"
      version = "1.3.3"
    }
  }
}
