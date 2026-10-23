#!/usr/bin/env bash
# Lists the state bucket with the credential in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, at the endpoint Terraform's
# backend uses (backend.tf: the region's object store, path-style), so that a pair in the wrong region or a stale one
# fails in the Bootstrap workflow, with the store's own answer, and not at the first tag's init.
#
#   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… infra/civo/check-state.sh <region> <bucket>
set -euo pipefail
region=${1:?usage: check-state.sh <region> <bucket>}
bucket=${2:?usage: check-state.sh <region> <bucket>}
endpoint="https://objectstore.$(tr '[:upper:]' '[:lower:]' <<< "$region").civo.com"
# Path-style addressing, as the backend uses: the AWS CLI takes it from a config file only. No checksum headers, which
# the store does not speak, and no instance-metadata lookup.
config=$(mktemp)
printf '[default]\ns3 =\n    addressing_style = path\n' > "$config"
AWS_CONFIG_FILE=$config AWS_EC2_METADATA_DISABLED=true AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
  aws s3api list-objects-v2 --bucket "$bucket" --max-keys 1 --endpoint-url "$endpoint" --region "$region" > /dev/null
echo "The state credential lists $bucket at $endpoint."
