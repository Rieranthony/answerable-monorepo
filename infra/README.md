# Infrastructure runbook

How to set up, ship, roll back, scale, rotate, restore and destroy Answerable's environments on Civo, from GitHub. Why each piece exists, and what runs where: [`docs/12-deployment.md`](../docs/12-deployment.md).

**Status.** Built and proved locally; not yet applied to a Civo account. The first staging run is brief [B7a](../docs/goals/civo-deploy/briefs/b7.md), which runs this page for the first time and corrects it.

**Conventions.** Nothing here is run from a laptop except `git tag`, `gh run watch` and the browser. Every secret lives in a GitHub environment or is generated where it is used; no command on this page prints one. Staging is shown; production is the same with `production`, the zone `answerable.org` and the owner's approval on each run.

## Where the details live

| Page | Owns |
| --- | --- |
| [`infra/civo/README.md`](civo/README.md) | The Terraform root and modules, `terraform.sh`, the credentials, the first apply's questions, day two |
| [`infra/pipeline/README.md`](pipeline/README.md) | The workflows, what the GitHub environment holds, running the scripts by hand |
| [`infra/ops/README.md`](ops/README.md) | The `bootstrap`, `register` and `make-admin` Jobs |
| [`infra/k8s/local/README.md`](k8s/local/README.md) | The kind stack (`bun run infra:test`) |
| [`charts/answerable/README.md`](../charts/answerable/README.md), [`charts/platform/README.md`](../charts/platform/README.md) | The charts' values and what they expect |

## Prerequisites

### Accounts, once per environment

