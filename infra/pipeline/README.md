# Pipeline

How a push becomes a deployment, and how to run the pieces by hand. The workspace `@answerable/infra-pipeline` holds the scripts the workflows call; the workflows are in `.github/workflows`. Decisions: D8, D10, D16, D24, D25 and D28 in `docs/goals/aws-deploy/decisions.md`.

## The workflows

| Workflow | Starts | What it does |
| --- | --- | --- |
| `deploy-staging.yml` | A push to `main`; or by hand with `image_tag` | Runs `ci.yml`, applies `infra/civo/envs/staging` (a no-op when nothing changed), builds the four images (`id`, `toolbox`, `admin-mcp`, `ops`) for amd64 and arm64, joins each pair into one tagged manifest list and signs it, upgrades the staging release with the images pinned by digest, smoke-tests staging. By hand it skips all of that but the upgrade and the smoke test: it redeploys an image that exists |
| `promote-production.yml` | By hand (`image_tag`, default `staging`; `apply_infra`, default on) | Reads the tag staging runs, checks the images' signatures on the digests their tags point to, waits for the reviewer's approval, applies `infra/civo/envs/production`, upgrades the production release with the tag and exactly the digests it verified, smoke-tests production |
| `ops.yml` | By hand (`environment`, `command`) | Runs a one-off ops Job (`register`) in an environment, restarts the Toolbox and the admin MCP, smoke-tests |
| `infra.yml` | A pull request that changes `infra/**` or `charts/**` | `bun run infra:check` and a Terraform plan of staging as a sticky comment. It applies nothing: staging applies in `deploy-staging.yml`, production in `promote-production.yml` |
| `ci.yml` | A pull request or a push to any branch but `main`; called by `deploy-staging.yml` | The existing checks. A push to `main` gets its checks from `deploy-staging.yml`, so a push has one set of results and only a commit that passed them is built |

Every action is pinned by commit SHA, every binary by version and SHA-256 (`.github/actions/setup-tools`). Jobs hold `contents: read` and nothing more, except `build` (`packages: write`), `manifest` (`packages: write`, `id-token: write` for the signature) and the plan comment (`pull-requests: write`).

## What each GitHub environment holds

Each environment is one Civo account's credentials. The deploy workflows never hold a Civo key: only the `deployer` ServiceAccount token, which reaches the `answerable` namespace and nothing else.

| Environment | Used by | Secrets | Settings |
| --- | --- | --- | --- |
| `staging` | `deploy-staging` (the upgrade), `ops`, and `promote-production` (to read the tag) | `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN`, `SOPS_AGE_KEY` | Deployment branches: `main` only |
| `production` | `promote-production`, `ops` | `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN`, `SOPS_AGE_KEY`, `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY`, `ALLOWED_API_CIDRS` | Required reviewer: the owner. Deployment branches: `main` only |
| `infra-staging` | `deploy-staging` (the apply), `infra` (the plan) | `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY`, `ALLOWED_API_CIDRS` (may be `[]` or unset) | No reviewer (it applies on every push to `main`). Deployment branches: all, so that pull requests can plan |

- **`KUBE_SERVER`**: the cluster API URL, `https://…`.
- **`KUBE_CA`**: the cluster's CA certificate, as PEM or base64 of the PEM.
- **`KUBE_TOKEN`**: the `deployer` ServiceAccount token that Terraform creates.
- **`SOPS_AGE_KEY`**: the environment's `age` private key (`AGE-SECRET-KEY-…`).
- **`CIVO_TOKEN`**, **`CLOUDFLARE_API_TOKEN`**: read by the Civo and Cloudflare providers. The Cloudflare token is scoped to that environment's zone.
- **`STATE_ACCESS_KEY_ID`**, **`STATE_SECRET_ACCESS_KEY`**: the Terraform state bucket's credential (the `state_access_key_id` and `state_secret_access_key` outputs of the root's `state` module), handed to the S3 backend as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Each environment has its own bucket and its own pair.
- **`ALLOWED_API_CIDRS`**: a JSON list of CIDRs, such as `["198.51.100.7/32"]`, handed to Terraform as `TF_VAR_allowed_api_cidrs`. In production these addresses are the only way to the Kubernetes API, and the job stops with a message when the secret is not set. Staging's API is open by its own switch (`infra/civo/README.md`, "Who can reach the Kubernetes API"), so `[]` is right there and an unset secret is read as `[]`. Terraform marks the variable sensitive, so the plan comment does not print it.

