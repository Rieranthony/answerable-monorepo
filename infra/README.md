# Infrastructure runbook

How to set up, ship, roll back, scale, rotate, restore and destroy Answerable's environments on Civo, from GitHub. Why each piece exists, and what runs where: [`docs/12-deployment.md`](../docs/12-deployment.md).

**Status.** Built and proved locally. Staging has run on Civo (`staging/fourth`, 2026-10-23: [`reports/staging-evidence.md`](../reports/staging-evidence.md)); production has not. Brief [B7a](../docs/goals/civo-deploy/briefs/b7.md) runs this page and corrects it.

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
4. **GitHub.** A fine-grained personal access token for `Rieranthony/answerable-monorepo` alone, with read and write on **Environments** and nothing else, `GH_SECRETS_TOKEN`; put its expiry in your calendar. The bootstrap workflow and Terraform write the environment's secrets with it. Not Administration: that permission would also let the token rename or delete the repository, which is why the environment's policy and reviewer are set by you, once, in step 1.

### Tools on your machine

`git` and `gh` (`brew install gh`, `gh auth login`). For the checks: Helm 4.3.0, `kubeconform` 0.8.0, Terraform 1.16.5, `tflint` 0.64.0, `trivy` 0.75.0, `actionlint` 1.7.12 (`bun run infra:check`); Docker, `kind` 0.33.0, `kubectl` and Playwright's Chromium (`bun run infra:test`). The versions CI pins are in [`.github/actions/setup-tools/action.yml`](../.github/actions/setup-tools/action.yml). For break-glass only: `kubectl` and the `civo` CLI.

## First run

About an hour, most of it Civo creating the cluster and the database. Each step's errors name what to fix.

**1. The GitHub environment.** In the repository's Settings > Environments, create `staging`. Under **Deployment branches and tags** choose **Selected branches and tags** and add the branch `main` and the tag pattern `staging/*`, so that nothing else can use the environment. Paste the five secrets: `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `GH_SECRETS_TOKEN`. Add the Google pair if you have one. For production the tag pattern is `production/*` and you add yourself under **Required reviewers**.

**2. The staff directory.** In `charts/answerable/values-civo-staging.yaml`, set `id.staffDomain` to the staff email domain (`answerable.org`) and `id.entraTenant` to the staff directory's tenant ID; commit and push. Neither is a secret: the register Job uses them to connect your directory to the platform organisation on the first deploy.

**3. Bootstrap.** Run the **Bootstrap an environment** workflow for `staging` (Actions > Bootstrap an environment > Run workflow). It creates the state bucket and its credential in the Civo account and writes into the environment the credential and ID's three random secrets, each only when missing. Its summary says what it wrote; the values appear nowhere.

```sh
gh workflow run bootstrap.yml --ref main -f environment=staging
gh run watch
```

