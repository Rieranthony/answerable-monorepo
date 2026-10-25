# Pipeline

How a tag becomes a deployment, and how to run the pieces by hand. The workspace `@answerable/infra-pipeline` holds the scripts the workflows call; the workflows are in `.github/workflows`. Nothing here runs from a laptop: every secret is born in GitHub, in Terraform or inside the cluster.

## The workflows

| Workflow | Starts | What it does |
| --- | --- | --- |
| `ci.yml` | A push to any branch; called by the two shipping workflows | The checks: validate, `infra:check`, and the kind stack on amd64, as Civo runs |
| `bootstrap.yml` | By hand, once per environment (`environment`) | Creates the Terraform state bucket and its credential with the Civo CLI, and writes the state credential and ID's three random secrets into the GitHub environment, each only when missing. Prints nothing secret |
| `deploy-staging.yml` | A tag `staging/<name>` on a commit of `main` | CI; Terraform's apply of staging, which also writes `KUBE_SERVER`, `KUBE_CA` and `KUBE_TOKEN` to the environment; the four images built for amd64, pushed by digest, tagged `sha-<commit>` and signed; `deploy`; `smoke` |
| `promote-production.yml` | A tag `production/<name>` on a commit of `main` | Verifies the four signatures of `sha-<commit>`, which only a `staging/*` tag of that commit builds, so staging always comes first; waits for the owner's approval; Terraform's apply of production; `deploy` with the verified digests; `smoke` |
| `ops.yml` | By hand (`environment`, `command`: `register` or `make-admin`, `email`) | `run-job`: one ops Job, once. `make-admin` is the last step of an environment's first run |

## What each GitHub environment holds

Two environments, `staging` and `production`, each allowed for the branch `main` and the tags `<environment>/*`; `production` requires the owner's review. The deploy jobs hold the namespace-scoped `deployer` token, never a Civo key.

| Secret | Written by | Read by |
| --- | --- | --- |
| `CIVO_TOKEN`, `CLOUDFLARE_API_TOKEN`, `GH_SECRETS_TOKEN` | The owner, once | Terraform; `bootstrap.yml` |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | The owner, once | `deploy`, into `id-env` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (optional) | The owner | `deploy`, into `id-env` |
| `STATE_ACCESS_KEY_ID`, `STATE_SECRET_ACCESS_KEY` | `bootstrap.yml` | Terraform's backend (`infra/civo/terraform.sh`) |
| `BETTER_AUTH_SECRET`, `ROOT_ADMIN_SECRET` | `bootstrap.yml` | `deploy`, into `id-env` |
| `BETTER_AUTH_SECRETS` (optional) | The owner, from ID's first secret rotation on ([the runbook](../README.md#the-application-secret)) | `deploy`, into `id-env` |
| `KUBE_SERVER`, `KUBE_CA`, `KUBE_TOKEN` | Terraform (`github` module) | `deploy`, `run-job` |

The hostnames follow from the environment name (`staging` is `answerable-staging.uk`, `production` is `answerable.org`).

## How a deploy runs

1. **Infrastructure.** Terraform applies the environment before anything is deployed (a no-op when nothing changed). It writes what the release expects in `answerable`: the ConfigMap `trusted-proxies`, the Secrets `postgres-admin` and `origin-tls`, and the platform release.
2. **Images.** The four images (`id`, `toolbox`, `admin-mcp`, `ops`) are built for amd64, which Civo's nodes run, pushed by digest, tagged `ghcr.io/rieranthony/answerable/<image>:sha-<commit>` and signed with cosign.
3. **`id-env`.** `deploy` builds the Secret `id-env` from the variables above: the two required secrets, each platform application's pair when both halves are set, and `BETTER_AUTH_SECRETS` when set. An empty required value or half a pair stops the deploy before it touches anything, naming the variables. It is applied on `kubectl`'s standard input and never written to disk or logged; of kubectl's output only the lines that name an applied object are shown, and nothing when the apply fails, because an API error can quote a value. Its values go in as `data`, so a key left out later (a pair, or the ring) is removed.
4. **Release.** The four digests of the tag are looked up (`docker buildx imagetools inspect`) unless given, then `helm upgrade --install answerable charts/answerable --namespace answerable --rollback-on-failure --wait --wait-for-jobs --timeout 10m -f charts/answerable/values-civo-<environment>.yaml --set image.tag=<tag> --set images.<image>.digest=<digest> … --set-string idEnvChecksum=<sha256> --set ops.bootstrap=true`. The chart's hook Jobs run first: `ops-bootstrap`, then the migrations, each with the owner login that the services never receive. `--rollback-on-failure` rolls the release back when a Job fails or the pods never become ready, and the script then prints the logs of every migration and ops Job.
5. **Smoke test.** From the public internet, through Cloudflare: ID's `/healthz`, `/readyz`, discovery (the `issuer` must be the ID hostname), its signing keys, the Toolbox's and the admin MCP's `/health`, and both protected-resource metadata documents naming the issuer.

**A changed secret rolls ID on the next tag.** `idEnvChecksum` is the SHA-256 of `id-env`'s values (keys sorted, as JSON), which the chart puts on ID's pods. A new tag of the same commit resolves the same digests, so without it Helm would change nothing in ID's pods and they would keep the old values. The Toolbox and the admin MCP do not read `id-env`.

**The first deploy registers by itself.** The chart keeps the Toolbox and the admin MCP at zero replicas until their client Secrets, `toolbox-id-client` and `admin-id-client`, exist, and only `register` creates them. So before the upgrade `deploy` asks the cluster whether both exist, and when either is missing it switches `ops.register` on for that upgrade and says why. Once both exist it does not again: after a person holds `platform:write`, ID refuses the root secret that `register` uses.

