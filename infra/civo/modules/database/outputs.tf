output "id" {
  description = "The database's ID."
  value       = civo_database.this.id
}

output "name" {
  description = "The database's name, for `civo database credential <name>` and `civo database show <name>`."
  value       = civo_database.this.name
}

output "host" {
  description = "The database's address on the private network, the host the services connect to."
  value       = civo_database.this.private_ipv4
}

output "dns_endpoint" {
  description = "The database's DNS name, should its certificate name that rather than the private address."
  value       = civo_database.this.dns_endpoint
}

output "port" {
  description = "The database's port."
  value       = civo_database.this.port
}

output "nodes" {
  description = "The number of database nodes."
  value       = civo_database.this.nodes
}

output "firewall_id" {
  description = "The ID of the database's firewall."
  value       = civo_vpc_firewall.this.id
}

output "firewall_name" {
  description = "The name of the database's firewall."
  value       = civo_vpc_firewall.this.name
}

output "admin_url" {
  description = "The administrator's URL for the bootstrap Job (OPS_DATABASE_ADMIN_URL in the postgres-admin Secret): the private address, verify-full against the CA the answerable chart mounts at /etc/ssl/db/ca.pem."
  value       = "postgres://${local.admin_login}@${civo_database.this.private_ipv4}:${civo_database.this.port}/${var.admin_database}?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem"
  sensitive   = true
}
