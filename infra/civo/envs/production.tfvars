# Production in the answerable-production Civo account: `./terraform.sh production <command>`. No secret here:
# CIVO_TOKEN, CLOUDFLARE_API_TOKEN, GITHUB_TOKEN and the state credential come from the GitHub environment (README,
# "Credentials").
environment  = "production"
network_cidr = "10.20.0.0/24"

# Three Medium nodes (2 vCPU, 4 GB each, $21.73 a month): two replicas per service on different nodes, with room to
# drain one node for maintenance.
node_size  = "g4s.kube.medium"
node_count = 3

# Medium PostgreSQL 17 (4 vCPU, 8 GB, 80 GB NVMe, $86.91 a month), one node. Civo documents failover for additional
# nodes only as "can continue to operate even if one or more nodes fail", with no mechanism and no price; this count
# rises to three only once brief B7c has measured it.
database_size  = "g3.db.medium"
database_nodes = 1

# Production's records sit beside Vercel's DNS-only www in the answerable.org zone; the edge module writes these four
# names and nothing else. mcp is the standalone server's, which serves every standalone MCP by path: no MCP adds a name.
zone_name = "answerable.org"
hostnames = {
  id        = "id.answerable.org"
  toolbox   = "toolbox.answerable.org"
  admin_mcp = "admin-mcp.answerable.org"
  mcp       = "mcp.answerable.org"
}
