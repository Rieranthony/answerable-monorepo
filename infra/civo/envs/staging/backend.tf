# State lives in this account's own Civo object store (D27), created by module.state in this root; the README's first
# apply creates it with local state and then migrates. Credentials come from AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY (the `state_access_key_id` and `state_secret_access_key` outputs). Civo's S3 compatibility is
# not AWS: no account ID, no metadata API, no checksum headers, path-style addressing. Whether it honours the
# conditional writes `use_lockfile` relies on is confirmed on the first apply; the fallback is in the README.
terraform {
  backend "s3" {
    bucket                      = "answerable-staging-tfstate"
    key                         = "staging.tfstate"
    region                      = "LON1"
    endpoints                   = { s3 = "https://objectstore.lon1.civo.com" }
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
