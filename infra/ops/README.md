# Ops

The ops image: two one-off commands that a deployment runs as Kubernetes Jobs (`charts/answerable/templates/ops.yaml`). Decisions: D4, D5, D23 and B3 in `docs/goals/aws-deploy`.

| Command | When | What it does |
| --- | --- | --- |
| `bootstrap` | Once per environment, before the first migrations; again whenever a Secret is lost | Creates the three databases, their owner logins and their runtime logins, and writes each login's URL to its Secret |
| `register` | Once per environment, after the first release; again after a registration changes | Registers the Toolbox and the admin MCP in Answerable ID, stores both machine clients' secrets, starts the two servers |

Both are safe to run again: a second run changes nothing. Neither prints a password, a token or a client secret.

## Run them

From the pipeline: the `ops.yml` workflow, or `bun infra/pipeline/src/cli.ts run-job register --environment staging` (`infra/pipeline/README.md`), switches the Job on for one upgrade (`ops.bootstrap` or `ops.register`) and, after `register`, restarts the Toolbox and the admin MCP. By hand, against the cluster the kubeconfig names:

```bash
helm upgrade answerable charts/answerable -n answerable --reuse-values --set ops.bootstrap=true --wait --wait-for-jobs
kubectl -n answerable logs job/ops-bootstrap
```

The first deploy of an environment runs `bootstrap` with the install (the migrations need its Secrets), then `register` once ID is up.

Outside a cluster, with a file instead of Kubernetes Secrets:

```bash
OPS_STORE=file OPS_SECRETS_FILE=./secrets.json \
OPS_DATABASE_ADMIN_URL='postgres://dbadmin:…@db.example:5432/postgres?sslmode=verify-full&sslrootcert=./ca.pem' \
bun infra/ops/src/cli.ts bootstrap
```

Exit codes: `0` done, `1` failed (the message says why), `2` wrong usage or a missing or invalid variable (the message names it, never its value).

## Settings

| Variable | Command | Meaning |
| --- | --- | --- |
| `OPS_STORE` | both | `kubernetes` (default): Secrets in the pod's namespace, through the API server with the pod's ServiceAccount. `file`: the JSON file `OPS_SECRETS_FILE` (mode `0600`) |
| `OPS_NAMESPACE` | both | The namespace of the Secrets. Default: the pod's |
| `OPS_DATABASE_ADMIN_URL` | `bootstrap` | The administrative login: one that may create databases and roles (`CREATEDB`, `CREATEROLE`). It need not be a superuser |
| `OPS_DATABASE_HOST`, `OPS_DATABASE_PORT` | `bootstrap` | The database address written into the services' URLs. Default: the administrative URL's |
| `OPS_DATABASE_SSLROOTCERT` | `bootstrap` | The certificate authority path in the services' URLs. Default `/etc/ssl/db/ca.pem`, where the chart mounts `postgres-ca` |
| `OPS_ID_URL` | `register` | Answerable ID's origin |
| `OPS_ID_TOKEN` | `register` | A staff token (`docs/id/onboard`), needed once a person is a platform administrator and ID refuses the root secret. The chart reads it from the `ops-staff-token` Secret (key `OPS_ID_TOKEN`) when that exists |
| `OPS_ID_ROOT_SECRET` | `register` | ID's root secret, used when `OPS_ID_TOKEN` is not set. The chart reads it from `id-env`'s `ROOT_ADMIN_SECRET` |
| `OPS_TOOLBOX_URL`, `OPS_ADMIN_MCP_URL` | `register` | The two servers' origins |
| `OPS_PLATFORM_SLUG` | `register` | The platform organisation's slug. Default `answerable` |
| `OPS_CLAUDE_CALLBACK_PORT` | `register` | Claude Code's `--callback-port` in the host clients' redirect URI. Default `47700` |
| `OPS_START_DEPLOYMENTS` | `register` | `name=replicas,…`: Deployments to scale up from zero once their client secrets exist |

## Bootstrap

For each of `answerable_id`, `answerable_toolbox` and `answerable_admin`:

- **Logins.** The owner login (`answerable_<name>_owner`) migrates; the runtime login (`answerable_<name>_runtime`) serves, with `NOCREATEDB NOCREATEROLE NOINHERIT`. A login whose Secret holds a URL gets that URL's password (`ALTER ROLE`) and nothing is written; a login whose Secret is empty gets 32 random bytes, base64url, and its URL is written. A login with `SUPERUSER`, `REPLICATION` or `BYPASSRLS` stops the run: only a superuser can clear those.
- **The database.** Owned by its owner login, so that the migrations' revokes of `CREATE` and `TEMP` take effect; the administrative login is granted the owner role first, as PostgreSQL 16 and later require. `CONNECT` is revoked from `PUBLIC` and granted to the runtime login, without `TEMP`. The migrations grant the runtime login its table privileges.
- **The Secrets.** `id-database-owner` (`DATABASE_MIGRATION_URL`), `id-database` (`DATABASE_URL`), and the same pairs for `toolbox-` and `admin-` (`TOOLBOX_DATABASE_MIGRATION_URL`, `TOOLBOX_DATABASE_URL`, `ADMIN_DATABASE_MIGRATION_URL`, `ADMIN_DATABASE_URL`). Each URL ends `?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`.

A rotated password: empty the key of its Secret and run `bootstrap` again.

## Register

The calls and the `Idempotency-Key`s of `apps/web/content/docs/toolbox/admin.mdx` and `apps/web/content/docs/admin/setup.mdx`, in their order. The Toolbox's staff client (`toolbox-staff`) is the operator's and is left out.

- **Secrets.** `toolbox-hub`'s secret goes to `toolbox-id-client` (`TOOLBOX_ID_CLIENT_SECRET`), `admin-mcp`'s to `admin-id-client` (`ADMIN_ID_CLIENT_SECRET`), the moment ID answers it. A client that exists while its Secret is empty gets a new secret (`rotate-secret`).
- **Run again.** A call ID has seen replays. An object that exists under another key or another caller is left as it is.
- **The servers.** The chart runs the Toolbox and the admin MCP at zero replicas until their client Secret exists; `register` scales them up (`OPS_START_DEPLOYMENTS`).
- **Next.** It prints the two `claude mcp add` commands and how to put the first owner in the owner group.

| Error | Meaning | What to do |
| --- | --- | --- |
| `root_locked` | A person is a platform administrator, so ID refuses the root secret | Put a staff token in the `ops-staff-token` Secret (key `OPS_ID_TOKEN`) and run again |
| `ID refused Idempotency-Key …` (`idempotency_key_reused`) | The same key was used before with other input: a registration changed | Give the call a new key suffix (`-v2`) here and in the docs |
| `ID has no organisation with the slug …` | ID has not seeded the platform organisation, or the slug differs | Set `OPS_PLATFORM_SLUG` |

## Develop

`bun run mcp:check @answerable/infra-ops` typechecks, lints and tests the workspace (100% line and function coverage). The tests use in-memory stand-ins for Kubernetes, ID's admin API and the database (`src/testing.ts`); `bun run infra:test` runs both commands in a kind cluster against real Postgres and real ID (`infra/k8s/local/README.md`).
