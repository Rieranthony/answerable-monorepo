# One environment on Civo, in its own Civo account (D28): the state bucket, the private network, the cluster and its
# firewall, the database and its firewall, the load balancer's firewall and reserved address, the platform chart, the
# deployer identity and the Cloudflare zone. envs/staging and envs/production share this file byte for byte
# (`bun run infra:check` compares them); only backend.tf and terraform.tfvars differ.

# Cloudflare's published ranges, read at every plan: the load balancer admits them and Traefik trusts their
# X-Forwarded-For. A change in Cloudflare's list shows up as a plan diff and needs an apply.
data "cloudflare_ip_ranges" "this" {}

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

locals {
  cloudflare_cidrs = concat(data.cloudflare_ip_ranges.this.ipv4_cidrs, data.cloudflare_ip_ranges.this.ipv6_cidrs)

  # The proxies whose X-Forwarded-For the ingress and ID trust. Cloudflare connects to the load balancer; the load
  # balancer connects to Traefik from the private network (it passes TCP through without PROXY protocol, so Traefik
  # sees its private address); Traefik reaches the services from the pod range (D31).
  trusted_proxy_cidrs = concat(local.cloudflare_cidrs, [module.network.cidr_v4, var.pod_cidr])
}

module "state" {
  source = "../../modules/state"

  environment = var.environment
  region      = var.region
}

module "network" {
  source = "../../modules/network"

  environment = var.environment
  cidr_v4     = var.network_cidr
}

module "cluster" {
  source = "../../modules/cluster"

  environment          = var.environment
  network_id           = module.network.id
  network_cidr         = module.network.cidr_v4
  allowed_api_cidrs    = var.allowed_api_cidrs
  api_open_to_internet = var.api_open_to_internet
  node_size            = var.node_size
  node_count           = var.node_count
  kubernetes_version   = var.kubernetes_version
}

module "database" {
  source = "../../modules/database"

  environment    = var.environment
  network_id     = module.network.id
  network_cidr   = module.network.cidr_v4
  size           = var.database_size
  nodes          = var.database_nodes
  admin_database = var.database_admin_database
}

module "ingress_firewall" {
  source = "../../modules/ingress-firewall"

  environment           = var.environment
  network_id            = module.network.id
  network_cidr          = module.network.cidr_v4
  cloudflare_ipv4_cidrs = data.cloudflare_ip_ranges.this.ipv4_cidrs
}

module "platform" {
  source = "../../modules/platform"

  chart_path                = "${path.module}/../../../../charts/platform"
  values_files              = [for file_path in var.platform_values_files : "${path.module}/${file_path}"]
  load_balancer_firewall_id = module.ingress_firewall.firewall_id
  load_balancer_ip          = module.ingress_firewall.ip
  trusted_proxy_cidrs       = concat(local.cloudflare_cidrs, [module.network.cidr_v4])
  environment               = var.environment
  zone_name                 = var.zone_name
  origin_pull_ca_file       = "${path.module}/${var.origin_pull_ca_file}"
}

module "deployer" {
  source = "../../modules/deployer"

  namespace = module.platform.answerable_namespace
  # The pipeline reads nothing outside answerable; list a namespace here only for a diagnostic.
  read_namespaces = []
}

module "edge" {
  source = "../../modules/edge"

  environment = var.environment
  zone_id     = data.cloudflare_zone.this.id
  zone_name   = var.zone_name
  origin_ip   = module.ingress_firewall.ip
  hostnames   = var.hostnames
}
