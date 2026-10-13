# Pipeline

How a push becomes a deployment, and how to run the pieces by hand. The workspace `@answerable/infra-pipeline` holds the scripts the workflows call; the workflows are in `.github/workflows`. Decisions: D8, D10, D16, D24, D25 and D28 in `docs/goals/aws-deploy/decisions.md`.

## The workflows

| Workflow | Starts | What it does |
| --- | --- | --- |
| `deploy-staging.yml` | A push to `main`; or by hand with `image_tag` | Runs `ci.yml`, builds the four images once (`id`, `toolbox`, `admin-mcp`, `ops`) and signs them, upgrades the staging release, smoke-tests staging. By hand it skips the build and redeploys an image that exists |
| `promote-production.yml` | By hand (`image_tag`, default `staging`; `apply_infra`, default on) | Reads the tag staging runs, checks the images' signatures, waits for the reviewer's approval, applies `infra/civo/envs/production`, upgrades the production release with the same tag, smoke-tests production |
| `ops.yml` | By hand (`environment`, `command`) | Runs a one-off ops Job (`register`) in an environment, restarts the Toolbox and the admin MCP, smoke-tests |
| `infra.yml` | A change under `infra/**` or `charts/**` | `bun run infra:check`; on a pull request a Terraform plan of staging as a sticky comment; on `main` a Terraform apply of staging |
| `ci.yml` | A pull request or a push to any branch but `main`; called by `deploy-staging.yml` | The existing checks. A push to `main` gets its checks from `deploy-staging.yml`, so a push has one set of results and only a commit that passed them is built |

Every action is pinned by commit SHA, every binary by version and SHA-256 (`.github/actions/setup-tools`). Jobs hold `contents: read` and nothing more, except `images` (`packages: write`, `id-token: write` for the signature) and the plan comment (`pull-requests: write`).

## What each GitHub environment holds

Each environment is one Civo account's credentials. The deploy workflows never hold a Civo key: only the `deployer` ServiceAccount token, which reaches the `answerable` namespace and nothing else.

| Environment | Used by | Secrets | Settings |
| --- | --- | --- | --- |
| `staging` | `deploy-staging`, `ops`, and `promote-production` (to read the tag) | `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN`, `SOPS_AGE_KEY` | Deployment branches: `main` only |
| `production` | `promote-production`, `ops` | `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN`, `SOPS_AGE_KEY`, `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, and `STATE_ACCESS_KEY_ID` and `STATE_SECRET_ACCESS_KEY` if the Terraform state needs object-store keys | Required reviewer: the owner. Deployment branches: `main` only |
| `infra-staging` | `infra` | `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, and the same `STATE_*` keys if needed | No reviewer (it applies on push). Deployment branches: all, so that pull requests can plan |

- **`KUBE_SERVER`**: the cluster API URL, `https://…`.
- **`KUBE_CA`**: the cluster's CA certificate, as PEM or base64 of the PEM.
- **`KUBE_TOKEN`**: the `deployer` ServiceAccount token that Terraform creates.
- **`SOPS_AGE_KEY`**: the environment's `age` private key (`AGE-SECRET-KEY-…`).
- **`CIVO_TOKEN`**, **`CLOUDFLARE_API_TOKEN`**: read by the Civo and Cloudflare providers. The Cloudflare token is scoped to that environment's zone.
- **`STATE_ACCESS_KEY_ID`**, **`STATE_SECRET_ACCESS_KEY`**: handed to Terraform's S3 backend as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Leave them unset when the backend needs neither.

There are no variables: the hostnames follow from the environment name (`staging` is `answerable-staging.uk`, `production` is `answerable.org`).

### One-time setup the owner does in GitHub

1. Create the three environments with the settings above and add their secrets.
2. After the first push has built the images, set each of the four packages (`answerable/id`, `toolbox`, `admin-mcp`, `ops`) to **public** in the package settings (GitHub has no API for it). The cluster pulls them without a pull secret.
3. Branch protection on `main`: require the checks of `ci.yml` (`validate`, and the infra and container jobs once they exist) and `infra.yml`'s `Check`.
4. Turn Bot Fight Mode off in both Cloudflare zones, as `docs/goals/aws-deploy/task_plan.md` says.

## How a deploy runs

