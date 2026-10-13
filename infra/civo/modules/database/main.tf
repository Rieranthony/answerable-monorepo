locals {
  name = "answerable-${var.environment}-database"
}

# The database's firewall. Civo's default database firewall admits 5432 from everyone; this one admits it from the
# private network, which by policy holds only the cluster's nodes, its load balancer and this database. Nodes-only is
# not expressible on Civo (rules match CIDRs, node addresses change, no subnet per pool): README.md, "Known limit".
# Outbound, the database may talk to its own network (its standbys) and nowhere else.
resource "civo_vpc_firewall" "this" {
  name                 = local.name
  network_id           = var.network_id
  create_default_rules = false

  ingress_rule {
    label      = "postgres-from-private-network"
    protocol   = "tcp"
    port_range = "5432"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  egress_rule {
    label      = "private-network-tcp"
    protocol   = "tcp"
    port_range = "1-65535"
    cidr       = [var.network_cidr]
    action     = "allow"
  }

  egress_rule {
    label      = "private-network-udp"
    protocol   = "udp"
    port_range = "1-65535"
    cidr       = [var.network_cidr]
    action     = "allow"
  }
}

# Civo's managed PostgreSQL, version 17 only and in beta (portability.md § Civo). It holds answerable_id,
# answerable_toolbox and answerable_admin, each with an owner and a runtime login that the `bootstrap` Job creates
# (B3). The provider keeps the administrator's username and password in state; the sensitive output admin_url carries
# them to the bootstrap Job's postgres-admin Secret, and nothing else outputs them.
resource "civo_database" "this" {
  name        = local.name
  engine      = "postgresql"
  version     = "17"
  size        = var.size
  nodes       = var.nodes
  network_id  = var.network_id
  firewall_id = civo_vpc_firewall.this.id

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  # RFC 3986 userinfo. urlencode leaves only the unreserved characters as they are and writes a space as "+", which a
  # URL's userinfo reads as a literal plus, so each "+" becomes %20 (a literal plus is already %2B by then).
  admin_login = join(":", [
    for part in [civo_database.this.username, civo_database.this.password] : replace(urlencode(part), "+", "%20")
  ])
}
