# Production in the answerable-production Civo account. No secret and no personal address here: CIVO_TOKEN,
# CLOUDFLARE_API_TOKEN, the backend's STATE_ACCESS_KEY_ID and STATE_SECRET_ACCESS_KEY, and TF_VAR_allowed_api_cidrs come
# from the environment (README, "Credentials").
environment  = "production"
network_cidr = "10.20.0.0/24"

# The Kubernetes API admits TF_VAR_allowed_api_cidrs only. The cluster module refuses true here: production waits for
# the GitOps or tunnel follow-up rather than opening its API to the internet as staging does.
api_open_to_internet = false

# Three Medium nodes (2 vCPU, 4 GB each, $21.73 a month): two replicas per service on different nodes, with room to
# drain one node for maintenance.
node_size  = "g4s.kube.medium"
node_count = 3

# Medium PostgreSQL 17 (4 vCPU, 8 GB, 80 GB NVMe, $86.91 a month) with two additional nodes for fault tolerance,
# priced separately by Civo (portability.md).
database_size  = "g3.db.medium"
database_nodes = 3

# Production's records sit beside Vercel's DNS-only www in the answerable.org zone; the edge module writes these three
# names and nothing else.
zone_name = "answerable.org"
hostnames = {
  id        = "id.answerable.org"
  toolbox   = "toolbox.answerable.org"
  admin_mcp = "admin-mcp.answerable.org"
}

# The platform chart's own overlay for this environment, relative to this directory; the plan fails if it is missing.
platform_values_files = ["../../../../charts/platform/values-civo-production.yaml"]
