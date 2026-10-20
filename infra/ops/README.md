# Ops

The ops image: three one-off commands that a deployment runs as Kubernetes Jobs (`charts/answerable/templates/ops.yaml`). Decisions: D4, D5, D23 and B3 in `docs/goals/civo-deploy`.

| Command | When | What it does |
| --- | --- | --- |
| `bootstrap` | Every deploy, before the migrations | Writes the database's certificate authority to the ConfigMap `postgres-ca` on first use; creates the three databases, their owner logins and their runtime logins, and writes each login's URL to its Secret |
| `register` | The first install, after the release; again after a registration changes | Registers the Toolbox and the admin MCP in Answerable ID, stores both machine clients' secrets, starts the two servers; with a staff domain and an Entra tenant, connects them to the platform organisation |
| `make-admin` | Once, after the first staff member has signed in | Puts that member in the owner group and in `platform-admins`, which locks ID's root secret |

Each is safe to run again: a second run changes nothing. None prints a password, a token or a client secret.

## Run them

The deploy switches `bootstrap` on every time and `register` on the first install (`infra/pipeline/README.md`). Any of the three runs once more with `bun infra/pipeline/src/cli.ts run-job <bootstrap|register|make-admin> --environment <environment> [--email <address>]`, which is what the `ops.yml` workflow runs: it switches the Job on for one upgrade on the release's own values and prints the Job's log.

Exit codes: `0` done, `1` failed (the message says why), `2` wrong usage or a missing or invalid variable (the message names it, never its value).

Nothing waits for ever:

- A call to ID or to the Kubernetes API that gets no answer within 30 s fails, naming the call. For the Kubernetes API, the message asks whether `networkPolicy.kubernetesApi` lets the pod reach it.
- The fetch of the database's certificate fails after 15 s without an answer, asking whether `networkPolicy.database` lets the pod reach it.
- `bootstrap`'s statements fail after waiting 10 s for a lock or running for 60 s.

## Settings

| Variable | Command | Meaning |
| --- | --- | --- |
| `OPS_NAMESPACE` | `bootstrap`, `register` | The namespace of the Secrets, the ConfigMap and the Deployments. Default: the pod's |
| `OPS_DATABASE_ADMIN_URL` | `bootstrap` | The administrative login: one that may create databases and roles (`CREATEDB`, `CREATEROLE`), not necessarily a superuser, with `sslmode=verify-full`. Its host and port are written into the services' URLs |
| `OPS_DATABASE_SSLROOTCERT` | `bootstrap` | The certificate authority path in the services' URLs. Default `/etc/ssl/db/ca.pem`, where the chart mounts `postgres-ca` |
| `OPS_ID_URL` | `register`, `make-admin` | Answerable ID's origin |
| `OPS_ID_TOKEN` | `register` | A staff token (`docs/id/onboard`), needed once a person is a platform administrator and ID refuses the root secret. The chart reads it from the `ops-staff-token` Secret (key `OPS_ID_TOKEN`) when that exists |
| `OPS_ID_ROOT_SECRET` | `register`, `make-admin` | ID's root secret, which `register` uses when `OPS_ID_TOKEN` is not set and `make-admin` always. The chart reads it from `id-env`'s `ROOT_ADMIN_SECRET` |
| `OPS_TOOLBOX_URL`, `OPS_ADMIN_MCP_URL` | `register` | The two servers' origins |
| `OPS_PLATFORM_SLUG` | `register`, `make-admin` | The platform organisation's slug. Default `answerable` |
| `OPS_CLAUDE_CALLBACK_PORT` | `register` | Claude Code's `--callback-port` in the host clients' redirect URI. Default `47700` |
| `OPS_START_DEPLOYMENTS` | `register` | `name=replicas,…`: Deployments to scale up from zero once their client secrets exist |
| `OPS_STAFF_DOMAIN`, `OPS_ENTRA_TENANT` | `register` | The staff email domain (`answerable.org`) and the staff directory's Entra tenant ID, a GUID; both or neither. The chart sets them from `id.staffDomain` and `id.entraTenant` |
| `OPS_ADMIN_EMAIL` | `make-admin` | The staff member's email. The chart sets it from `ops.adminEmail` |

## Bootstrap