`helm history answerable -n answerable` is the deploy log.

## An environment's first run

1. `bootstrap.yml` for the environment.
2. A tag `staging/<name>` (or `production/<name>`). The first install's `ops-bootstrap` fetches the database's certificate into the ConfigMap `postgres-ca` and logs its SHA-256 fingerprint (trust on first use: `infra/ops/README.md`); `ops-register` registers the MCP servers and, with `id.staffDomain` and `id.entraTenant` in the overlay, adds the staff domain and the Entra tenant to the platform organisation.
3. Sign in once at `https://id.<zone>/login` with your work account.
4. `ops.yml` with `make-admin` and your email: you join the owner group and `platform-admins`, and ID's root secret locks.

## Register again

`register` also has to run again to rotate the Toolbox's or the admin MCP's client secret, or to register a changed definition. Root is locked by then, so `register` needs a staff token: put it in the Secret the Job reads,

```bash
kubectl -n answerable create secret generic ops-staff-token --from-literal=OPS_ID_TOKEN=<staff token>
```

then run `ops.yml` with `register`, which restarts the two servers afterwards so that they read the new client secrets. Delete the Secret when you are done.

## Roll back

- **To an earlier commit.** Tag it `staging/<name>`, then `production/<name>`: its images exist and are signed, so nothing is built that was not before. Migrations are expand-then-contract: a migration never breaks the previous image, so the previous image runs on the newer schema. A migration that cannot be written that way needs a restore, not a rollback.
- **Straight to the previous release** (chart, values and images together), with a kubeconfig that can reach the cluster: `helm rollback answerable <revision> --namespace answerable --wait`.

## Run it by hand

Needs `bun`, `helm`, `kubectl` and, for `deploy` without `--image-digest`, Docker with buildx. From the repository root:

```bash
export KUBE_SERVER=https://… KUBE_CA=… KUBE_TOKEN=…   # the deployer ServiceAccount
export BETTER_AUTH_SECRET=… ROOT_ADMIN_SECRET=… MICROSOFT_CLIENT_ID=… MICROSOFT_CLIENT_SECRET=…   # deploy only

bun infra/pipeline/src/cli.ts deploy --environment staging --image-tag sha-<40 hex> [--image-digest <image>=sha256:<hex> x4] [--timeout 10m]
bun infra/pipeline/src/cli.ts run-job <bootstrap|register|make-admin> --environment staging [--email you@answerable.org] [--timeout 10m]
bun infra/pipeline/src/cli.ts smoke --environment staging --wait 60
```

`--help` lists the options. Progress goes to standard error, and `smoke`'s table to standard output. Exit codes: 0 done, 1 a step failed or a check failed, 2 wrong usage.

The tag must be `sha-` and a full commit SHA: the scripts refuse `latest`, `staging` and every other mutable name. `deploy` looks the four digests up from the tag, or takes them as `--image-digest id=sha256:<hex>` repeated for all four images.

`run-job` upgrades the release with `--reset-then-reuse-values`: the chart's defaults, then the values the release runs (its images, their digests, `idEnvChecksum`), then the overlay, with that one Job switched on and the others off (`make-admin` with `--set-string ops.adminEmail=<email>`). It prints the Job's log, and after `register` restarts the Toolbox and the admin MCP.

Verify an image by hand:

```bash
cosign verify ghcr.io/rieranthony/answerable/id@sha256:<64 hex> \
  --certificate-identity-regexp '^https://github.com/Rieranthony/answerable-monorepo/.github/workflows/deploy-staging.yml@refs/tags/staging/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## What the scripts assume of the chart

- Release `answerable` of `charts/answerable` in namespace `answerable`, which Terraform creates (the deployer cannot create namespaces). Values overlays at `charts/answerable/values-civo-<environment>.yaml`.
- The release pins each image by digest. For every image `id`, `toolbox`, `admin-mcp` and `ops` the value `images.<image>.digest` is `sha256:` and 64 hex characters, and the chart renders the image as `<repository>@<digest>`. `image.tag` is the same commit as a label for people.
- `idEnvChecksum` is an annotation of ID's pod template.
- `ops.bootstrap`, `ops.register` and `ops.makeAdmin` (with `ops.adminEmail`) switch the three ops Jobs on; `bootstrap` runs before the migrations. The Secrets `toolbox-id-client` and `admin-id-client` are what `register` creates, and `deploy` reads their existence to decide whether to switch `register` on.
- The Jobs are named `ops-<job>`, and the migration Jobs' names contain `migrate`; the Deployments' names end in `toolbox` and `admin-mcp`.

## Known limits

- **Digests are read from the registry.** `deploy-staging.yml` resolves them from the run that built them; `promote-production.yml` resolves them once, verifies them, and passes those.
- **Last-applied annotation.** `kubectl apply` stores `id-env`'s data in the object's `last-applied-configuration` annotation. It is readable by whoever can read the Secret anyway.
- **Signature verification** happens in `promote-production.yml`, not in the cluster. Enforcing it at admission is Not yet.
- **`run-job` takes the chart from the checkout.** It reuses the release's values, images included, but renders the templates of the commit it runs on; run it from the commit the environment runs, or one whose chart is compatible.

## Keep the pins current

`.github/actions/setup-tools/action.yml` lists each tool's version and SHA-256; change both together, taking the checksum from the release's own checksum file. Each action's `uses:` line carries its commit SHA and the tag it is. `setup-tools` pins Helm 4, which deprecated `--atomic` for `--rollback-on-failure`, so `deploy.ts` uses the new flag; Helm 3 does not know it.
