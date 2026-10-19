# The environment's GitHub side: the three secrets the deploy and ops jobs reach the cluster with, written into the
# environment the owner created. The environment's policy and reviewer are the owner's, not Terraform's (main.tf).
mock_provider "github" {
  override_during = plan
}

variables {
  environment = "staging"
  repository  = "answerable-monorepo"
  kube_server = "https://74.220.1.2:6443"
  kube_ca     = "placeholder: cluster CA"
  kube_token  = "placeholder: deployer token"
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

  assert {
    condition     = output.environment == "staging"
    error_message = "The module must report the environment it writes into."
  }
}

run "writes_into_the_production_environment" {
  command = plan

  variables {
    environment = "production"
  }

  assert {
    condition     = alltrue([for secret in github_actions_environment_secret.this : secret.environment == "production"])
    error_message = "Production's secrets go into the production environment."
  }
}

run "refuses_an_owner_in_the_repository_name" {
  command = plan

  variables {
    repository = "Rieranthony/answerable-monorepo"
  }

  expect_failures = [var.repository]
}
