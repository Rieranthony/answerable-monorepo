locals {
  # What the deploy and ops jobs need to reach the cluster, and nothing else Terraform knows: the API's address, the
  # cluster's CA and the namespace-scoped deployer's token.
  secrets = {
    KUBE_SERVER = var.kube_server
    KUBE_CA     = var.kube_ca
    KUBE_TOKEN  = var.kube_token
  }
}

# The environment itself is the owner's: they create it once, with its deployment policy (the branch main and the tags
# <environment>/*) and, for production, themselves as the required reviewer, and paste its five secrets. Terraform
# writes only the three deploy secrets into it. Managing the environment and its policies from here would need a token
# with the repository's Administration permission, which can also rename or delete the repository (GitHub's permission
# tables); writing secrets needs Environments: write alone, so that is all GH_SECRETS_TOKEN holds.
#
# The provider encrypts each value with the environment's public key before sending it; the plaintext stays in
# Terraform's state, which is one more reason the state is guarded like the cluster itself (README).
resource "github_actions_environment_secret" "this" {
  for_each = local.secrets

  repository  = var.repository
  environment = var.environment
  secret_name = each.key
  value       = each.value
}
