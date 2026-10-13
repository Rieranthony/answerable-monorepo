output "id" {
  description = "The network's ID, for the cluster, the database and the firewalls."
  value       = civo_vpc_network.this.id
}

output "cidr_v4" {
  description = "The network's IPv4 range, which the database and cluster firewalls admit and the ingress trusts as a proxy hop."
  value       = civo_vpc_network.this.cidr_v4
}

output "name" {
  description = "The network's name."
  value       = civo_vpc_network.this.label
}