There are no variables: the hostnames follow from the environment name (`staging` is `answerable-staging.uk`, `production` is `answerable.org`).

### One-time setup the owner does in GitHub

1. Create the three environments with the settings above and add their secrets.
2. After the first push has built the images, set each of the four packages (`answerable/id`, `toolbox`, `admin-mcp`, `ops`) to **public** in the package settings (GitHub has no API for it). The cluster pulls them without a pull secret.
3. Branch protection on `main`: require the jobs of `ci.yml` that run on every pull request: `validate`, `infra-check` and, once it exists, `containers`. Do not require anything from `infra.yml`: it runs only on pull requests that change `infra/**` or `charts/**`, and a required check that never starts blocks the others.
4. Turn Bot Fight Mode off in both Cloudflare zones, as `docs/goals/aws-deploy/task_plan.md` says.

## How a deploy runs

1. **Infrastructure.** On staging, `terraform apply -auto-approve` of `infra/civo/envs/staging` must succeed before anything is deployed (a no-op when nothing changed). Production applies in the same job as its deploy, after the reviewer approves.
2. **Images.** Each of the four images is built twice, by `docker/build-push-action` on a native runner per architecture (`ubuntu-24.04` for amd64, `ubuntu-24.04-arm` for arm64, no emulation), with provenance (`mode=max`) and an SBOM, and pushed by digest with no tag; the digest travels to the next job as an artifact. One `manifest` job per image then runs `docker buildx imagetools create` over the two digests to make `ghcr.io/rieranthony/answerable/<image>:sha-<commit>`, checks that it serves exactly amd64 and arm64, and `cosign sign` signs the manifest list's digest keylessly with the workflow's identity.
3. **Secrets.** `sops --decrypt <environment>/secrets.enc.yaml` is piped straight to `kubectl apply -n answerable -f -`. The decrypted text lives in memory only: it is never written to disk and never logged. Of kubectl's own output only the lines that name an applied object (`secret/id-env configured`) are shown, and when the apply fails nothing of it is: the error is the exit code and a sentence telling you to run the apply by hand, because an API error can quote a value in any encoding.
4. **Release.** The four manifest-list digests of the tag are looked up (`docker buildx imagetools inspect <registry>/<image>:<tag> --format '{{.Manifest.Digest}}'`) unless they are given, then `helm upgrade --install answerable charts/answerable --namespace answerable --rollback-on-failure --wait --timeout 10m -f <values> --set image.tag=<tag> --set images.<image>.digest=<digest>` for each image. The release runs the digests; the tag is for people to read, so a rerun that moves a tag changes nothing. The chart's hook Jobs run first: the optional `ops-bootstrap`, then the migrations, each with the owner login that the services never receive. `--rollback-on-failure` rolls the release back when a Job fails or the pods never become ready, and the script then prints the logs of every Job whose name contains `migrate`, `bootstrap` or `register`.
5. **Smoke test.** From the public internet, through Cloudflare: ID's `/healthz`, `/readyz`, discovery (the `issuer` must be the ID hostname), its signing keys, the Toolbox's and the admin MCP's `/health`, and both protected-resource metadata documents naming the issuer. It retries for up to five minutes, because a first certificate and the edge take a while.

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

bun infra/pipeline/src/cli.ts deploy --environment staging --image-tag sha-<40 hex> --bootstrap   # needs Docker for the digests
bun infra/pipeline/src/cli.ts run-job register --environment staging
bun infra/pipeline/src/cli.ts current-tag             # prints the tag the release runs
bun infra/pipeline/src/cli.ts smoke --environment staging --wait 60
```

`--help` lists the options. Progress goes to standard error; `current-tag` prints only the tag, and `smoke` only its table, on standard output. Exit codes: 0 done, 1 a step failed or a check failed, 2 wrong usage.

The tag must be `sha-` and a full commit SHA: the scripts refuse `latest`, `staging` and every other mutable name. `deploy` and `run-job` look the four digests up from the tag, or take them as `--image-digest id=sha256:<hex>` repeated for all four images (`id`, `toolbox`, `admin-mcp`, `ops`); `run-job` without a tag keeps the digests the release runs.

Verify an image by hand:

```bash
cosign verify ghcr.io/rieranthony/answerable/id@sha256:<64 hex> \
  --certificate-identity https://github.com/Rieranthony/answerable/.github/workflows/deploy-staging.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Rehearse against a real cluster

