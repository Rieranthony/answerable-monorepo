output "firewall_id" {
  description = "The load balancer firewall's ID, for the ingress-nginx Service's `kubernetes.civo.com/firewall-id` annotation."
  value       = civo_vpc_firewall.this.id
}

output "firewall_name" {
  description = "The load balancer firewall's name."
  value       = civo_vpc_firewall.this.name
}

output "https_sources" {
  description = "The ranges admitted on 443."
  value       = sort(var.cloudflare_ipv4_cidrs)
}

output "ip" {
  description = "The load balancer's reserved public address, for the Cloudflare records and the `kubernetes.civo.com/ipv4-address` annotation."
  value       = civo_vpc_reserved_ip.this.ip
}

output "reserved_ip_name" {
  description = "The reserved address's name."
  value       = civo_vpc_reserved_ip.this.name
}
