output "bucket" {
  description = "The state bucket's name, as backend.tf names it."
  value       = civo_object_store.this.name
}

output "bucket_url" {
  description = "The bucket's URL as Civo reports it."
  value       = civo_object_store.this.bucket_url
}

output "endpoint" {
  description = "The region's S3 endpoint, as backend.tf names it."
  value       = "https://objectstore.${lower(var.region)}.civo.com"
}

output "credential_name" {
  description = "The state credential's name."
  value       = civo_object_store_credential.this.name
}

output "access_key_id" {
  description = "The state credential's access key, the backend's AWS_ACCESS_KEY_ID."
  value       = civo_object_store_credential.this.access_key_id
}

output "secret_access_key" {
  description = "The state credential's secret key, the backend's AWS_SECRET_ACCESS_KEY."
  value       = civo_object_store_credential.this.secret_access_key
  sensitive   = true
}