The unit tests use a fake runner. `bun run --filter @answerable/infra-pipeline rehearse` runs the same scripts with the real `kubectl`, `helm` and `sops` against a throwaway `kind` cluster, signed in with a namespace-scoped ServiceAccount token. It deploys a stand-in chart pinned by digest (the digests are handed over, since no image is pushed), runs `register`, breaks a migration on purpose, and checks the token's reach. It needs Docker, `kind`, `kubectl`, `helm`, `sops` and `age-keygen`, takes two to three minutes, uses its own kubeconfig, and deletes its cluster. Add `-- --secrets list` to encrypt a `kind: List` file instead of several documents. It proves the scripts and the tools, not the chart.

## What the scripts assume of the chart

- Release `answerable` of `charts/answerable` in namespace `answerable`, which Terraform creates (the deployer cannot create namespaces). Values overlays at `charts/answerable/values-civo-<environment>.yaml`.
- The release pins each image by digest. For every image `id`, `toolbox`, `admin-mcp` and `ops` the value `images.<image>.digest` is `sha256:` and 64 hex characters, and the chart renders the image as `<repository>@<digest>` when it is set (the repositories are `ghcr.io/rieranthony/answerable/<image>`). The key of the admin MCP is `admin-mcp`, so a template reads it with `index .Values.images "admin-mcp"`. `image.tag` is the same commit as a label for people and for `current-tag`, and is not what the pods pull.
- `ops.bootstrap` and `ops.register` switch the two ops Jobs on; `bootstrap` must run before the migrations.
- The Jobs' names contain `migrate`, `bootstrap` or `register`; the Deployments' names end in `toolbox` and `admin-mcp`.
- The secrets file is YAML that `sops` can encrypt, so a mapping at the top level: several documents separated by `---`, or one `kind: List`. A bare YAML list is refused by `sops`.

## Known limits

- **Architecture.** Civo does not document its nodes' architecture, and the local kind cluster on a Mac is arm64, so every tag is a manifest list for `linux/amd64` and `linux/arm64`. That is two builds per image, both on native runners, and no emulation. Another architecture is one more entry in the `build` matrix of `deploy-staging.yml`.
- **Digests are read from the registry.** `deploy-staging.yml` resolves them right after the manifest jobs, from the same run. `promote-production.yml` resolves them once, verifies them, and passes those. A manual `deploy-staging` run or `ops` run resolves them from the tag, so it trusts the registry as it is at that moment.
- **Last-applied annotation.** `kubectl apply` stores the Secret's data in the object's `last-applied-configuration` annotation. It is readable by whoever can read the Secret anyway.
- **Plans run the repository's Terraform code with the Civo key.** A pull request from this repository can read the `infra-staging` secrets; a pull request from a fork cannot. Treat write access as access to the staging account.
- **Staging applies before every deploy.** The `infra` job of `deploy-staging.yml` runs `terraform apply -auto-approve` on every push to `main`, so the code that lands is what runs. Review Terraform changes in the pull request's plan comment.
- **Staging's tag is read in the `staging` environment.** `promote-production.yml` uses the staging deployer token, with no deployment record, only to run `helm get values`.
- **Signature verification** happens in `promote-production.yml`, not in the cluster. Enforcing it at admission is Not yet.

## Keep the pins current

`.github/actions/setup-tools/action.yml` lists each tool's version and SHA-256; change both together, taking the checksum from the release's own checksum file. Each action's `uses:` line carries its commit SHA and the tag it is. `setup-tools` pins Helm 4, which deprecated `--atomic` for `--rollback-on-failure`, so `deploy.ts` uses the new flag; Helm 3 does not know it.
