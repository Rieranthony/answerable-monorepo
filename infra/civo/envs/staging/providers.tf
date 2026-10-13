# Civo: the account's API key from CIVO_TOKEN (the owner, or the infra workflow's protected environment; never the
# deploy workflow, D25). Cloudflare: the zone's own token from CLOUDFLARE_API_TOKEN (D19).
provider "civo" {
  region = var.region
}

provider "cloudflare" {}

locals {
  # The cluster's admin kubeconfig, written to state by module.cluster. k3s issues a client certificate; a token is
  # read too in case Civo ever hands one out instead. Until the cluster exists these values are unknown, which is why
  # the first apply creates the cluster on its own (README, "First apply").
  kubeconfig = yamldecode(module.cluster.kubeconfig)
  kubernetes = {
    host                   = local.kubeconfig.clusters[0].cluster.server
    cluster_ca_certificate = base64decode(local.kubeconfig.clusters[0].cluster["certificate-authority-data"])
    client_certificate     = try(base64decode(local.kubeconfig.users[0].user["client-certificate-data"]), null)
    client_key             = try(base64decode(local.kubeconfig.users[0].user["client-key-data"]), null)
    token                  = try(local.kubeconfig.users[0].user.token, null)
  }
}

provider "kubernetes" {
  host                   = local.kubernetes.host
  cluster_ca_certificate = local.kubernetes.cluster_ca_certificate
  client_certificate     = local.kubernetes.client_certificate
  client_key             = local.kubernetes.client_key
  token                  = local.kubernetes.token
}

provider "helm" {
  kubernetes = {
    host                   = local.kubernetes.host
    cluster_ca_certificate = local.kubernetes.cluster_ca_certificate
    client_certificate     = local.kubernetes.client_certificate
    client_key             = local.kubernetes.client_key
    token                  = local.kubernetes.token
  }
}
