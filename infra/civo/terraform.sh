#!/bin/sh
# Terraform for one environment of the Civo root, from any directory:
#
#   infra/civo/terraform.sh staging init
#   infra/civo/terraform.sh staging apply -target=module.cluster -target=module.database -target=module.ingress_firewall
#   infra/civo/terraform.sh production plan -out=production.tfplan
#
# - Terraform runs in infra/civo, so a relative path in an argument is relative to it.
# - `init` gets the environment's state, answerable-<environment>-tfstate/<environment>.tfstate (backend.tf leaves both
#   out), and -reconfigure, so that switching environment in one checkout never offers to copy one state into the other.
# - `plan`, `apply`, `destroy`, `import` and `refresh` get envs/<environment>.tfvars; `apply` of a saved plan (its last
#   argument, an existing file) does not, because the plan holds its variables and Terraform refuses new ones. Every
#   other command (`output`, `state`, `validate`, `test` and the rest) runs as given.
# - The state credential arrives as STATE_ACCESS_KEY_ID and STATE_SECRET_ACCESS_KEY, the names the GitHub environments
#   hold. Terraform's S3 backend reads a credential only from the two names below, or from -backend-config, which
#   would write it into .terraform/ and into plan files, so they are mapped here, for Terraform's process alone.
#
# It prints nothing of its own but a usage error.
set -eu

if [ $# -lt 2 ]; then
  echo "usage: $0 <staging|production> <terraform command> [arguments...]" >&2
  exit 2
fi

environment=$1
command=$2
shift 2

case $environment in
  staging | production) ;;
  *)
    echo "$0: the environment must be staging or production, not '$environment'" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")"

# The last argument, which names the plan file when `apply` applies a saved plan.
last=
for argument in "$@"; do
  last=$argument
done

case $command in
  init)
    set -- -reconfigure "-backend-config=bucket=answerable-$environment-tfstate" "-backend-config=key=$environment.tfstate" "$@"
    ;;
  apply)
    case $last in
      -* | "") set -- "-var-file=envs/$environment.tfvars" "$@" ;;
      *) [ -f "$last" ] || set -- "-var-file=envs/$environment.tfvars" "$@" ;;
    esac
    ;;
  plan | destroy | import | refresh)
    set -- "-var-file=envs/$environment.tfvars" "$@"
    ;;
esac

if [ -n "${STATE_ACCESS_KEY_ID:-}" ]; then
  AWS_ACCESS_KEY_ID=$STATE_ACCESS_KEY_ID
  export AWS_ACCESS_KEY_ID
fi
if [ -n "${STATE_SECRET_ACCESS_KEY:-}" ]; then
  AWS_SECRET_ACCESS_KEY=$STATE_SECRET_ACCESS_KEY
  export AWS_SECRET_ACCESS_KEY
fi
# No checksum the store does not speak. backend.tf's skip_s3_checksum stops the backend's own SHA-256 checksum, but the
# AWS SDK underneath still adds its default CRC32 as a trailing checksum on every upload, and Civo's store answers
# XAmzContentSHA256Mismatch (the first staging apply, 23 October 2026; hashicorp/terraform#36704). The SDK reads these two.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required

exec terraform "$command" "$@"