- **The database's certificate authority.** When the ConfigMap `postgres-ca` does not exist, `bootstrap` connects to the administrative URL's host and port, sends PostgreSQL's SSLRequest and, on `S`, a TLS 1.2 ClientHello, reads the certificates the database presents (TLS 1.2 sends them in the clear; Bun's TLS client would show the leaf alone), and hangs up. It keeps the chain's self-signed root, or the topmost certificate when no root is presented, writes it as the ConfigMap's `ca.pem`, and logs its subject, issuer, validity and SHA-256 fingerprint, the names the database's certificate carries and whether they cover the host. This is trust on first use: compare the fingerprint with what Civo shows where it shows one. A database that answers `N` serves no TLS, and `bootstrap` stops there, saying so. The ConfigMap is not Helm's: it stays across upgrades. To fetch it again, delete it and run `bootstrap`.
- **The connection.** `bootstrap` then connects with the administrative URL, `sslmode=verify-full`, and that certificate as `sslrootcert`, in a file only it reads, deleted when it is done. The Job does not mount `postgres-ca`, so it runs before the ConfigMap exists.
- **Logins.** The owner login (`answerable_<name>_owner`) migrates; the runtime login (`answerable_<name>_runtime`) serves, with `NOCREATEDB NOCREATEROLE NOINHERIT`. A login whose Secret holds a URL gets that URL's password (`ALTER ROLE`) and nothing is written; a login whose Secret is empty gets 32 random bytes, base64url, and its URL is written. A login with `SUPERUSER`, `REPLICATION` or `BYPASSRLS` stops the run: only a superuser can clear those.
- **The database.** Owned by its owner login, so that the migrations' revokes of `CREATE` and `TEMP` take effect; the administrative login is granted the owner role first, as PostgreSQL 16 and later require. `CONNECT` is revoked from `PUBLIC` and granted to the runtime login, without `TEMP`. The migrations grant the runtime login its table privileges.
- **The Secrets.** `id-database-owner` (`DATABASE_MIGRATION_URL`), `id-database` (`DATABASE_URL`), and the same pairs for `toolbox-` and `admin-` (`TOOLBOX_DATABASE_MIGRATION_URL`, `TOOLBOX_DATABASE_URL`, `ADMIN_DATABASE_MIGRATION_URL`, `ADMIN_DATABASE_URL`). Each URL ends `?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`.

A rotated password: empty the key of its Secret and run `bootstrap` again.

## Register

The calls and the `Idempotency-Key`s of `apps/web/content/docs/toolbox/admin.mdx` and `apps/web/content/docs/admin/setup.mdx`, in their order. The Toolbox's staff client (`toolbox-staff`) is the operator's and is left out.

- **Secrets.** `toolbox-hub`'s secret goes to `toolbox-id-client` (`TOOLBOX_ID_CLIENT_SECRET`), `admin-mcp`'s to `admin-id-client` (`ADMIN_ID_CLIENT_SECRET`), the moment ID answers it. A client that exists while its Secret is empty gets a new secret (`rotate-secret`).
- **Run again.** A call ID has seen replays. An object that exists under another key or another caller is left as it is.
- **The servers.** The chart runs the Toolbox and the admin MCP at zero replicas until their client Secret exists; `register` scales them up (`OPS_START_DEPLOYMENTS`).
- **The staff directory.** With `OPS_STAFF_DOMAIN` and `OPS_ENTRA_TENANT`, the calls and keys of `apps/web/content/docs/id/onboard.mdx` § First run, step 3: the domain on the platform organisation (`platform-domain-setup`), the tenant as its SSO provider through Answerable's Microsoft application (`platform-sso-setup`, `If-None-Match: *`), and the connectivity test, logged. An equal domain or provider is left as it is. When ID has no Microsoft client it says so and goes on; a different provider is left as it is, with a warning, since replacing it signs everyone out.
- **Next.** It prints the two `claude mcp add` commands and the first owner's step: sign in once, then `make-admin`.

| Error | Meaning | What to do |
| --- | --- | --- |
| `root_locked` | A person is a platform administrator, so ID refuses the root secret | Put a staff token in the `ops-staff-token` Secret (key `OPS_ID_TOKEN`) and run again |
| `ID refused Idempotency-Key …` (`idempotency_key_reused`) | The same key was used before with other input: a registration changed | Give the call a new key suffix (`-v2`) here and in the docs |
| `ID has no organisation with the slug …` | ID has not seeded the platform organisation, or the slug differs | Set `OPS_PLATFORM_SLUG` |
| `The staff domain … belongs to another organisation` | Another organisation holds the domain | Remove it there, then run again |

## Make-admin

`onboard.mdx` § First run, step 5, with the root secret: the member whose email is `OPS_ADMIN_EMAIL` goes into `answerable-owner`, the admin MCP's owner role, and then into `platform-admins`, which carries every platform scope. The owner group comes first because nothing can use the root secret afterwards. One more call confirms that ID refuses the root secret now. Each run sends new `Idempotency-Key`s: ID keeps a key's first answer for ever, so with a fixed key a run after break glass would replay the first run and add nobody.

| Error | Meaning | What to do |
| --- | --- | --- |
| `No member of the platform organisation has the email …` | That person has not signed in yet | Sign in once at ID's `/login`, then run again |
| `… no answerable-owner group: run register first` | `register` has not run | Run `register`, then this |
| `ID refuses the root secret already (root_locked)` | A person is a platform administrator: the first run is over | Add more staff with your own session (`docs/id/onboard`, The next staff member) |
| `… ID still accepts the root secret` | `ROOT_ADMIN_BREAK_GLASS` is on (after a break-glass recovery, the membership is in place) | Unset it and deploy |

## Develop

`bun run mcp:check @answerable/infra-ops` typechecks, lints and tests the workspace (100% line and function coverage). The tests use in-memory stand-ins for Kubernetes, ID's admin API, the database and the certificate fetch (`src/testing.ts`), and fetch from a TLS server of their own with certificates made by `openssl`; `bun run infra:test` runs the commands in a kind cluster against real Postgres and real ID (`infra/k8s/local/README.md`).
