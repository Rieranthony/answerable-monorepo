locals {
  # What the deploy and ops jobs need to reach the cluster, and nothing else Terraform knows: the API's address, the
  # cluster's CA and the namespace-scoped deployer's token.
  secret_names = ["KUBE_SERVER", "KUBE_CA", "KUBE_TOKEN"]
  secrets = {
    KUBE_SERVER = var.kube_server
    KUBE_CA     = var.kube_ca
    KUBE_TOKEN  = var.kube_token
  }
}

# The token owner, production's only reviewer: GitHub's "get the authenticated user".
data "github_user" "reviewer" {
  count    = var.environment == "production" ? 1 : 0
  username = ""
}

# The environment exists before Terraform first runs: the owner creates it and pastes its five secrets. The provider
# creates an environment with GitHub's "create or update an environment" call (PUT), so the first apply adopts the
# existing one in place, and every apply puts back what is below. Destroying it would delete the owner's secrets too,
# so Terraform never does.
resource "github_repository_environment" "this" {
  repository  = var.repository
  environment = var.environment

  # The owner pushes production's tag and approves its run.
  prevent_self_review = false

  # Only what the two policies below name may use the environment: the branch main and the tags <environment>/*.
  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }

  # Production waits for the owner's review; staging deploys without one.
  dynamic "reviewers" {
    for_each = data.github_user.reviewer

    content {
      users = [reviewers.value.id]
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_repository_environment_deployment_policy" "main" {
  repository     = var.repository
  environment    = github_repository_environment.this.environment
  branch_pattern = "main"
}

resource "github_repository_environment_deployment_policy" "tags" {
  repository  = var.repository
  environment = github_repository_environment.this.environment
  tag_pattern = "${var.environment}/*"
}

# The provider encrypts each value with the environment's public key before sending it; the plaintext stays in
# Terraform's state, which is one more reason the state is guarded like the cluster itself (README).
resource "github_actions_environment_secret" "this" {
  for_each = toset(local.secret_names)

  repository  = var.repository
  environment = github_repository_environment.this.environment
  secret_name = each.key
  value       = local.secrets[each.key]
}
