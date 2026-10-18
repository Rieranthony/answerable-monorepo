# State lives in this account's own Civo object store (D27), created by module.state in this root; the README's first
# apply creates it with local state and then migrates. The credential is STATE_ACCESS_KEY_ID and
# STATE_SECRET_ACCESS_KEY (the `state_access_key_id` and `state_secret_access_key` outputs), which ../../terraform.sh
# hands to this backend. Civo's object store speaks S3 with path-style addressing and without the account, metadata
# and checksum calls the backend makes by default, so those are switched off below. Whether it honours the
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
