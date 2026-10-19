# The environment's GitHub side: who may deploy (the branch main and the tags <environment>/*), who must approve
# (production: the token owner), and the three secrets the deploy and ops jobs reach the cluster with.
mock_provider "github" {
  override_during = plan

  mock_data "github_user" {
    defaults = {
      id    = "1234567"
      login = "owner"
    }
  }
}

variables {
  environment = "staging"
  repository  = "answerable-monorepo"
  kube_server = "https://74.220.1.2:6443"
  kube_ca     = "placeholder: cluster CA"
  kube_token  = "placeholder: deployer token"
}

run "deploys_from_main_and_the_environments_tags_only" {
  command = plan

  assert {
    condition = (
      github_repository_environment.this.repository == "answerable-monorepo"
      && github_repository_environment.this.environment == "staging"
    )
    error_message = "The module must configure the environment named after the Answerable environment, in the repository given."
  }

  assert {
    condition = (
      length(github_repository_environment.this.deployment_branch_policy) == 1
      && !github_repository_environment.this.deployment_branch_policy[0].protected_branches
      && github_repository_environment.this.deployment_branch_policy[0].custom_branch_policies
    )
    error_message = "Only the custom policies may name what deploys, not every protected branch."
  }

  assert {
    condition = (
      github_repository_environment_deployment_policy.main.branch_pattern == "main"
      && github_repository_environment_deployment_policy.main.tag_pattern == null
      && github_repository_environment_deployment_policy.main.environment == "staging"
    )
    error_message = "One policy must admit the branch main."
  }

  assert {
    condition = (
      github_repository_environment_deployment_policy.tags.tag_pattern == "staging/*"
      && github_repository_environment_deployment_policy.tags.branch_pattern == null
      && github_repository_environment_deployment_policy.tags.environment == "staging"
    )
    error_message = "One policy must admit the tags staging/*, the deploy workflow's trigger."
  }

  assert {
    condition     = length(github_repository_environment.this.reviewers) == 0
    error_message = "Staging deploys without a review."
  }
}

run "writes_the_three_kube_secrets" {
  command = plan

  assert {
    condition     = toset(keys(github_actions_environment_secret.this)) == toset(["KUBE_SERVER", "KUBE_CA", "KUBE_TOKEN"])
    error_message = "Terraform writes KUBE_SERVER, KUBE_CA and KUBE_TOKEN and no other secret."
  }

  assert {
    condition = alltrue([
      for name, secret in github_actions_environment_secret.this :
      secret.secret_name == name && secret.environment == "staging" && secret.repository == "answerable-monorepo"
    ])
    error_message = "Each secret must be named as its key, in the environment's own scope."
  }

  assert {
    condition = (
      nonsensitive(github_actions_environment_secret.this["KUBE_SERVER"].value) == "https://74.220.1.2:6443"
      && nonsensitive(github_actions_environment_secret.this["KUBE_CA"].value) == "placeholder: cluster CA"
      && nonsensitive(github_actions_environment_secret.this["KUBE_TOKEN"].value) == "placeholder: deployer token"
    )
    error_message = "KUBE_SERVER is the API's URL, KUBE_CA the cluster's CA and KUBE_TOKEN the deployer's token."
  }

  assert {
    condition     = output.secret_names == tolist(["KUBE_CA", "KUBE_SERVER", "KUBE_TOKEN"])
    error_message = "The module must report the secrets it writes."
  }
}

run "makes_production_wait_for_the_token_owner" {
  command = plan

  variables {
    environment = "production"
  }

  assert {
    condition = (
      length(github_repository_environment.this.reviewers) == 1
      && github_repository_environment.this.reviewers[0].users == toset([1234567])
      && !github_repository_environment.this.prevent_self_review
    )
    error_message = "Production must wait for the token owner, who may approve the run they started."
  }

  assert {
    condition     = github_repository_environment_deployment_policy.tags.tag_pattern == "production/*"
    error_message = "Production deploys from the tags production/*."
  }
}

run "refuses_an_owner_in_the_repository_name" {
  command = plan

  variables {
    repository = "Rieranthony/answerable-monorepo"
  }

  expect_failures = [var.repository]
}
