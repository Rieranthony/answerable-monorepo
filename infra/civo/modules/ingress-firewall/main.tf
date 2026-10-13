locals {
  name = "answerable-${var.environment}-load-balancer"
}

# The firewall of the Civo load balancer in front of Traefik (D31). The load balancer is created by Kubernetes, not by
# Terraform: the platform chart's Traefik Service of type LoadBalancer names this firewall in its
# `kubernetes.civo.com/firewall-id` annotation. HTTPS is admitted from Cloudflare's published ranges and from nothing
# else, so only Cloudflare reaches the origin; Traefik then demands Cloudflare's origin-pull client certificate (a
# TLSOption with clientAuth), which a Cloudflare customer other than us cannot present (D18, D22). There is no port 80:
# Cloudflare redirects to HTTPS at the edge. Outbound, the load balancer reaches its backends on the private network.
resource "civo_vpc_firewall" "this" {
  name                 = local.name
  network_id           = var.network_id
  create_default_rules = false

  ingress_rule {
    label      = "https-from-cloudflare"
    protocol   = "tcp"
    port_range = "443"
    cidr       = var.cloudflare_ipv4_cidrs
    action     = "allow"
  }

  egress_rule {
    label      = "backends-on-private-network"
    protocol   = "tcp"
    port_range = "1-65535"
    cidr       = [var.network_cidr]
    action     = "allow"
  }
}

# The load balancer's public address, reserved so that it survives the Service being recreated and so that the
# Cloudflare records can be written before the load balancer exists. The Service claims it through the
# `kubernetes.civo.com/ipv4-address` annotation.
resource "civo_vpc_reserved_ip" "this" {
  name = local.name
}
