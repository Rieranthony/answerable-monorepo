# State lives in the environment's own Civo object store (D27), in the bucket answerable-<environment>-tfstate that the
# bootstrap workflow creates with the Civo CLI. The bucket and the key are left out here (partial configuration):
# ./terraform.sh <environment> passes them to `init`, and hands STATE_ACCESS_KEY_ID and STATE_SECRET_ACCESS_KEY to this
# backend. Civo's object store speaks S3 with path-style addressing and without the account, metadata and checksum
# calls the backend makes by default, so those are switched off below. Whether it honours the conditional writes
# `use_lockfile` relies on is confirmed on the first apply; the fallback is in the README.
terraform {
  backend "s3" {
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
