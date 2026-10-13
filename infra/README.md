# Infrastructure runbook

How to set up, deploy, promote, roll back, scale, rotate, restore and destroy Answerable's environments on Civo. Why each piece exists, and what runs where: [`docs/12-deployment.md`](../docs/12-deployment.md).

**Status.** Built and proved locally; not yet applied to a Civo account. The first staging deployment is brief [B7a](../docs/goals/aws-deploy/briefs/b7.md), which runs this page for the first time and corrects it.

**Conventions.** Run every command from the repository root on a trusted machine (your own, with disk encryption), unless a step says otherwise. Staging is shown; production is the same with `production` and the zone `answerable.org`, except where a step says otherwise. `<…>` is a value you fill in. No command here prints a secret, except the one step that says so: values travel through environment variables, files that Git ignores, or standard input.

## Where the details live

This page is the order of things. Each step links to the page that owns its details.

| Page | Owns |
| --- | --- |
| [`infra/setup/README.md`](setup/README.md) | The setup commands (`bun run setup …`): what each needs, writes and how to undo it, and their errors |
| [`infra/civo/README.md`](civo/README.md) | The Terraform roots and modules, credentials, the first apply by hand, the questions the first apply must answer, day two |
| [`infra/pipeline/README.md`](pipeline/README.md) | The workflows, what each GitHub environment holds, deploying and running Jobs by hand |
| [`infra/ops/README.md`](ops/README.md) | The `bootstrap` and `register` Jobs |
| [`infra/k8s/local/README.md`](k8s/local/README.md) | The kind stack (`bun run infra:test`) |
| [`charts/answerable/README.md`](../charts/answerable/README.md), [`charts/platform/README.md`](../charts/platform/README.md) | The charts' values and what they expect |

## Prerequisites

### Tools

