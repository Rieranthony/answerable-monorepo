locals {
  name = "answerable-${var.environment}-tfstate"
}

# The credential the S3 backend uses (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY when Terraform runs). Civo generates
# the secret; it lives in this state, in the bucket it unlocks, and in the protected GitHub environment of the infra
# workflow. Civo credentials are scoped to a region, not to a bucket.
resource "civo_object_store_credential" "this" {
  name   = local.name
  region = var.region

  lifecycle {
    prevent_destroy = true
  }
}

# The bucket that holds this environment's state. The root that creates it also keeps its state in it: the first
# apply runs with local state, then `terraform init -migrate-state` moves the state here (see the README).
resource "civo_object_store" "this" {
  name          = local.name
  region        = var.region
  max_size_gb   = var.max_size_gb
  access_key_id = civo_object_store_credential.this.access_key_id

  lifecycle {
    prevent_destroy = true
  }
}
