# Staging in the answerable-staging Civo account. No secret and no personal address here: CIVO_TOKEN,
# CLOUDFLARE_API_TOKEN, the backend's AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, and TF_VAR_allowed_api_cidrs come
# from the environment (README, "Credentials").
environment  = "staging"
network_cidr = "10.10.0.0/24"

# The Kubernetes API admits the whole internet in staging, authenticated by the cluster alone (TLS, then the
# namespace-scoped deployer token or the admin certificate), because GitHub-hosted runners cannot be listed in a
# firewall. A stopgap decided by the coordinator on 13 October 2026, until a later brief closes it with a GitOps
# controller pulling from inside the cluster or a Cloudflare tunnel. Production keeps it false.
api_open_to_internet = true

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

# The platform chart's own overlay for this environment, relative to this directory; the plan fails if it is missing.
platform_values_files = ["../../../../charts/platform/values-civo-staging.yaml"]
