output "environment" {
  description = "The GitHub environment Terraform configures."
  value       = github_repository_environment.this.environment
}

output "secret_names" {
  description = "The secrets Terraform writes into the environment."
  value       = sort([for secret in github_actions_environment_secret.this : secret.secret_name])
}