**4. The first tag.** A tag `staging/<name>` on a commit of `main` ships it ([how a deploy runs](pipeline/README.md#how-a-deploy-runs)): CI, the staging infrastructure (the first apply creates the cluster, the database and the certificates, and writes the deploy credentials into the environment), the images built and signed, the deploy, the smoke test.

```sh
git tag staging/first main
git push origin staging/first
gh run watch
```

In the deploy, `ops-bootstrap` records the database's certificate (its log names the SHA-256 fingerprint: record it with the date), creates the databases and their logins, and each MCP's schema and roles, then the migrations run and ID starts. Then `ops-register` runs, as it does on every deploy. This first time it holds only the root secret, before anyone is a platform administrator, so it first mints its own machine client, `ops-register`, and keeps its secret in the Secret `ops-id-client`; it goes on as that client. The Toolbox and the admin MCP are registered in ID, each `standalone` or `both` MCP is registered, the two servers start by themselves, and the staff domain and the Entra provider are put on the platform organisation.

**5. Make the images public.** New GHCR packages are private, and the cluster pulls without credentials. If the deploy failed on pulling an image, open each package of [`pipeline/images.json`](pipeline/images.json) (`answerable/id`, `answerable/mcps`, `answerable/ops`) on GitHub under your profile's Packages, choose Package settings > Change visibility > Public, then rerun the failed jobs:

```sh
gh run list --workflow deploy-staging.yml --limit 1
gh run rerun <run id> --failed
```

**6. Sign in once** at `https://id.answerable-staging.uk/login` with your work account. That creates your user and your platform membership.

**7. Make yourself the administrator.** Run the **Ops** workflow with `staging`, `make-admin` and your email. With the root secret, the Job puts you in `answerable-owner`, the admin MCP's owner role, then in `platform-admins`. That second step locks root, which is why the owner role comes first; the Job confirms ID now refuses the root secret. Nothing else needs root afterwards: every deploy's `ops-register` runs as its own client.

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
| `Build …` | One amd64 image per entry of `pipeline/images.json`, pushed as `sha-<commit>` and signed |
| `Deploy to staging` | The Secret `id-env` applied from the environment, `helm upgrade` by digest with every hook, `ops-register` among them; on failure the release rolls back and the migration and ops Jobs' logs are printed |
| `Smoke test staging` | A table of every check, in the run's summary: one line per standalone MCP, and the MCPs the Toolbox serves |

- **A Terraform change** applies on the next staging tag. Read `terraform plan` locally first when the change is more than a size (`infra/civo/terraform.sh staging plan`, [day two](civo/README.md#day-two)).
- **A migration** must be expand, then contract: the previous image keeps serving during the rollout and after a rollback ([`docs/12`](../docs/12-deployment.md#images-and-deploys)).
- **Which commit staging runs:** the deploy job's summary says it, as does `gh run list --workflow deploy-staging.yml --status success`.

### The first ship of the mcps image

Once per environment, the first tag of a commit that has the `mcps` image, the `mcp` hostname and `ops-register`:

1. **Terraform** adds the record `mcp.<zone>` and reissues the origin certificate for the four hostnames: the new certificate reaches `origin-tls` before the old one is revoked, so nothing stops. The plan shows the record, the certificate request and the certificate replaced.
2. **If the deploy failed pulling the `mcps` image**, the new package is private: make it public once, as in [First run](#first-run) step 5 (`answerable/mcps`), and rerun the failed jobs. Staging pulled the new `ops` package without that step ([`reports/staging-evidence.md`](../reports/staging-evidence.md#image-pulls)). The packages `answerable/toolbox` and `answerable/admin-mcp` are no longer built; delete them once production runs `mcps`.
3. **`ops-register` has no client of its own yet.** It is minted in this deploy, by whichever bearer the Job holds:
   - **Nobody has run `make-admin` in the environment yet:** the root secret mints it, as on a first run. Nothing to do.
   - **Root is locked already:** ID refuses the root secret, the Job stops with `register has no machine client of its own yet (the Secret ops-id-client is empty), and ID refuses the root secret (root_locked)`, and the release rolls back. So, before the tag, put a staff token in `ops-staff-token`, as in [Register again](#register-again); the Job mints `ops-register` with it and goes on as `ops-register`. Delete the Secret afterwards. This is the last time anyone places a token by hand.

### Ship an MCP

An MCP made with `bun mcp new` ships with its commit, by the same tags: nothing outside `mcps/<name>` needs a hand edit, and `bun mcp` has rewritten `charts/answerable/mcps.json` and the Toolbox's list. The `mcps` image holds it. On the staging tag the deploy:

1. **provisions it** (`ops-bootstrap`): a `shared` MCP gets schema `<name>` in `answerable_mcps` with its roles `mcp_<name>_owner` and `mcp_<name>`; an `own` MCP gets the database `answerable_mcp_<name>`, its two logins and their Secrets `mcp-<name>-database-owner` and `mcp-<name>-database`;
2. **migrates it** (`toolbox-migrate`, after the Toolbox's own database): its log names each MCP and the time the whole list took;
3. **serves it**: the Toolbox mounts a `toolbox` or `both` MCP in its hub, and serves a `standalone` or `both` MCP at `https://mcp.<zone>/<name>/mcp`;
4. **registers it** (`ops-register`): a `standalone` or `both` MCP gets its resource `https://mcp.<zone>/<name>/mcp` in ID, allowing its manifest's scopes and `offline_access`, its Claude Code client `claude-code-<name>` and their link;
5. **checks it** (`Smoke test staging`): a standalone MCP's metadata names its resource; the Toolbox's `/health` lists every MCP it serves.

What to check when a new MCP ships:

- `kubectl -n answerable logs job/toolbox-migrate` (kept until the next deploy): `<name>: migrating in answerable_mcps as mcp_<name>_owner`, and `Migrated N MCPs in … s`.
- The smoke table: `toolbox /health` names the MCPs it serves; `<name> resource metadata` passes for a standalone MCP.
- `kubectl -n answerable logs job/ops-register` (kept a day): `mcp-<name>-resource-v1: done`, `claude-code-<name>-v1: done` and the link the first time; afterwards the summary line counts it among what is as declared. A scope the manifest dropped is logged as its resource stops allowing it.
- Giving an organisation access is a staff decision, not part of shipping ([Your MCP's sign-in](../apps/web/content/docs/mcp/sign-in.mdx)). For an MCP in the Toolbox: `toolbox_enable` in the admin MCP ([the admin MCP](../apps/web/content/docs/admin/index.mdx)), then `access_grant` of its grant string, such as `<name>`. For an MCP on its own URL: `standalone_enable`, then `access_grant` of the MCP's scopes with `clientId` `claude-code-<name>`, or `everyone: true`.

Then tag `production/<name>` on the same commit. A failed migration fails the deploy and rolls the release back, as any migration does; each MCP migrates in one transaction, so the one that failed is left as it was, and those before it keep their migrations, which the previous image tolerates (expand, then contract).

An MCP removed from `mcps/` keeps its schema, roles, own database and Secrets, and its resource, client and link in ID: its name goes into `mcps/retired.json`, and removing what it left is Not yet automated.

## Promote to production

A tag `production/<name>` on a commit staging has shipped:

```sh
git tag production/<name> <commit>
git push origin production/<name>
gh run watch
```

The run verifies each image's signature (they must have been built by `deploy-staging.yml` on a staging tag), then waits for your approval (Actions > the run > Review deployments). After approval it applies production's Terraform, deploys exactly the verified digests and smoke-tests production. A commit staging never shipped is refused.

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

Before raising a ceiling, check the connections: each ID replica opens up to 20, the admin MCP's up to 10, the Toolbox's up to 20 and 10 more per `own` MCP, and the total must stay below the database's `max_connections` with room for the Jobs ([`docs/12`](../docs/12-deployment.md#database)). `scripts/mcp/connections.ts` holds the ceilings: change it with the overlay, or its test fails.

## Rotate

A changed secret in the environment reaches the cluster on the next tag: the deploy applies `id-env` with a checksum that rolls ID.

| Family | How |
| --- | --- |
| `ROOT_ADMIN_SECRET` | The Bootstrap workflow with `rotate: ROOT_ADMIN_SECRET`, then a tag |
| `BETTER_AUTH_SECRET` | Never replaced: it decrypts ID's stored signing keys. A new secret comes in through the ring `BETTER_AUTH_SECRETS`, two ships apart: [The application secret](#the-application-secret). The second ship signs every browser out |
| Microsoft or Google platform application | Create a new secret in the provider's console, set both of the pair in the environment (`gh secret set MICROSOFT_CLIENT_SECRET --env staging`, which asks for the value), tag, then retire the old secret ([`docs/06`](../docs/06-deploying-answerable-id.md#operating-it)) |
| A database login | Empty its key, for example `kubectl -n answerable patch secret id-database --type merge -p '{"stringData":{"DATABASE_URL":""}}'` with a [kubeconfig](#get-a-kubeconfig); tag (`ops-bootstrap` gives the login a new password and writes its URL); the service restarts with the deploy ([`infra/ops`](ops/README.md#bootstrap)) |
| A machine client (`toolbox-id-client`, `admin-id-client`) | Empty its key the same way, then [register again](#register-again); `register` rotates the secret in ID and restarts the servers |
| Register's own client (`ops-id-client`) | Empty its key, put a staff token in `ops-staff-token` and [register again](#register-again): `register` rotates its secret in ID with the token and stores it. Delete `ops-staff-token` afterwards |
| The origin certificate or the origin-pull certificate | Adding a hostname (as `mcp` was) reissues the origin certificate on the next apply by itself: a new one is issued and written to `origin-tls` before the old one is revoked. Otherwise, a reviewed change adds `-replace` for the key to the apply once, or run it from a trusted machine: `infra/civo/terraform.sh staging apply -replace=module.edge.tls_private_key.<name>`; both switch within one apply, with a short interruption ([`infra/civo/README.md`](civo/README.md#certificates)) |
| The deployer token | `infra/civo/terraform.sh staging apply -replace=module.deployer.kubernetes_secret_v1.token` from a trusted machine; Terraform writes the new `KUBE_TOKEN` into the environment |
| `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GH_SECRETS_TOKEN` | Regenerate in the vendor's console (for Civo, regeneration is the only control), then `gh secret set <name> --env staging` (it asks for the value) |
| `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY` | Delete both from the environment, then the Bootstrap workflow writes a new credential's pair; delete the old credential in Civo's dashboard |

### The application secret

The ring `BETTER_AUTH_SECRETS` lists `version:secret` pairs: the first signs and encrypts, every one decrypts ([ID's README](../apps/id/README.md#application-secret-rotation)). The deploy puts it in `id-env` when the environment has it, and leaves it out when it does not. `BETTER_AUTH_SECRET` stays as it is throughout.

1. **Read the current secret, make a new one.** The GitHub environment never shows a value, so read the current one from the cluster with a [kubeconfig](#get-a-kubeconfig), into your shell without printing it:

   ```sh
   CURRENT=$(kubectl -n answerable get secret id-env -o jsonpath='{.data.BETTER_AUTH_SECRET}' | base64 --decode)
   NEW=$(openssl rand -base64 48 | tr -d '\n')
   ```

2. **Stage.** Set the ring with the current secret first, then [ship](#every-ship). Every browser stays signed in.

   ```sh
   printf '1:%s,2:%s' "$CURRENT" "$NEW" | gh secret set BETTER_AUTH_SECRETS --env staging
   ```

3. **Promote,** once the smoke test of that ship has passed: every ID pod then holds the ring. Put the new secret first, then ship again. Every browser must sign in again; tokens already issued stay valid.

   ```sh
   printf '2:%s,1:%s' "$NEW" "$CURRENT" | gh secret set BETTER_AUTH_SECRETS --env staging
   unset CURRENT NEW
   ```

Delete the kubeconfig. Keep the ring in the environment with both versions: removing a version ID still needs stops signing. A later rotation starts from the ring (`{.data.BETTER_AUTH_SECRETS}`), adds version 3 last to stage and moves it first to promote, keeping every version.

### Register again

Every deploy runs `register` already, as its own client: a changed MCP list or manifest reaches ID on the next tag, with nothing to do. Run it by hand only to rotate a machine client's secret ([Rotate](#rotate)) without a deploy:

```sh
gh workflow run ops.yml --ref main -f environment=staging -f command=register
gh run watch
```

`register` reads each resource and client, changes with `If-Match` only what differs, and writes nothing when everything is as declared. Scopes only widen, so what `toolbox_enable` added to the Toolbox's resource stays; an MCP's own resource follows its manifest. An MCP removed from the list keeps its rows.

**A staff token, once.** `register` needs one only when it has no client of its own (`ops-id-client` empty) and root is locked: the first ship of `ops-register` after `make-admin`, or a rotation of its own secret. Get one ([Get a staff token](../apps/web/content/docs/id/onboard.mdx#get-a-staff-token)) and put it where the Job reads it, with a [kubeconfig](#get-a-kubeconfig), before the tag or the workflow:

```sh
printf 'Staff token: '; read -rs TOKEN; echo
kubectl -n answerable create secret generic ops-staff-token --from-literal=OPS_ID_TOKEN="$TOKEN"
# … the tag, or gh workflow run ops.yml … -f command=register
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

1. **Tag the current commit again**, so that `ops-bootstrap` sets every login's password back to the one its Secret holds. ID decrypts the newest stored signing key before it listens, so a restored database its secrets cannot read keeps the new pods from starting.
2. **Smoke-test**: `bun infra/pipeline/src/cli.ts smoke --environment staging`.

A restored database needs the keys that were active when its rows were written. `BETTER_AUTH_SECRET` is never replaced, so the environment's secrets read an older backup.

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
2. Repair access with the root secret. Read it into your shell without printing it: `ROOT=$(kubectl -n answerable get secret id-env -o jsonpath='{.data.ROOT_ADMIN_SECRET}' | base64 --decode)`, then run steps 2 and 5 of [`onboard.mdx` § First run](../apps/web/content/docs/id/onboard.mdx#first-run) against the environment's host, each write with a new key.
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
- **Register's own client is broad.** `ops-register` holds `platform:read platform:write`, as the Toolbox's and the admin MCP's clients do: with its secret one can mint further clients and rotate secrets. A narrower scope for registration is Not yet ([`Q-PLATFORM-REGISTER-SCOPE`](../docs/02-plan.md#open-register)); its secret lives only in `ops-id-client`, which only the ops Jobs' Role reads.
- **The `civo` provider and macOS.** A provider binary rewritten in a shared plugin cache is killed on start; `infra:check` keeps a cache per checkout ([details](civo/README.md#checks)).
