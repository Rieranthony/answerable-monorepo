# Staging in the answerable-staging Civo account: `./terraform.sh staging <command>`. No secret here: CIVO_TOKEN,
# CLOUDFLARE_API_TOKEN, GITHUB_TOKEN and the state credential come from the GitHub environment (README, "Credentials").
environment  = "staging"
network_cidr = "10.10.0.0/24"

# Two Medium nodes (2 vCPU, 4 GB each, $21.73 a month), so that two replicas can sit on different nodes.
node_size  = "g4s.kube.medium"
node_count = 2

# The smallest PostgreSQL 17 (2 vCPU, 4 GB, 40 GB NVMe, $43.45 a month), one node.
database_size  = "g3.db.small"
database_nodes = 1

zone_name = "answerable-staging.uk"
# mcp is the standalone server's, which serves every standalone MCP by path: no MCP adds a name.
hostnames = {
  id        = "id.answerable-staging.uk"
  toolbox   = "toolbox.answerable-staging.uk"
  admin_mcp = "admin-mcp.answerable-staging.uk"
  mcp       = "mcp.answerable-staging.uk"
}
