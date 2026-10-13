# Setup

The commands a person runs once per environment to take an empty Civo account to a running Answerable, without typing or pasting a secret. Every command is `bun run setup <command> --environment staging|production`, from the repository root, on a trusted machine. Decisions: D19, D23, D25, D28 and D30 in [`docs/goals/aws-deploy/decisions.md`](../../docs/goals/aws-deploy/decisions.md).

No command prints a secret. Values travel from your environment variables, Terraform's outputs and the `sops` file into memory, and from there into a child process's standard input, an encrypted file or an HTTPS request. Nothing overwrites a file or a GitHub secret that exists unless you pass `--force`. Exit codes: `0` done, `1` a step failed (the message says which), `2` wrong usage. `--help` lists every option.

## Before you start

**Tools.** Terraform 1.16.5, `sops` 3.13, `age-keygen`, **OpenSSL 3** (macOS's `/usr/bin/openssl` is LibreSSL: `brew install openssl@3` and put it first on `PATH`), `gh` signed in (`gh auth login`), and `kubectl` if the database must be read from a pod.

**From the owner** ([B0](../../docs/goals/aws-deploy/briefs/b0.md), [B7](../../docs/goals/aws-deploy/briefs/b7.md)). Keep each where you keep your own secrets and export it in the shell that runs the commands.

| Variable | What | Used by |
| --- | --- | --- |
| `CIVO_TOKEN` | The environment's Civo account API key | `first-apply`, `publish-env` |
| `CLOUDFLARE_API_TOKEN` | Terraform's token for the zone, with the five permissions in [`infra/civo/README.md`](../civo/README.md#credentials) | `first-apply`, `origin-pull`, `publish-env` |
| `CERT_MANAGER_CLOUDFLARE_TOKEN` | A **second** token for the zone with Zone > DNS > Edit only, for cert-manager's DNS-01 challenge. It must differ from the first | `init-secrets` |
| `ALLOWED_API_CIDRS` | The operators' addresses for the Kubernetes API, a JSON list such as `'["198.51.100.7/32"]'`. Staging: optional (`[]`). Production: required, and this machine must be in it | `first-apply`, `publish-env` |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | The environment's Entra app registration ([`docs/06`](../../docs/06-deploying-answerable-id.md), Platform applications). Optional, as a pair | `init-secrets` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A Google client, if any. Optional, as a pair | `init-secrets` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The Terraform state bucket's credential. It exists once `first-apply` has made the bucket, and every later command that reads Terraform's state needs it: `first-apply` prints the key ID, and `civo objectstore credential secret -a <key id>` (or the Civo dashboard, Object stores > Credentials) shows the secret | `first-apply --resume`, `database-ca`, `init-secrets`, `publish-env` |

Also before the first apply: Bot Fight Mode off in the zone, and the other items under "Before the first apply" in [`infra/civo/README.md`](../civo/README.md#before-the-first-apply).

## The first run, in order

Staging shown; production is the same with `--environment production` and its own zone, `answerable.org`.

| # | Command | Needs | Writes | Undo |
| --- | --- | --- | --- | --- |
| 1 | `age-init` | `age-keygen` | `~/.config/sops/age/answerable-staging.txt` (mode 600) when absent; the staging rule in `.sops.yaml` | Remove the rule. Keep the key while any file encrypted to it exists |
| 2 | `first-apply` | `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN` | The state bucket, the state moved into it, the network, cluster, database and firewalls. Stops before the full apply | `terraform destroy` in the root, after a reviewed change removes `prevent_destroy` from the bucket and the database |
| 3 | `origin-pull --zone answerable-staging.uk` | `CLOUDFLARE_API_TOKEN`, OpenSSL 3 | `infra/civo/envs/staging/edge-ca/ca.pem`; a client certificate on the zone | Delete the certificate (the command prints its ID and the `curl`), delete `ca.pem` |
| 4 | `database-ca` | `AWS_*`, OpenSSL 3 | `infra/civo/envs/staging/database-ca.pem` | Delete the file |
| 5 | `first-apply --resume` | as 2, plus `AWS_*` | The namespaces, the platform chart, the deployer, the Cloudflare zone's records and rules | As 2 |
| 6 | `init-secrets` | `AWS_*`, `CERT_MANAGER_CLOUDFLARE_TOKEN`, the Microsoft pair | `infra/civo/envs/staging/secrets.enc.yaml` | Delete the file before it is deployed; afterwards, rotate instead |
| 7 | `publish-env --enable` | `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `AWS_*`, the age key | GitHub environments `staging` and `infra-staging` with their secrets; the repository variable `DEPLOY_STAGING=true` | `gh secret delete <name> --env <environment>`; `gh variable delete DEPLOY_STAGING` turns the deploys off |
| 8 | Commit `.sops.yaml` and the three files, push to `main` | | The first deploy: `ops-bootstrap`, the migrations, the release, the smoke test ([`infra/pipeline/README.md`](../pipeline/README.md)) | `helm rollback` or a redeploy of an earlier tag |
| 9 | `id-first-run --domain answerable.org --entra-tenant <tenant id>` | the age key | In ID: the staff domain and the Entra SSO provider of the platform organisation | `DELETE` them with the root secret, as [`onboard.mdx`](../../apps/web/content/docs/id/onboard.mdx) describes |
| 10 | Sign in once at `https://id.answerable-staging.uk/login` | your work account | Your user and platform membership | |
| 11 | `id-make-admin --email you@answerable.org` | the age key | Your membership of `platform-admins`. **Root locks itself** | The break-glass procedure in `onboard.mdx` |
| 12 | A staff token in the Secret `ops-staff-token` (key `OPS_ID_TOKEN`), then the `ops` workflow's `register` | `onboard.mdx`, Get a staff token | The MCP registrations ([`infra/ops/README.md`](../ops/README.md)) | |

Production differs in three places: `ALLOWED_API_CIDRS` is required and must include this machine; its single GitHub environment `production` holds every secret and requires the owner's approval; and `publish-env` refuses `--enable`, because production is promoted by hand.

## The commands

### `age-init`

Creates the environment's `age` key with `age-keygen` when its file is absent, reads its public recipient, and writes or updates the environment's creation rule in `.sops.yaml` (`path_regex: infra/civo/envs/<env>/secrets\.enc\.yaml$`), keeping every other rule. It never reads the private key into memory or prints it. When the rule names another recipient it stops: `--force` switches the rule to this key, after which re-encrypt the file with `sops updatekeys`. Commit `.sops.yaml`.

### `first-apply`

Runs [`infra/civo/README.md`](../civo/README.md#first-apply) § First apply, steps 2, 3, 5 and 6, in `infra/civo/envs/<env>`:

- **Step 2.** Writes `backend_override.tf` (local state), `terraform init`, `terraform apply -target=module.state`.
- **Step 3.** Reads the state credential from the local state into memory, removes the override, `terraform init -migrate-state` with the credential in Terraform's environment only, checks `terraform state list` reads from the bucket, then deletes the local `terraform.tfstate` and its backup. It prints the credential's key ID and where its secret is.
- **Step 4**, the lock proof, is printed as a check to do by hand.
- **Step 5.** `terraform apply` of the cluster, the database and the firewalls.
- **Step 6.** The full `terraform apply`, but only once `edge-ca/ca.pem` and `database-ca.pem` exist. Otherwise it stops and names the commands to run, then `first-apply --resume`.

Terraform asks before each change and before it copies the state unless you pass `--yes` (`-auto-approve`, and `-force-copy` for the migration). A failed step says which; rerun the command. It refuses a fresh run once this machine has initialised the root against the bucket: use `--resume`. Step 7 is `publish-env`; step 8, pinning the cluster version, is printed at the end.

### `origin-pull --zone <zone>`

Generates, in a temporary directory deleted afterwards, an origin-pull CA (ECDSA P-256, 10 years, `basicConstraints=CA:TRUE, pathlen:0`) and a client certificate it signs (ECDSA P-256, 5 years, CN `cloudflare-origin-pull.<zone>`, `extendedKeyUsage=clientAuth`), and checks the pair with `openssl verify`. It looks the zone's ID up by name, uploads the client certificate and key as the zone's Authenticated Origin Pulls certificate (`POST /zones/<zone id>/origin_tls_client_auth`, [Cloudflare's reference](https://developers.cloudflare.com/api/resources/origin_tls_client_auth/subresources/zone_certificates/methods/create/)), waits until Cloudflare reports it `active`, and writes only the CA's public certificate to `edge-ca/ca.pem`. The client's key goes to Cloudflare and nowhere else; to replace it, rotate.

**Rotate** with `--force`. Cloudflare presents the newest active certificate as soon as it is deployed ([manage certificates](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/set-up/manage-certificates/)), so Traefik must trust the new CA first. The command writes `ca.pem` with the new CA and the old one, and waits while you run `terraform apply`. It then uploads the new certificate, waits for it, writes `ca.pem` with the new CA alone, and prints the `curl` that deletes each older certificate. Apply again, and delete them. Answering `no` at the pause puts the old `ca.pem` back and uploads nothing.

### `database-ca`

Reads `database_host` and `database_port` from Terraform, connects with `openssl s_client -starttls postgres -showcerts`, keeps the self-signed root of the presented chain (or the topmost certificate when no root is presented, with a warning), writes it to `database-ca.pem`, and prints each certificate's subject and issuer, the kept certificate's validity and SHA-256 fingerprint, and whether the server's certificate names the host the services connect to.

**This is trust on first use.** The file holds whatever answered that connection. Compare the fingerprint with what Civo shows for the database where it shows one, and record it with the date.

The database sits on the private network, so from your machine the connection usually fails. The command then prints the exact `kubectl run` that fetches the chain from a pod with the cluster's admin kubeconfig (`civo kubernetes config answerable-<env>-cluster > admin.kubeconfig`, or the dashboard's download) and pipes it into `database-ca --from-stdin`. The pod runs Alpine pinned by digest, installs `openssl`, and is deleted when it ends.

### `init-secrets`

Builds in memory the three Secrets the deploy applies (`sops --decrypt … | kubectl apply -n answerable -f -`), in namespace `answerable`:

| Secret | Keys | Values |
| --- | --- | --- |
| `id-env` | `BETTER_AUTH_SECRET`, `UPSTREAM_TOKEN_SECRETS`, `ROOT_ADMIN_SECRET`, and the platform pairs when given | 48 random bytes, base64; `[{"version":1,"value":"<32 random bytes, base64url>"}]`; 48 random bytes, base64. Random values come from `crypto.getRandomValues` |
| `postgres-admin` | `OPS_DATABASE_ADMIN_URL` | Terraform's `database_admin_url`, which must ask for `sslmode=verify-full` |
| `cloudflare-api-token` | `api-token` | `CERT_MANAGER_CLOUDFLARE_TOKEN` |

It pipes them to `sops --config .sops.yaml encrypt --filename-override infra/civo/envs/<env>/secrets.enc.yaml`, writes the result, decrypts the file again and checks it holds exactly what was written, printing the keys and never the values.

`--rotate <key>` decrypts the file, replaces one value and re-encrypts:

| Key | New value |
| --- | --- |
| `ROOT_ADMIN_SECRET` | 48 new random bytes |
| `UPSTREAM_TOKEN_SECRETS` | A new key, first, with the next version; the previous keys stay so that tokens they encrypted remain readable. Pods of the previous release cannot read tokens the new key encrypts until the rollout finishes |
| `OPS_DATABASE_ADMIN_URL` | Terraform's output again |
| `api-token` | `CERT_MANAGER_CLOUDFLARE_TOKEN` |
| `MICROSOFT_CLIENT_ID` or `MICROSOFT_CLIENT_SECRET`; the Google pair | Both of the pair, from the environment. This is also how a pair is added later |

`BETTER_AUTH_SECRET` is refused: it encrypts ID's stored signing keys, and replacing it makes them unreadable. Rotate it through `BETTER_AUTH_SECRETS`, the versioned ring (`apps/id/README.md`). `--force` replaces the whole file with new random values, which ID cannot read its existing data with once deployed: use it only before the first deploy.

### `publish-env [--enable]`

Reads every value first (Terraform's `kube_server`, `kube_ca`, `kube_token`, `state_access_key_id`, `state_secret_access_key`; `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `ALLOWED_API_CIDRS`; the `AGE-SECRET-KEY` line of the key file), then creates the GitHub environments when missing and sets their secrets with `gh secret set <name> --env <environment> --repo Rieranthony/answerable-monorepo`, each value on standard input. The names are the ones the workflows read ([`infra/pipeline/README.md`](../pipeline/README.md#what-each-github-environment-holds)):

| Environment | Created with | Secrets |
| --- | --- | --- |
| `staging` | Deployments from `main` only | `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN`, `SOPS_AGE_KEY` |
| `infra-staging` | Deployments from every branch, so that pull requests can plan | `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY`, `ALLOWED_API_CIDRS` |
| `production` | The repository's owner as required reviewer, self-review allowed, deployments from `main` only | All nine |

An environment that exists keeps its settings. A secret that exists is kept and listed; `--force` replaces it. `--enable` sets the repository variable `DEPLOY_STAGING=true`, which turns on the staging jobs of `deploy-staging.yml`; without it a push to `main` runs CI only. It lists what it set and kept, by name.

### `id-first-run --domain <domain> --entra-tenant <tenant id>`

Decrypts `ROOT_ADMIN_SECRET` from the `sops` file into memory and makes [`onboard.mdx`](../../apps/web/content/docs/id/onboard.mdx) § First run's calls against `https://<hostnames.id>` of `charts/answerable/values-civo-<env>.yaml`, with the same `Idempotency-Key`s: it finds the platform organisation (slug `answerable`), adds the staff domain (`platform-domain-setup`), puts the SSO provider with issuer `https://login.microsoftonline.com/<tenant id>/v2.0` on Answerable's platform application (`platform-sso-setup`, `If-None-Match: *`), runs the connectivity test and prints it, then the login URL and the next command. Running it again replays: an equal domain or provider is left as it is, a different one stops the command.

### `id-make-admin --email <address>`

With the root secret, finds the platform member with that email (sign in once first), adds them to `platform-admins` (`platform-admin-membership-setup`, `If-None-Match: *`), and confirms that ID now refuses the root secret (`403 root_locked`). From then on `register` and every other admin call need a staff token: put one in the Secret `ops-staff-token` (key `OPS_ID_TOKEN`) in namespace `answerable`. `ROOT_ADMIN_SECRET` stays in the `sops` file as the break-glass, with `ROOT_ADMIN_BREAK_GLASS=false`.

## Errors

| Message | Meaning | What to do |
| --- | --- | --- |
| `… is not set: …` | A variable the command needs is missing | Export it; the message says which and what it is |
| `AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must hold …` | The state is in the bucket and the command reads it | Export the state credential (see the table above) |
| `these commands need OpenSSL 3` | `openssl` on `PATH` is LibreSSL or missing | Install OpenSSL 3 and put it first on `PATH` |
| `… exists. Run again with --force …` | The file would be overwritten | Keep it, or pass `--force` knowing what that replaces |
| `already keeps its state in the bucket` | `first-apply` without `--resume` after the migration | `first-apply --resume` |
| `no certificate from <host>:<port>` | The database is not reachable from this machine | Run the printed `kubectl run … \| … --from-stdin` |
| `sops could not encrypt … no matching creation rules found` | `.sops.yaml` has no rule for the environment | `age-init` |
| `sops could not decrypt …` | The key is not in `--key-dir` or `SOPS_AGE_KEY` | Point `--key-dir` at the key, or export `SOPS_AGE_KEY` |
| `gh is not signed in to github.com` | `gh` has no session | `gh auth login` |
| `ID refused the root secret (403 root_locked)` | A platform administrator exists | The first run is over; use a staff token |
| `ID refused the root secret (401)` | The deployed `ROOT_ADMIN_SECRET` differs from the `sops` file's | Redeploy so that the cluster has the file's Secrets |
| `ID has no Microsoft platform application` | `id-env` lacks the Microsoft pair | `init-secrets --rotate MICROSOFT_CLIENT_SECRET` with both variables set, deploy, rerun |
| `the connectivity test found problems` | ID cannot reach the tenant's discovery or keys | Read the printed problems; the tenant ID is the usual cause |

## Prove it

```sh
bun run --filter @answerable/infra-setup prove
```

Runs the real-tool paths that need no account, in a temporary directory it deletes: `age-init` with the real `age-keygen` against a throwaway `.sops.yaml` and key directory (`--sops-config`, `--key-dir`); `init-secrets` encrypting and decrypting with the real `sops` and that key, with Terraform's output faked; `origin-pull` with the real `openssl` and a fake Cloudflare, checking the curve, the lifetimes, the signature and that the uploaded key is the client's, and a rotation; `database-ca` against PostgreSQL 17 with TLS in Docker, from this machine and through the printed pod command's script in the same Alpine image. It needs `age-keygen`, `sops`, OpenSSL 3 and Docker, takes a few seconds once the two images are pulled (6 s measured), and removes its container and network.

## Develop

`bun run mcp:check @answerable/infra-setup` typechecks, lints and tests the workspace (100% line and function coverage). Every program runs through one injectable runner (`src/run.ts`) and every HTTP call through an injectable `fetch`, so the tests use fakes and touch no network, account, GitHub or the real `.sops.yaml`.
