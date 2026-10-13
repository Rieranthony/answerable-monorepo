# The environment's private network. The cluster's nodes, its load balancer and the database join it, and the
# firewalls of the database and the cluster admit this range and nothing wider. Civo makes a resource's network
# permanent, so changing the range means rebuilding everything in it.
resource "civo_vpc_network" "this" {
  label   = "answerable-${var.environment}-network"
  cidr_v4 = var.cidr_v4
}
