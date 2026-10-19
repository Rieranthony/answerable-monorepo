# One environment on Civo, in its own Civo account (D28): the private network, the cluster and its firewall, the
# database and its firewall, the load balancer's firewall and reserved address, the platform chart and the objects the
# application reads, the deployer identity, the Cloudflare zone with its certificates, and the GitHub environment.
# One root for both environments: envs/<environment>.tfvars holds what differs, and terraform.sh picks the state.

# Cloudflare's published ranges, read at every plan: the load balancer admits them and Traefik trusts their
# X-Forwarded-For. A change in Cloudflare's list shows up as a plan diff and needs an apply.
data "cloudflare_ip_ranges" "this" {}

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

locals {
  # The proxies whose X-Forwarded-For Traefik trusts. Cloudflare connects to the load balancer; the load balancer
  # connects to Traefik from the private network (it passes TCP through without PROXY protocol, so Traefik sees its
  # private address). ID trusts these and the pod range Traefik reaches it from (the trusted-proxies ConfigMap, D31).
  edge_trusted_cidrs = concat(
    data.cloudflare_ip_ranges.this.ipv4_cidrs,
    data.cloudflare_ip_ranges.this.ipv6_cidrs,
    [module.network.cidr_v4],
  )
}

module "network" {
  source = "./modules/network"

  environment = var.environment
  cidr_v4     = var.network_cidr
}

module "cluster" {
  source = "./modules/cluster"

  environment        = var.environment
  network_id         = module.network.id
  network_cidr       = module.network.cidr_v4
  node_size          = var.node_size
  node_count         = var.node_count
  kubernetes_version = var.kubernetes_version
}

module "database" {
  source = "./modules/database"

  environment  = var.environment
  network_id   = module.network.id
  network_cidr = module.network.cidr_v4
  size         = var.database_size
  nodes        = var.database_nodes
}

module "ingress_firewall" {
  source = "./modules/ingress-firewall"

  environment           = var.environment
  network_id            = module.network.id
  network_cidr          = module.network.cidr_v4
  cloudflare_ipv4_cidrs = data.cloudflare_ip_ranges.this.ipv4_cidrs
}

module "edge" {
  source = "./modules/edge"

  environment = var.environment
  zone_id     = data.cloudflare_zone.this.id
  zone_name   = var.zone_name
  origin_ip   = module.ingress_firewall.ip
  hostnames   = var.hostnames
}

module "platform" {
  source = "./modules/platform"

  chart_path                = "${path.module}/../../charts/platform"
  values_files              = ["${path.module}/../../charts/platform/values-civo-${var.environment}.yaml"]
  origin_pull_ca_pem        = module.edge.origin_pull_ca_pem
  load_balancer_firewall_id = module.ingress_firewall.firewall_id
  load_balancer_ip          = module.ingress_firewall.ip
  trusted_proxy_cidrs       = local.edge_trusted_cidrs
  pod_cidr                  = var.pod_cidr
  database_admin_url        = module.database.admin_url
  origin_certificate_pem    = module.edge.origin_certificate_pem
  origin_private_key_pem    = module.edge.origin_private_key_pem
}

module "deployer" {
  source = "./modules/deployer"

  namespace = module.platform.answerable_namespace
}

module "github" {
  source = "./modules/github"

  environment = var.environment
  repository  = local.github_repository
  kube_server = module.cluster.api_endpoint
  kube_ca     = module.deployer.ca_certificate
  kube_token  = module.deployer.token
}
