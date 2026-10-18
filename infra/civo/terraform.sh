#!/bin/sh
# Terraform for the Civo roots, with the state bucket's credential taken from STATE_ACCESS_KEY_ID and
# STATE_SECRET_ACCESS_KEY: the names the operator exports and the GitHub environments hold. Terraform's S3 backend
# reads a credential only from the two names below, or from -backend-config, which would write it into .terraform/
# and into plan files. infra/setup's backendEnv does the same for the setup commands.
#
#   infra/civo/terraform.sh -chdir=infra/civo/envs/staging plan
set -eu
if [ -n "${STATE_ACCESS_KEY_ID:-}" ]; then
  AWS_ACCESS_KEY_ID=$STATE_ACCESS_KEY_ID
  export AWS_ACCESS_KEY_ID
fi
if [ -n "${STATE_SECRET_ACCESS_KEY:-}" ]; then
  AWS_SECRET_ACCESS_KEY=$STATE_SECRET_ACCESS_KEY
  export AWS_SECRET_ACCESS_KEY
fi
exec terraform "$@"