| Tool | Version | Install on macOS | Used by |
| --- | --- | --- | --- |
| Bun | 1.3.1 | [bun.sh](https://bun.sh) | Everything; then `bun install` |
| Terraform | 1.16.5 exactly ([`.terraform-version`](.terraform-version)) | [releases.hashicorp.com](https://releases.hashicorp.com/terraform/1.16.5/) | `first-apply`, day two |
| `sops` | 3.13 | `brew install sops` | The secrets file |
| `age` | 1.3 (`age-keygen`) | `brew install age` | `age-init` |
| OpenSSL | 3: `openssl version` must say `OpenSSL 3` (macOS's own `/usr/bin/openssl` is LibreSSL) | If it does not: `brew install openssl@3`, then `export PATH="$(brew --prefix openssl@3)/bin:$PATH"` | `origin-pull`, `database-ca` |
| `gh` | any, signed in as a repository administrator | `brew install gh`, then `gh auth login` | `publish-env`, the workflows |
| `kubectl` | within one minor version of the cluster (CI pins 1.34.12) | `brew install kubectl` | `database-ca`'s pod, diagnostics |
| Helm | 4.3.0 | `brew install helm` | Diagnostics, rollback |
| `civo` | 1.5 | [Civo CLI](https://www.civo.com/docs/overview/civo-cli) | The state credential's secret, database backups |
| `jq` | any | `brew install jq` | A few commands below |

For the checks: `tflint` 0.64.0, `trivy` 0.75.0, `actionlint` 1.7.12 and `kubeconform` 0.8.0 (`bun run infra:check`); Docker, `kind` 0.33.0 and Playwright's Chromium (`bun run infra:test`). The versions CI pins are in [`.github/actions/setup-tools/action.yml`](../.github/actions/setup-tools/action.yml) and [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

### Accounts, once per environment

1. **Civo** ([B0](../docs/goals/aws-deploy/briefs/b0.md)). One Civo organisation with two accounts, `answerable-staging` and `answerable-production`, region LON1. You are in each account's Owners team with MFA on your login. Each account's API key ([Civo's page](https://www.civo.com/docs/account/api-keys)) is that environment's `CIVO_TOKEN`. Save it in the CLI too, interactively so that it stays out of your shell history:

   ```sh
   civo apikey save            # name it answerable-staging, paste the key when asked
   civo apikey use answerable-staging
   civo region use LON1
   ```

2. **Cloudflare.** The zone (`answerable-staging.uk` for staging, `answerable.org` for production) and **two API tokens scoped to that zone only**:
   - **Terraform's**, `CLOUDFLARE_API_TOKEN`: Zone > DNS > Edit, Zone > SSL and Certificates > Edit, Zone > Zone Settings > Edit, Zone > Config Rules > Edit, Zone > Cache Rules > Edit ([the list and why](civo/README.md#credentials)).
   - **cert-manager's**, `CERT_MANAGER_CLOUDFLARE_TOKEN`: Zone > DNS > Edit, for the Let's Encrypt DNS-01 challenge. It must differ from the first.
   - **Bot Fight Mode off** in the zone's Security settings. No token can change it, and it would challenge every MCP host.
3. **Microsoft Entra.** The environment's app registration, with the redirect URIs `https://id.answerable-staging.uk/auth/sso/callback` and `https://id.answerable-staging.uk/login` for staging, or production's in [`docs/06`](../docs/06-deploying-answerable-id.md#platform-applications-microsoft-entra-and-google). Its client ID and secret are `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. You also need the **tenant ID of Answerable's own staff directory** for ID's first run. A Google client is optional (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

### The `age` key

Each environment has one `age` key pair. `bun run setup age-init` creates it in `~/.config/sops/age/answerable-<environment>.txt` (mode 600) and commits only its public half, in `.sops.yaml`. **Back the file up where you keep your own secrets** the moment it exists: whoever holds it reads every human secret of that environment, and without it nobody can decrypt the secrets file or its history. Never paste it anywhere but `publish-env`, which hands it to GitHub as `SOPS_AGE_KEY`.

## First-time setup of an environment

The setup commands do the work and never print a secret ([`infra/setup/README.md`](setup/README.md#the-first-run-in-order) has the same order with what each step needs, writes and how to undo it). About an hour, most of it waiting for Civo.

**0. Open one shell and load the credentials** without echoing them. Each line asks for one value:

```sh
printf 'Civo API key: '; read -rs CIVO_TOKEN; echo; export CIVO_TOKEN
printf 'Cloudflare token for Terraform: '; read -rs CLOUDFLARE_API_TOKEN; echo; export CLOUDFLARE_API_TOKEN
printf 'Cloudflare token for cert-manager: '; read -rs CERT_MANAGER_CLOUDFLARE_TOKEN; echo; export CERT_MANAGER_CLOUDFLARE_TOKEN
printf 'Entra client ID: '; read -r MICROSOFT_CLIENT_ID; export MICROSOFT_CLIENT_ID
printf 'Entra client secret: '; read -rs MICROSOFT_CLIENT_SECRET; echo; export MICROSOFT_CLIENT_SECRET
export ALLOWED_API_CIDRS='[]'
```

For production, `ALLOWED_API_CIDRS` is required and must hold this machine's public address, which `curl -s https://www.cloudflare.com/cdn-cgi/trace | grep '^ip='` prints: `export ALLOWED_API_CIDRS='["<that address>/32"]'`.

**1. The `age` key and its `.sops.yaml` rule.**

```sh
bun run setup age-init --environment staging
```

Back up `~/.config/sops/age/answerable-staging.txt` now.

**2. The state bucket, the cluster, the database and the firewalls.** Terraform shows each plan and asks before it changes anything; answer `yes`. It stops before the full apply, because two certificates do not exist yet.

```sh
bun run setup first-apply --environment staging
```

**3. The state credential.** From here on every command that reads Terraform's state needs the bucket's credential. `first-apply` printed its key ID. The Civo CLI prints its secret key (the dashboard shows it too, under Object stores > Credentials): this is the one step that shows a secret on screen. Paste it into the prompt, keep it with your other secrets, and clear the terminal:

```sh
export AWS_ACCESS_KEY_ID=<the key ID first-apply printed>
civo objectstore credential secret --access-key "$AWS_ACCESS_KEY_ID"
printf 'State secret key: '; read -rs AWS_SECRET_ACCESS_KEY; echo; export AWS_SECRET_ACCESS_KEY
clear
```

If a step failed writing `staging.tfstate.tflock`, Civo's object store refuses Terraform's lock file: follow [step 4 of the first apply](civo/README.md#first-apply) (`use_lockfile = false`, one operator at a time).

**4. The origin-pull certificate.** Generates the CA and Cloudflare's client certificate, uploads the client pair to the zone, waits until Cloudflare reports it active and writes the CA's public certificate to `infra/civo/envs/staging/edge-ca/ca.pem`.

```sh
bun run setup origin-pull --environment staging --zone answerable-staging.uk
```

**5. The database's CA certificate**, trust on first use. The database sits on the private network, so the command reads the chain from a short-lived pod in the cluster, through Terraform's `admin_kubeconfig` output in a temporary file it deletes; it needs `kubectl`. If the pod fails, it prints the commands to run by hand ([details](setup/README.md#database-ca)).

```sh
bun run setup database-ca --environment staging
```

Record the SHA-256 fingerprint it prints, with the date, where you keep evidence (B7a's report). It also says whether the certificate names the address the services connect to; if it does not, stop and read the database row of the [first-apply questions](civo/README.md#what-the-first-apply-must-confirm).

**6. The rest of the infrastructure**: the namespaces, the platform chart (Traefik, cert-manager), the deployer, the Cloudflare records, settings and rules.

```sh
bun run setup first-apply --environment staging --resume
```

Then **prove the state lock**: run `terraform -chdir=infra/civo/envs/staging plan` in two shells at once. The second must stop with `Error acquiring the state lock`.

**7. The secrets file.** Generates ID's secrets, copies Terraform's database administrator URL and the cert-manager token, encrypts them to `infra/civo/envs/staging/secrets.enc.yaml` and checks the round trip.

```sh
bun run setup init-secrets --environment staging
```

**8. The GitHub environments.** Creates `staging` and `infra-staging` with their secrets and sets the repository variable `DEPLOY_STAGING=true` ([what each holds](pipeline/README.md#what-each-github-environment-holds)).

```sh
bun run setup publish-env --environment staging --enable
```

**9. Commit the four files and push.** Only values are encrypted, so a review shows which Secret and key changed:

```sh
grep -c 'ENC\[' infra/civo/envs/staging/secrets.enc.yaml   # one per value; zero means stop
git add .sops.yaml infra/civo/envs/staging/edge-ca/ca.pem infra/civo/envs/staging/database-ca.pem infra/civo/envs/staging/secrets.enc.yaml
git commit -m "Set up the staging environment"
git push origin main
gh run watch
```

The push runs CI, applies staging's Terraform (nothing to change), builds and signs the four images, deploys and smoke-tests ([how a deploy runs](pipeline/README.md#how-a-deploy-runs)).

**Nobody registers the MCPs by hand on the first run.** This first deploy finds that `toolbox-id-client` and `admin-id-client` do not exist, so it runs `ops-register` in the same upgrade, with the root secret, before anyone is a platform administrator: the Toolbox and the admin MCP are registered in ID and start by themselves. [Register again](#register-again), with a staff token, is only for later, after root has locked.

**10. Make the images public.** New GHCR packages are private, and the cluster pulls without credentials. If the deploy failed on pulling an image, open each of the four packages (`answerable/id`, `answerable/toolbox`, `answerable/admin-mcp`, `answerable/ops`) on GitHub under your profile's Packages, choose Package settings > Change visibility > Public, then rerun the failed jobs:

```sh
gh run list --workflow deploy-staging.yml --limit 1
gh run rerun <run id> --failed
```

**11. Pin the cluster version** ([step 8 of the first apply](civo/README.md#first-apply)): read it with `civo kubernetes show answerable-staging-cluster`, set `kubernetes_version` in `infra/civo/envs/staging/terraform.tfvars`, and push.

**12. ID's first run**: the staff domain, the Entra provider on Answerable's platform application, and a connectivity test, with the root secret decrypted in memory.

```sh
bun run setup id-first-run --environment staging --domain answerable.org --entra-tenant <staff directory tenant ID>
```

**13. Sign in once** at `https://id.answerable-staging.uk/login` with your work account. That creates your user and your platform membership.

**14. Make yourself a platform administrator.** Root locks itself; the command confirms ID now refuses it (`403 root_locked`).

```sh
bun run setup id-make-admin --environment staging --email <you>@answerable.org
```

**15. Make yourself an owner on the admin MCP.** Get a staff token as [Get a staff token](../apps/web/content/docs/id/onboard.mdx#get-a-staff-token) describes, with `id.answerable-staging.uk` in place of `id.answerable.org`, and set `TOKEN` to it. Then put your membership in the group `answerable-owner` that `ops-register` created:

```sh
ID=https://id.answerable-staging.uk
ORG=$(curl -s "$ID/api/admin/v1/organizations?q=answerable&limit=100" -H "Authorization: Bearer $TOKEN" | jq -r '.items[] | select(.slug=="answerable") | .id')
GROUP=$(curl -s "$ID/api/admin/v1/organizations/$ORG/groups?q=answerable-owner&limit=100" -H "Authorization: Bearer $TOKEN" | jq -r '.items[] | select(.slug=="answerable-owner") | .id')
MEMBER=$(curl -s --get "$ID/api/admin/v1/organizations/$ORG/members" -H "Authorization: Bearer $TOKEN" --data-urlencode "email=<you>@answerable.org" | jq -r '.items[0].id')
curl -X PUT "$ID/api/admin/v1/organizations/$ORG/groups/$GROUP/members/$MEMBER" \
  -H "Idempotency-Key: admin-first-owner-v1" -H "If-None-Match: *" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

**16. Connect Claude Code** ([the admin MCP's setup](../apps/web/content/docs/admin/setup.mdx#connect-claude-code)):

```sh
claude mcp add --transport http answerable-admin https://admin-mcp.answerable-staging.uk/mcp --client-id claude-code-admin --callback-port 47700
claude mcp add --transport http answerable-toolbox https://toolbox.answerable-staging.uk/mcp --client-id claude-code-toolbox --callback-port 47700
```

In Claude Code, run `/mcp`, choose `answerable-admin`, **Authenticate** and sign in with your work account; ask Claude to call `admin_whoami`, which answers `owner`. These are the commands `ops-register` prints in its log.

**Production differs in four places.** `ALLOWED_API_CIDRS` is required and must include this machine. `publish-env` runs without `--enable` and creates one environment, `production`, which holds every secret and needs your approval. Production's first deploy is `promote-production.yml`, which GitHub cannot run until D30's follow-up opens a path to production's API ([Known limits](#known-limits)); it is the B7c rehearsal. And the Entra redirect URIs are production's.

## Every deploy

A push to `main` deploys staging when `DEPLOY_STAGING` is `true`:

```sh
git push origin main
gh run watch
```

| Stage | What to look at |
| --- | --- |
| CI | The same checks as a pull request |
| `Apply the staging infrastructure` | `terraform apply` of `infra/civo/envs/staging`; a no-op unless Terraform or `charts/platform` changed |
| `Build …`, `Publish …` | Eight builds (four images, two architectures), four signed manifest lists tagged `sha-<commit>` |
| `Deploy to staging` | The Secrets applied, `helm upgrade` with every hook; on failure the release rolls back and the migration and ops Jobs' logs are printed |
| `Smoke test staging` | A table of every check, in the run's summary |

- **A Terraform change** gets a plan as a comment on its pull request (`infra.yml`); read it before merging, because the merge applies it to staging.
- **A migration** must be expand, then contract: the previous image keeps serving during the rollout and after a rollback ([`docs/12`](../docs/12-deployment.md#images-and-deploys)).
- **Which tag staging runs:** the deploy job's summary says it, or `helm get values answerable -n answerable -o json | jq -r .image.tag` with a [kubeconfig](#get-a-kubeconfig).
- **Turn deploys off** without touching CI: `gh variable delete DEPLOY_STAGING`.

## Promote to production

```sh
gh workflow run promote-production.yml --ref main -f image_tag=staging -f apply_infra=true
gh run watch
```

The run reads the tag staging runs, verifies the four images' signatures, then waits for your approval (Actions > the run > Review deployments). After approval it applies production's Terraform, deploys exactly the verified digests and smoke-tests production.

**Not yet usable:** production's Kubernetes API admits only `ALLOWED_API_CIDRS`, so GitHub's runners cannot reach it, and the run fails at the apply or the deploy. It waits for D30's follow-up ([Known limits](#known-limits)).

## Roll back

| What | How |
| --- | --- |
| Staging, to an earlier image | `gh workflow run deploy-staging.yml --ref main -f image_tag=sha-<40-character commit SHA>`; nothing is built |
| Production, to an earlier image | `gh workflow run promote-production.yml --ref main -f image_tag=sha-<commit SHA> -f apply_infra=false` |
| Straight to the previous release (chart, values and image together) | With a [kubeconfig](#get-a-kubeconfig): `helm history answerable -n answerable`, then `helm rollback answerable <revision> -n answerable --wait` |

Earlier tags are the commits of successful runs: `gh run list --workflow deploy-staging.yml --status success`, then `sha-` and the full SHA (`git rev-parse <commit>`). A migration is never rolled back: the earlier image runs on the newer schema. A change that broke that rule needs a [restore](#restore).

## Scale

| What | Where | Then |
| --- | --- | --- |
| Replicas | `autoscaling.minReplicas` and `maxReplicas` per server in `charts/answerable/values-civo-<environment>.yaml` | Push (staging), promote (production) |
| Nodes | `node_count` (and `node_size`) in `infra/civo/envs/<environment>/terraform.tfvars` | Pull request: read the plan; merge applies staging |
| The database | `database_size`, `database_nodes` in the same file | Read the plan first: if it says the database **must be replaced**, stop. Replacing it loses the data, and `prevent_destroy` refuses it. Whether Civo resizes in place, and for how long it stops, is undocumented |

Before raising a ceiling, check the connections: each ID replica opens up to 20, each MCP replica up to 10, and the total must stay below the database's `max_connections` with room for the Jobs ([`docs/12`](../docs/12-deployment.md#database)). Production's three nodes keep two replicas per service on different nodes while one node drains.

## Rotate

After any change to `secrets.enc.yaml`: commit and push. The deploy applies the Secrets; a push builds new images, so the pods restart and read the new values. A redeploy of the same tag does not restart them: run `kubectl -n answerable rollout restart deployment/<name>` with a [kubeconfig](#get-a-kubeconfig).

| Family | How |
| --- | --- |
| `ROOT_ADMIN_SECRET` | `bun run setup init-secrets --environment staging --rotate ROOT_ADMIN_SECRET`, push |
| `UPSTREAM_TOKEN_SECRETS` | `… --rotate UPSTREAM_TOKEN_SECRETS`, push. The new key goes first and the previous ones stay, so stored tokens stay readable |
| `BETTER_AUTH_SECRET` | Never replaced: it decrypts ID's stored signing keys. Rotate through the ring `BETTER_AUTH_SECRETS`, two deploys apart, as [ID's README](../apps/id/README.md#application-secret-rotation) describes. Edit the file in place with `SOPS_AGE_KEY_FILE=~/.config/sops/age/answerable-staging.txt sops edit infra/civo/envs/staging/secrets.enc.yaml`. Promotion signs every browser out |
| Microsoft or Google platform application | Create a new secret in the provider's console, export both of the pair, `… --rotate MICROSOFT_CLIENT_SECRET` (or `GOOGLE_CLIENT_SECRET`), push, then retire the old secret ([`docs/06`](../docs/06-deploying-answerable-id.md#operating-it)). The same command adds a pair later |
| cert-manager's Cloudflare token | New token, export `CERT_MANAGER_CLOUDFLARE_TOKEN`, `… --rotate api-token`, push, revoke the old token |
| The database administrator's URL | When Terraform's `database_admin_url` changes: `… --rotate OPS_DATABASE_ADMIN_URL`, push |
| A database login (six) | Empty its key, for example `kubectl -n answerable patch secret id-database --type merge -p '{"stringData":{"DATABASE_URL":""}}'`; redeploy the current tag (`ops-bootstrap` gives the login a new password and writes its URL); restart the service ([`infra/ops`](ops/README.md#bootstrap)) |
| A machine client (`toolbox-id-client`, `admin-id-client`) | Empty its key the same way, then [register again](#register-again); `register` rotates the secret in ID and restarts the two servers |
| The origin-pull certificate | `bun run setup origin-pull --environment staging --zone answerable-staging.uk --force`, which walks you through trusting both CAs, applying, uploading and deleting the old certificate ([details](setup/README.md#origin-pull---zone-zone)) |
| The deployer token | `terraform -chdir=infra/civo/envs/staging apply -replace=module.deployer.kubernetes_secret_v1.token`, then `terraform -chdir=infra/civo/envs/staging output -raw kube_token \| gh secret set KUBE_TOKEN --env staging` |
| `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN` | Regenerate in Civo's or Cloudflare's dashboard (for Civo, regeneration is the only control), then `gh secret set CIVO_TOKEN --env infra-staging` (it asks for the value); production's live on `production` |
| The `age` key | Move the old key file aside, `bun run setup age-init --environment staging --force` (a new key and rule), re-encrypt with the old key: `SOPS_AGE_KEY_FILE=<old key file> sops updatekeys infra/civo/envs/staging/secrets.enc.yaml`, push, then `grep '^AGE-SECRET-KEY' ~/.config/sops/age/answerable-staging.txt \| gh secret set SOPS_AGE_KEY --env staging`. Keep the old key while any backup needs the older files |

### Register again

Not part of the first run, which registers by itself. `register` must run again to rotate a machine client's secret or after a registration changes. Root is locked by then, so it needs a staff token ([Get a staff token](../apps/web/content/docs/id/onboard.mdx#get-a-staff-token)) in the Secret the Job reads. With a [kubeconfig](#get-a-kubeconfig):

```sh
printf 'Staff token: '; read -rs TOKEN; echo
kubectl -n answerable create secret generic ops-staff-token --from-literal=OPS_ID_TOKEN="$TOKEN"
gh workflow run ops.yml --ref main -f environment=staging -f command=register
gh run watch
kubectl -n answerable delete secret ops-staff-token
```

## Restore

### The database

**Not rehearsed yet.** Civo documents no backup schedule, retention or restore procedure; the drill in B7a records what Civo actually does and rewrites this section. What the `civo` CLI offers (version 1.5.5, `civo database restore --help`):

```sh
civo database backup ls answerable-staging-database
civo database backup create answerable-staging-database --name <name> --type manual
civo database restore answerable-staging-database --name <restore name> --backup <backup name>
```

After any restore, before traffic:

1. **Redeploy the current tag**, so that `ops-bootstrap` sets every login's password back to the one its Secret holds.
2. **Run ID's custody preflight**, which decrypts every stored signing key and upstream token with the deployed secrets: `kubectl -n answerable exec deploy/id -- bun apps/id/scripts/operations-preflight.ts` must print `custody_preflight_passed`.
3. **Smoke-test**: `bun infra/pipeline/src/cli.ts smoke --environment staging`.

A restored database needs the keys that were active when its rows were written. `init-secrets --rotate` keeps earlier upstream keys in the ring and `BETTER_AUTH_SECRET` is never replaced, so the current file reads an older backup unless a version was removed; a removed version is in the file's Git history, readable with the same `age` key.

### OpenBao

Not yet: it arrives with B7b ([D29](../docs/goals/aws-deploy/decisions.md)).

## Break glass

### Get a kubeconfig

The cluster's admin kubeconfig is the sensitive Terraform output `admin_kubeconfig`. Use it for diagnostics and recovery only, keep it out of the repository, and delete it afterwards:

```sh
terraform -chdir=infra/civo/envs/staging init -input=false     # once per machine, with AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY set
mkdir -p ~/.kube
(umask 077; terraform -chdir=infra/civo/envs/staging output -raw admin_kubeconfig > ~/.kube/answerable-staging-admin)
export KUBECONFIG=~/.kube/answerable-staging-admin
kubectl -n answerable get pods
```

`civo kubernetes config answerable-staging-cluster` prints the same with the Civo API key. Production's API answers only the addresses in `ALLOWED_API_CIDRS`.

Useful reads: `kubectl -n answerable logs deploy/id`, `kubectl -n answerable logs job/ops-register` (kept a day), `kubectl -n answerable get events --sort-by=.lastTimestamp`, `helm history answerable -n answerable`.

### No platform administrator left

When nobody can administer ID ([`onboard.mdx`](../apps/web/content/docs/id/onboard.mdx#first-run), step 7):

1. Add `ROOT_ADMIN_BREAK_GLASS: "true"` under `id.env` in `charts/answerable/values-civo-staging.yaml`, and deploy (push; for production, promote).
2. Repair access with the root secret. Read it into your shell without printing it: `ROOT=$(kubectl -n answerable get secret id-env -o jsonpath='{.data.ROOT_ADMIN_SECRET}' | base64 --decode)`, then follow [`docs/06`](../docs/06-deploying-answerable-id.md#install-in-order) step 7 against the environment's host.
3. Remove the line and deploy again. Every use of the root secret is in the audit log as `admin.root_request`.

### A lost `age` key

The secrets file cannot be decrypted, and neither can its history. GitHub keeps `SOPS_AGE_KEY` but never shows it. Generate a new key (`age-init --force`), and a new file with `init-secrets --force` only if ID has no data yet: a new `BETTER_AUTH_SECRET` makes the stored signing keys unreadable. With data, the running cluster still holds `id-env`, `postgres-admin` and `cloudflare-api-token`: with a [kubeconfig](#get-a-kubeconfig), rebuild the file from their values, encrypted to the new key (`sops encrypt`), before anything replaces them.

## Destroy an environment

Not rehearsed yet; B7c destroys a production rehearsal and corrects this section.

1. Stop deploys (staging): `gh variable delete DEPLOY_STAGING`.
2. A reviewed change removes `prevent_destroy` from `infra/civo/modules/database` and `infra/civo/modules/state` (both roots use them; put it back afterwards).
3. Move the state out of the bucket the destroy deletes, then destroy:

   ```sh
   cd infra/civo/envs/staging
   printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf
   terraform init -migrate-state
   terraform destroy
   rm backend_override.tf terraform.tfstate terraform.tfstate.backup
   cd -
   ```

4. Delete the zone's origin-pull certificate (the `curl` that `origin-pull` printed, or the zone's SSL/TLS > Origin Server page) and the GitHub environments (Settings > Environments).
5. Keep the `age` key and the secrets file for as long as any backup of that environment exists.

## Cost levers

| Lever | Saves | Costs |
| --- | --- | --- |
| Staging on two Small nodes instead of Medium | About $21 a month | Less room for the platform pods ([`docs/12`](../docs/12-deployment.md#cost)) |
| Production's database on one node instead of three | About $173 a month | Fault tolerance |
| Lower autoscaling ceilings | Node headroom | Burst capacity |
| Destroy staging when unused | About $103 a month | A first run to bring it back; `DEPLOY_STAGING` off alone saves nothing |
| Decide audit and evidence retention (`Q-EVIDENCE-RETENTION`) | The next database size, about three months into real use | A product decision |

## Run the checks

```sh
bun run infra:check   # charts, Terraform, workflows; no cloud, no Docker
bun run infra:test    # the kind stack; Docker; about four minutes
```

What each proves: [`docs/12`](../docs/12-deployment.md#testing). On macOS, a Terraform provider killed on start (exit 137) is a rewritten plugin cache: [`infra/civo/README.md`](civo/README.md#checks). CI's `infra-check` job is the arbiter.

## Known limits

- **D30: the Kubernetes API.** Staging's is open to the internet, authenticated by the cluster alone; production's admits only `ALLOWED_API_CIDRS`, so GitHub cannot deploy production or apply its Terraform. The follow-up, a GitOps controller pulling from inside the cluster or a Cloudflare tunnel in front of the API, is the owner's to pick ([`infra/civo/README.md`](civo/README.md#who-can-reach-the-kubernetes-api)).
- **Production's Terraform runs from your machine until then.** The first apply always does, through `first-apply`; later applies would go through `promote-production.yml` once GitHub can reach the API.
- **Terraform state holds secrets.** Civo's provider keeps the database administrator's password and the cluster's admin kubeconfig in state, beside the deployer's token. The state bucket's credential is as sensitive as `CIVO_TOKEN`.
- **The `civo` provider and macOS.** A provider binary rewritten in a shared plugin cache is killed on start; `infra:check` keeps a cache per checkout ([details](civo/README.md#checks)).
- **The database admits the private network**, not the nodes alone: Civo firewalls match ranges, and nothing else may join the network ([`modules/database`](civo/modules/database/README.md)).
- **Civo's gaps:** no documented etcd encryption, no audit log of API calls, unscoped API keys, a database in beta with undocumented backups. Each is mitigated as [`docs/12`](../docs/12-deployment.md) says, not closed.
- **New GHCR packages are private** and have no API to change that: set them public once, after the first build.
- **Traefik's CRDs** are installed by Helm on the first install only. A later Traefik upgrade applies its CRDs first (for example with the `traefik-crds` chart).
- **The ops Jobs reach the Kubernetes API at any address on 6443** until the overlay carries the cluster's API endpoint.
- **Let's Encrypt through DNS-01 is proved only by rendering**; the first staging certificate is its real test. If it stays pending, read `kubectl -n platform logs deploy/platform-cert-manager` and the Cloudflare token's permissions.
