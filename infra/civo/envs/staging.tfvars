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
# On mcp the Toolbox serves every standalone MCP by path: no MCP adds a name.
hostnames = {
  id        = "id.answerable-staging.uk"
  toolbox   = "toolbox.answerable-staging.uk"
  admin_mcp = "admin-mcp.answerable-staging.uk"
  mcp       = "mcp.answerable-staging.uk"
}

# Postmark's DNS records for the mail domain id.answerable-staging.uk, which the edge module writes DNS-only when this is set and not
# before. Absent, no mail record is written. The values are public: add the domain id.answerable-staging.uk in this environment's
# Postmark account, copy them from its DNS Settings page, uncomment this block and commit it (infra/README.md, Send mail
# through Postmark). dkim_value is the TXT value that starts k=rsa; without quotes; dkim_host and return_path_host are the
# hosts Postmark shows, in full; dmarc_value starts v=DMARC1; p=none; staging can stop there, since a report address
# outside this domain needs that domain's authorisation. No SPF record exists: Postmark
# asks for none on the From domain.
# mail_records = {
#   dkim_host        = "<selector>._domainkey.id.answerable-staging.uk"
#   dkim_value       = "k=rsa;p=<the public key Postmark shows>"
#   return_path_host = "pm-bounces.id.answerable-staging.uk"
#   dmarc_value      = "v=DMARC1; p=none"
# }
