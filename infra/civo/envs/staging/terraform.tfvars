# Staging in the answerable-staging Civo account. No secret and no personal address here: CIVO_TOKEN,
# CLOUDFLARE_API_TOKEN, the backend's AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and TF_VAR_allowed_api_cidrs come
# from the environment (README, "Credentials").
environment  = "staging"
network_cidr = "10.10.0.0/24"

# Two Medium nodes (2 vCPU, 4 GB each, $21.73 a month), so that two replicas can sit on different nodes.
node_size  = "g4s.kube.medium"
node_count = 2

# The smallest PostgreSQL 17 (2 vCPU, 4 GB, 40 GB NVMe, $43.45 a month), one node.
database_size  = "g3.db.small"
database_nodes = 1

zone_name = "answerable-staging.uk"
hostnames = {
  id        = "id.answerable-staging.uk"
  toolbox   = "toolbox.answerable-staging.uk"
  admin_mcp = "admin-mcp.answerable-staging.uk"
}

# The platform chart's own values files for this environment, relative to this directory, once charts/platform has them.
platform_values_files = []