1. **Civo** ([D28](../docs/goals/civo-deploy/decisions.md)). One Civo organisation with two accounts, `answerable-staging` and `answerable-production`, region LON1. You are in each account's Owners team with MFA on your login. Each account's API key ([Civo's page](https://www.civo.com/docs/account/api-keys)) is that environment's `CIVO_TOKEN`.
2. **Cloudflare.** The zone (`answerable-staging.uk` for staging, `answerable.org` for production) and **one API token scoped to that zone only**, `CLOUDFLARE_API_TOKEN`: Zone > Zone > Read, Zone > DNS > Edit, Zone > SSL and Certificates > Edit, Zone > Zone Settings > Edit, Zone > Config Rules > Edit, Zone > Cache Rules > Edit ([the list and why](civo/README.md#credentials)). **Bot Fight Mode off** in the zone's Security settings: no token can change it, and it would challenge every MCP host.
3. **Microsoft Entra.** The environment's app registration, with the redirect URIs `https://id.answerable-staging.uk/auth/sso/callback` and `https://id.answerable-staging.uk/login` for staging, or production's in [`docs/06`](../docs/06-deploying-answerable-id.md#platform-applications-microsoft-entra-and-google). Its client ID and secret are `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. You also need the **tenant ID of Answerable's own staff directory**. A Google client is optional (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
4. **GitHub.** A fine-grained personal access token for `Rieranthony/answerable-monorepo` alone, with read and write on **Environments** and **Secrets** (Actions), `GH_SECRETS_TOKEN`; put its expiry in your calendar. The bootstrap workflow writes secrets with it and Terraform sets the environment's policies and deploy secrets with it.

### Tools on your machine

`git` and `gh` (`brew install gh`, `gh auth login`). For the checks: Helm 4.3.0, `kubeconform` 0.8.0, Terraform 1.16.5, `tflint` 0.64.0, `trivy` 0.75.0, `actionlint` 1.7.12 (`bun run infra:check`); Docker, `kind` 0.33.0, `kubectl` and Playwright's Chromium (`bun run infra:test`). The versions CI pins are in [`.github/actions/setup-tools/action.yml`](../.github/actions/setup-tools/action.yml). For break-glass only: `kubectl` and the `civo` CLI.

## First run

About an hour, most of it Civo creating the cluster and the database. Each step's errors name what to fix.

**1. The GitHub environment.** In the repository's Settings > Environments, create `staging` with **no deployment-branch restriction** (Terraform restricts it to `main` and `staging/*` on the first apply) and paste the five secrets: `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `GH_SECRETS_TOKEN`. Add the Google pair if you have one. For production also add yourself as the required reviewer, which Terraform keeps.

**2. The staff directory.** In `charts/answerable/values-civo-staging.yaml`, set `id.staffDomain` to the staff email domain (`answerable.org`) and `id.entraTenant` to the staff directory's tenant ID; commit and push. Neither is a secret: the register Job uses them to connect your directory to the platform organisation on the first deploy.

**3. Bootstrap.** Run the **Bootstrap an environment** workflow for `staging` (Actions > Bootstrap an environment > Run workflow). It creates the state bucket and its credential in the Civo account and writes into the environment the credential and ID's three random secrets, each only when missing. Its summary says what it wrote; the values appear nowhere.

```sh
gh workflow run bootstrap.yml --ref main -f environment=staging
gh run watch
```

**4. The first tag.** A tag `staging/<name>` on a commit of `main` ships it ([how a ship runs](pipeline/README.md#how-a-ship-runs)): CI, the staging infrastructure (the first apply creates the cluster, the database and the certificates, and writes the deploy credentials into the environment), the four images built and signed, the deploy, the smoke test.

```sh
git tag staging/first main
git push origin staging/first
gh run watch
```

In the deploy, `ops-bootstrap` records the database's certificate (its log names the SHA-256 fingerprint: record it with the date), creates the three databases and their six logins, then the migrations run and ID starts. The first deploy finds that the MCPs' client Secrets do not exist, so it runs `ops-register` in the same upgrade, with the root secret, before anyone is a platform administrator: the Toolbox and the admin MCP are registered in ID and start by themselves, and the staff domain and the Entra provider are put on the platform organisation.

**5. Make the images public.** New GHCR packages are private, and the cluster pulls without credentials. If the deploy failed on pulling an image, open each of the four packages (`answerable/id`, `answerable/toolbox`, `answerable/admin-mcp`, `answerable/ops`) on GitHub under your profile's Packages, choose Package settings > Change visibility > Public, then rerun the failed jobs:

```sh
gh run list --workflow deploy-staging.yml --limit 1
gh run rerun <run id> --failed
```

**6. Sign in once** at `https://id.answerable-staging.uk/login` with your work account. That creates your user and your platform membership.

**7. Make yourself the administrator.** Run the **Ops** workflow with `staging`, `make-admin` and your email. With the root secret, the Job puts you in `answerable-owner`, the admin MCP's owner role, then in `platform-admins`. That second step locks root, which is why the owner role comes first; the Job confirms ID now refuses the root secret.

```sh
gh workflow run ops.yml --ref main -f environment=staging -f command=make-admin -f email=<you>@answerable.org
gh run watch
```

**8. Connect Claude Code** ([the admin MCP's setup](../apps/web/content/docs/admin/setup.mdx#connect-claude-code)):

```sh
claude mcp add --transport http answerable-admin https://admin-mcp.answerable-staging.uk/mcp --client-id claude-code-admin --callback-port 47700
claude mcp add --transport http answerable-toolbox https://toolbox.answerable-staging.uk/mcp --client-id claude-code-toolbox --callback-port 47700
```

In Claude Code, run `/mcp`, choose `answerable-admin`, **Authenticate** and sign in with your work account; ask Claude to call `admin_whoami`, which answers `owner`. These are the commands `ops-register` prints in its log.

**Production differs in three places.** The environment is `production`, with you as its required reviewer; its first ship is a tag `production/<name>` on a commit staging has shipped, and the run waits for your approval; the Entra redirect URIs are production's.

## Every ship

A tag `staging/<name>` on a commit of `main` ships it to staging:

```sh
git tag staging/<name> main
git push origin staging/<name>
gh run watch
```

| Stage | What to look at |
| --- | --- |
| `The tag names a commit of main` | Refuses a tag on any other commit |
| CI | The same checks as every push |
| `Apply the staging infrastructure` | `terraform apply` of `infra/civo` for staging; a no-op unless Terraform, `charts/platform` or Cloudflare's published ranges changed |
| `Build …` | Four amd64 images, pushed as `sha-<commit>` and signed |
| `Deploy to staging` | The Secret `id-env` applied from the environment, `helm upgrade` by digest with every hook; on failure the release rolls back and the migration and ops Jobs' logs are printed |
| `Smoke test staging` | A table of every check, in the run's summary |

- **A Terraform change** applies on the next staging tag. Read `terraform plan` locally first when the change is more than a size (`infra/civo/terraform.sh staging plan`, [day two](civo/README.md#day-two)).
- **A migration** must be expand, then contract: the previous image keeps serving during the rollout and after a rollback ([`docs/12`](../docs/12-deployment.md#images-and-deploys)).
- **Which commit staging runs:** the deploy job's summary says it, as does `gh run list --workflow deploy-staging.yml --status success`.

## Promote to production

A tag `production/<name>` on a commit staging has shipped:

```sh
git tag production/<name> <commit>
git push origin production/<name>
gh run watch
```

The run verifies the four images' signatures (they must have been built by `deploy-staging.yml` on a staging tag), then waits for your approval (Actions > the run > Review deployments). After approval it applies production's Terraform, deploys exactly the verified digests and smoke-tests production. A commit staging never shipped is refused.

## Roll back

| What | How |
| --- | --- |
| Staging, to an earlier commit | Tag it again: `git tag staging/back-<name> <commit>` and push. Nothing new is built; the images exist |
| Production, to an earlier commit | `git tag production/back-<name> <commit>` and push; the commit must have shipped to staging |
| Straight to the previous release (chart, values and image together) | With a [kubeconfig](#get-a-kubeconfig): `helm history answerable -n answerable`, then `helm rollback answerable <revision> -n answerable --wait` |

A migration is never rolled back: the earlier image runs on the newer schema. A change that broke that rule needs a [restore](#restore).

## Scale

| What | Where | Then |
| --- | --- | --- |
| Replicas | `autoscaling.minReplicas` and `maxReplicas` per server in `charts/answerable/values-civo-<environment>.yaml` | Tag |
| Nodes | `node_count` (and `node_size`) in `infra/civo/envs/<environment>.tfvars` | Tag; the apply runs first |
| The database | `database_size`, `database_nodes` in the same file | `terraform plan` first: if it says the database **must be replaced**, stop. Replacing it loses the data, and `prevent_destroy` refuses it. Whether Civo resizes in place, and for how long it stops, is undocumented |

Before raising a ceiling, check the connections: each ID replica opens up to 20, each MCP replica up to 10, and the total must stay below the database's `max_connections` with room for the Jobs ([`docs/12`](../docs/12-deployment.md#database)).

## Rotate

A changed secret in the environment reaches the cluster on the next tag: the deploy applies `id-env` with a checksum that rolls ID.

| Family | How |
| --- | --- |
| `ROOT_ADMIN_SECRET` | The Bootstrap workflow with `rotate: ROOT_ADMIN_SECRET`, then a tag |
| `UPSTREAM_TOKEN_SECRETS` | The Bootstrap workflow with `rotate: UPSTREAM_TOKEN_SECRETS`, then a tag. The new key goes first and the previous ones stay, so stored tokens stay readable |
| `BETTER_AUTH_SECRET` | Never replaced: it decrypts ID's stored signing keys. Rotate through the ring `BETTER_AUTH_SECRETS`, two ships apart, as [ID's README](../apps/id/README.md#application-secret-rotation) describes: set the environment secret `BETTER_AUTH_SECRETS`, which the deploy passes through. Promotion signs every browser out |
| Microsoft or Google platform application | Create a new secret in the provider's console, set both of the pair in the environment (`gh secret set MICROSOFT_CLIENT_SECRET --env staging`, which asks for the value), tag, then retire the old secret ([`docs/06`](../docs/06-deploying-answerable-id.md#operating-it)) |
| A database login (six) | Empty its key, for example `kubectl -n answerable patch secret id-database --type merge -p '{"stringData":{"DATABASE_URL":""}}'` with a [kubeconfig](#get-a-kubeconfig); tag (`ops-bootstrap` gives the login a new password and writes its URL); the service restarts with the deploy ([`infra/ops`](ops/README.md#bootstrap)) |
| A machine client (`toolbox-id-client`, `admin-id-client`) | Empty its key the same way, then [register again](#register-again); `register` rotates the secret in ID and restarts the two servers |
| The origin certificate or the origin-pull certificate | A reviewed change adds `-replace` for the key to the apply once, or run it from a trusted machine: `infra/civo/terraform.sh staging apply -replace=module.edge.tls_private_key.<name>`; both switch within one apply, with a short interruption ([`infra/civo/README.md`](civo/README.md#certificates)) |
| The deployer token | `infra/civo/terraform.sh staging apply -replace=module.deployer.kubernetes_secret_v1.token` from a trusted machine; Terraform writes the new `KUBE_TOKEN` into the environment |
| `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GH_SECRETS_TOKEN` | Regenerate in the vendor's console (for Civo, regeneration is the only control), then `gh secret set <name> --env staging` (it asks for the value) |
| `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY` | Delete both from the environment, then the Bootstrap workflow writes a new credential's pair; delete the old credential in Civo's dashboard |

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

1. **Tag the current commit again**, so that `ops-bootstrap` sets every login's password back to the one its Secret holds.
2. **Run ID's custody preflight**, which decrypts every stored signing key and upstream token with the deployed secrets: `kubectl -n answerable exec deploy/id -- bun apps/id/scripts/operations-preflight.ts` must print `custody_preflight_passed`.
3. **Smoke-test**: `bun infra/pipeline/src/cli.ts smoke --environment staging`.

A restored database needs the keys that were active when its rows were written. Rotation keeps earlier upstream keys in the ring and `BETTER_AUTH_SECRET` is never replaced, so the environment's secrets read an older backup.

## Break glass

### Get a kubeconfig

The cluster's admin kubeconfig is the sensitive Terraform output `admin_kubeconfig`, or Civo's: `civo kubernetes config answerable-staging-cluster` with the account's API key. Use it for diagnostics and recovery only, keep it out of the repository, and delete it afterwards:

```sh
export STATE_ACCESS_KEY_ID=… STATE_SECRET_ACCESS_KEY=…     # the environment's, from Civo's dashboard: Object stores > Credentials
infra/civo/terraform.sh staging init -input=false
mkdir -p ~/.kube
(umask 077; infra/civo/terraform.sh staging output -raw admin_kubeconfig > ~/.kube/answerable-staging-admin)
export KUBECONFIG=~/.kube/answerable-staging-admin
kubectl -n answerable get pods
```

Useful reads: `kubectl -n answerable logs deploy/id`, `kubectl -n answerable logs job/ops-register` (kept a day), `kubectl -n answerable get events --sort-by=.lastTimestamp`, `helm history answerable -n answerable`.

### No platform administrator left

When nobody can administer ID ([`onboard.mdx`](../apps/web/content/docs/id/onboard.mdx#first-run), step 7):

1. Add `ROOT_ADMIN_BREAK_GLASS: "true"` under `id.env` in `charts/answerable/values-civo-staging.yaml`, and tag (for production, tag and approve).
2. Repair access with the root secret. Read it into your shell without printing it: `ROOT=$(kubectl -n answerable get secret id-env -o jsonpath='{.data.ROOT_ADMIN_SECRET}' | base64 --decode)`, then follow [`docs/06`](../docs/06-deploying-answerable-id.md#install-in-order) step 7 against the environment's host.
3. Remove the line and tag again. Every use of the root secret is in the audit log as `admin.root_request`.

## Destroy an environment

Not rehearsed yet; B7c destroys a production rehearsal and corrects this section.

1. A reviewed change removes `prevent_destroy` from `infra/civo/modules/database` (put it back afterwards).
2. From a trusted machine with the environment's `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `STATE_*` and `GH_SECRETS_TOKEN` as `GITHUB_TOKEN` exported: `infra/civo/terraform.sh staging init -input=false && infra/civo/terraform.sh staging destroy`.
3. Delete the state bucket and its credential in Civo's dashboard, and the GitHub environment (Settings > Environments).

## Cost levers

| Lever | Saves | Costs |
| --- | --- | --- |
| Staging on two Small nodes instead of Medium | About $21 a month | Less room for the platform pods ([`docs/12`](../docs/12-deployment.md#cost)) |
| Lower autoscaling ceilings | Node headroom | Burst capacity |
| Destroy staging when unused | About $103 a month | A first run to bring it back |
| Decide audit and evidence retention (`Q-EVIDENCE-RETENTION`) | The next database size, about five months into real use | A product decision |

## Run the checks

```sh
bun run infra:check   # charts, Terraform, workflows; no cloud, no Docker
bun run infra:test    # the kind stack; Docker; about four minutes
```

What each proves: [`docs/12`](../docs/12-deployment.md#testing). On macOS, a Terraform provider killed on start (exit 137) is a rewritten plugin cache: [`infra/civo/README.md`](civo/README.md#checks). CI's `infra-check` job is the arbiter.

## Known limits

- **Write access to `main` is access to every secret** of the `main`-scoped environments: a workflow on `main` can use them. Only the owner pushes to `main`; agents push branches, which get CI and no secret; every action is pinned by commit.
- **A changed secret has no reviewable history.** GitHub shows when a secret changed, not what; `sops` in git showed which key.
- **Terraform state holds secrets.** Civo's provider keeps the database administrator's password and the cluster's admin kubeconfig in state; the state also holds the deployer's token, the two private keys of the certificates and the plaintext of the three deploy secrets Terraform writes into the environment. The state bucket's credential is as sensitive as `CIVO_TOKEN`.
- **Civo's gaps:** no documented etcd encryption, no audit log of API calls, unscoped API keys, a database in beta with undocumented backups and no documented TLS. Each is mitigated as [`docs/12`](../docs/12-deployment.md) says, not closed.
- **The Kubernetes API is reachable from the internet**, authenticated by the cluster ([D30](../docs/goals/civo-deploy/decisions.md)). A GitOps controller pulling from inside the cluster is the hardening if it is ever wanted.
- **New GHCR packages are private** and have no API to change that: set them public once, after the first build.
- **Traefik's CRDs** are installed by Helm on the first install only. A later Traefik upgrade applies its CRDs first (for example with the `traefik-crds` chart).
- **The database admits the private network**, not the nodes alone: Civo firewalls match ranges, and nothing else may join the network ([`modules/database`](civo/modules/database/README.md)).
- **The `civo` provider and macOS.** A provider binary rewritten in a shared plugin cache is killed on start; `infra:check` keeps a cache per checkout ([details](civo/README.md#checks)).