1. **Images.** `docker/build-push-action` builds each Dockerfile once, for one platform, with provenance (`mode=max`) and an SBOM, and pushes `ghcr.io/rieranthony/answerable/<image>:sha-<commit>`. `cosign sign` signs the digest keylessly with the workflow's identity.
2. **Secrets.** `sops --decrypt <environment>/secrets.enc.yaml` is piped straight to `kubectl apply -n answerable -f -`. The decrypted text lives in memory only: it is never written to disk, never logged, and a kubectl complaint is printed with the secret values blanked.
3. **Release.** `helm upgrade --install answerable charts/answerable --namespace answerable --atomic --wait --timeout 10m -f <values> --set image.tag=<tag>`. The chart's hook Jobs run first: the optional `ops-bootstrap`, then the migrations, each with the owner login that the services never receive. `--atomic` rolls the release back when a Job fails or the pods never become ready, and the script then prints the logs of every Job whose name contains `migrate`, `bootstrap` or `register`.
4. **Smoke test.** From the public internet, through Cloudflare: ID's `/healthz`, `/readyz`, discovery (the `issuer` must be the ID hostname), its signing keys, the Toolbox's and the admin MCP's `/health`, and both protected-resource metadata documents naming the issuer. It retries for up to five minutes, because a first certificate and the edge take a while.

`helm history answerable -n answerable` is the deploy log.

## Roll back

- **Staging, to an earlier image.** Run `Deploy staging` by hand with `image_tag` set to an earlier `sha-…`. Nothing is built.
- **Production, to an earlier image.** Run `Promote production` with `image_tag` set to the earlier `sha-…`.
- **Straight to the previous release** (chart, values and image together), with a kubeconfig that can reach the cluster: `helm rollback answerable <revision> --namespace answerable --wait`.

Migrations are expand-then-contract: a migration never breaks the previous image, so the previous image runs on the newer schema. A migration that cannot be written that way needs a restore, not a rollback.

## Run it by hand

Needs `bun`, `helm`, `kubectl` and, for `deploy`, `sops` on the path. From the repository root:

```bash
export KUBE_SERVER=https://… KUBE_CA=… KUBE_TOKEN=…   # the deployer ServiceAccount
export SOPS_AGE_KEY=AGE-SECRET-KEY-…                  # deploy only

bun infra/pipeline/src/cli.ts deploy --environment staging --image-tag sha-<40 hex> --bootstrap
bun infra/pipeline/src/cli.ts run-job register --environment staging
bun infra/pipeline/src/cli.ts current-tag             # prints the tag the release runs
bun infra/pipeline/src/cli.ts smoke --environment staging --wait 60
```

`--help` lists the options. Progress goes to standard error; `current-tag` prints only the tag, and `smoke` only its table, on standard output. Exit codes: 0 done, 1 a step failed or a check failed, 2 wrong usage.

The tag must be `sha-` and a full commit SHA: the scripts refuse `latest`, `staging` and every other mutable name.

Verify an image by hand:

```bash
cosign verify ghcr.io/rieranthony/answerable/id:sha-<40 hex> \
  --certificate-identity https://github.com/Rieranthony/answerable/.github/workflows/deploy-staging.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## What the scripts assume of the chart

- Release `answerable` of `charts/answerable` in namespace `answerable`, which Terraform creates (the deployer cannot create namespaces). Values overlays at `charts/answerable/values-civo-<environment>.yaml`.
- The image tag is the value `image.tag`. `ops.bootstrap` and `ops.register` switch the two ops Jobs on; `bootstrap` must run before the migrations.
- The Jobs' names contain `migrate`, `bootstrap` or `register`; the Deployments' names end in `toolbox` and `admin-mcp`.
- The secrets file is YAML that `sops` can encrypt, so a mapping at the top level: several documents separated by `---`, or one `kind: List`. A bare YAML list is refused by `sops`.

## Known limits

- **Architecture.** `images` builds `linux/arm64` on GitHub's free arm64 runners (`IMAGE_PLATFORM` and `runs-on` in `deploy-staging.yml`). The cluster's nodes must run arm64; if Civo's do not, change the platform and the runner to `linux/amd64` and `ubuntu-24.04`.
- **Last-applied annotation.** `kubectl apply` stores the Secret's data in the object's `last-applied-configuration` annotation. It is readable by whoever can read the Secret anyway.
- **Plans run the repository's Terraform code with the Civo key.** A pull request from this repository can read the `infra-staging` secrets; a pull request from a fork cannot. Treat write access as access to the staging account.
- **Staging's tag is read in the `staging` environment.** `promote-production.yml` uses the staging deployer token, with no deployment record, only to run `helm get values`.
- **Signature verification** happens in `promote-production.yml`, not in the cluster. Enforcing it at admission is Not yet.

## Keep the pins current

`.github/actions/setup-tools/action.yml` lists each tool's version and SHA-256; change both together, taking the checksum from the release's own checksum file. Each action's `uses:` line carries its commit SHA and the tag it is. Helm 4 deprecates `--atomic` for `--rollback-on-failure`; `deploy.ts` still uses `--atomic`, which works and warns.
