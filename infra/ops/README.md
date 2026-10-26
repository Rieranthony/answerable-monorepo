# Ops

The ops image: three one-off commands that a deployment runs as Kubernetes Jobs (`charts/answerable/templates/ops.yaml`). Decisions: D4, D5, D23 and B3 in `docs/goals/civo-deploy`.

| Command | When | What it does |
| --- | --- | --- |
| `bootstrap` | Every deploy, before the migrations | Writes the database's certificate authority to the ConfigMap `postgres-ca` on first use; creates the databases, their owner logins and their runtime logins, and writes each login's URL to its Secret; provisions each MCP of the chart's list (`OPS_MCPS`): its schema and roles in `answerable_mcps`, or its own database |
| `register` | Every deploy, after the release | As its own machine client, `ops-register`, which its first run mints: registers the Toolbox, the admin MCP and each standalone MCP of the chart's list in Answerable ID, changing only what differs; stores the machine clients' secrets, starts the servers; with a staff domain and an Entra tenant, connects them to the platform organisation |
| `make-admin` | Once, after the first staff member has signed in | Puts that member in the owner group and in `platform-admins`, which locks ID's root secret |

Each is safe to run again: a second run changes nothing. None prints a password, a token or a client secret.

## Run them

The deploy switches `bootstrap` and `register` on every time (`infra/pipeline/README.md`). The `ops.yml` workflow runs `register` or `make-admin` once more: `bun infra/pipeline/src/cli.ts run-job <register|make-admin> --environment <environment> [--email <address>]`, which switches the Job on for one upgrade on the release's own values, with the chart of the commit the release runs, and prints the Job's log. `bootstrap` runs again with the next deploy.

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
| `OPS_MCPS` | `bootstrap`, `register` | The MCPs of `charts/answerable/mcps.json`, as JSON `[{ "name", "serve", "database", "scopes" }]`, which the chart renders. `bootstrap` refuses an invalid name, a value outside `toolbox`, `standalone` and `both` or `shared` and `own`, or a name listed twice; `register` refuses an entry without `scopes`; each names the variable |
| `OPS_ID_URL` | `register`, `make-admin` | Answerable ID's origin |
| `OPS_ID_TOKEN` | `register` | A staff token (`docs/id/onboard`), used over the root secret to mint or rotate `register`'s own client when `ops-id-client` is empty and ID refuses the root secret. The chart reads it from the `ops-staff-token` Secret (key `OPS_ID_TOKEN`) when that exists |
| `OPS_ID_ROOT_SECRET` | `register`, `make-admin` | ID's root secret, with which `register`'s first run mints its own client, and `make-admin` always runs. The chart reads it from `id-env`'s `ROOT_ADMIN_SECRET` |
| `OPS_TOOLBOX_URL`, `OPS_ADMIN_MCP_URL` | `register` | The Toolbox's and the admin MCP's origins |
| `OPS_MCP_URL` | `register` | The origin of the MCPs the Toolbox serves alone, `https://mcp.<zone>`: each standalone or both MCP is the resource `<origin>/<name>/mcp` |
| `OPS_PLATFORM_SLUG` | `register`, `make-admin` | The platform organisation's slug. Default `answerable` |
| `OPS_CLAUDE_CALLBACK_PORT` | `register` | Claude Code's `--callback-port` in the host clients' redirect URI. Default `47700` |
| `OPS_START_DEPLOYMENTS` | `register` | `name=replicas,…`: Deployments to scale up from zero once their client secrets exist |
| `OPS_STAFF_DOMAIN`, `OPS_ENTRA_TENANT` | `register` | The staff email domain (`answerable.org`) and the staff directory's Entra tenant ID, a GUID; both or neither. The chart sets them from `id.staffDomain` and `id.entraTenant` |
| `OPS_ADMIN_EMAIL` | `make-admin` | The staff member's email. The chart sets it from `ops.adminEmail` |

## Bootstrap

- **The database's certificate authority.** When the ConfigMap `postgres-ca` does not exist, `bootstrap` connects to the administrative URL's host and port, sends PostgreSQL's SSLRequest and, on `S`, a TLS 1.2 ClientHello, reads the certificates the database presents (TLS 1.2 sends them in the clear; Bun's TLS client would show the leaf alone), and hangs up. It keeps the chain's self-signed root, or the topmost certificate when no root is presented, writes it as the ConfigMap's `ca.pem`, and logs its subject, issuer, validity and SHA-256 fingerprint, the names the database's certificate carries and whether they cover the host. This is trust on first use: compare the fingerprint with what Civo shows where it shows one. A database that answers `N` serves no TLS, and `bootstrap` stops there, saying so. The ConfigMap is not Helm's: it stays across upgrades. To fetch it again, delete it and run `bootstrap`.
- **The connection.** `bootstrap` then connects with the administrative URL, `sslmode=verify-full`, and that certificate as `sslrootcert`, in a file only it reads, deleted when it is done; and, for the MCPs, with the same login to `answerable_mcps` and to each own MCP's database. Each is one connection, held to the end, so that provisioning's transaction runs on it. The Job does not mount `postgres-ca`, so it runs before the ConfigMap exists.
- **Logins.** The owner login (`answerable_<name>_owner`) migrates; the runtime login (`answerable_<name>_runtime`) serves, with `NOCREATEDB NOCREATEROLE NOINHERIT`. A login whose Secret holds a URL gets that URL's password (`ALTER ROLE`) and nothing is written; a login whose Secret is empty gets 32 random bytes, base64url, and its URL is written. A login with `SUPERUSER`, `REPLICATION` or `BYPASSRLS` stops the run: only a superuser can clear those.
- **The databases.** ID's, the Toolbox's and the admin MCP's (`answerable_<name>`, with `answerable_<name>_owner` and `answerable_<name>_runtime`); the shared MCP database, `answerable_mcps`, owned by `answerable_mcps_migrator` and served by `answerable_mcps_toolbox`; and, for each `own` MCP of the list, `answerable_mcp_<name>` with `answerable_mcp_<name>_owner` and `answerable_mcp_<name>_runtime`. Each is owned by its owner login, so that the migrations' revokes of `CREATE` and `TEMP` take effect; the administrative login is granted the owner role first, as PostgreSQL 16 and later require. `CONNECT` is revoked from `PUBLIC` and granted to the serving logins, without `TEMP`. The migrations grant them their table privileges.
- **The MCPs** (`@answerable/mcp-postgres`). In `answerable_mcps`, `provisionMcps` makes each `shared` MCP's schema `<name>`, its `NOLOGIN` owner role `mcp_<name>_owner` and runtime role `mcp_<name>`, gives the migrator the owner role and the Toolbox's serving login, which serves every MCP whatever its `serve`, the runtime role, all `WITH INHERIT FALSE, SET TRUE`. The administrative login takes each owner role the same way, so it inherits none. In each own MCP's database, `provisionOwnMcp` makes schema `<name>` with `USAGE` for its runtime login. An MCP removed from the list keeps what it had.
- **The Secrets.** `id-database-owner` (`DATABASE_MIGRATION_URL`), `id-database` (`DATABASE_URL`), and the same pairs for `toolbox-` and `admin-` (`TOOLBOX_DATABASE_MIGRATION_URL`, `TOOLBOX_DATABASE_URL`, and the `ADMIN_` equivalents); `mcps-database-owner` (`MCPS_DATABASE_MIGRATION_URL`) and `toolbox-mcps-database` (`TOOLBOX_MCPS_DATABASE_URL`); and per own MCP `mcp-<name>-database-owner` (`DATABASE_MIGRATION_URL`) and `mcp-<name>-database` (`DATABASE_URL`). Each URL ends `?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`. The chart's ops Role names exactly these, from the same list.

A rotated password: empty the key of its Secret, then ship a tag; the deploy's `bootstrap` sets the new password ([Rotate](../README.md#rotate)).

## Register

- **Its own client.** `register` reads `ops-id-client` (`OPS_ID_CLIENT_SECRET`) first. With a secret there, it gets a `client_credentials` token for ID's admin API as `ops-register` (`platform:read platform:write`) and registers with it, renewed a minute before it expires; it needs no root secret or staff token. With none, it takes `OPS_ID_TOKEN`, else `OPS_ID_ROOT_SECRET`, mints `ops-register` with it (a client of the platform organisation, its link to ID's admin API and its capability there, keys `ops-register-v1`, `ops-register-link-v1-r<revision>`, `ops-register-capability-v1`), stores the secret the moment ID answers it, and goes on as `ops-register`. A client that exists while `ops-id-client` is empty gets a new secret from that bearer (`rotate-secret`).
- **What it registers,** in the order and with the `Idempotency-Key`s of `apps/web/content/docs/toolbox/admin.mdx` and `apps/web/content/docs/admin/setup.mdx`: the Toolbox's resource, admin resource, machine client `toolbox-hub` and Claude Code client; the admin MCP's resource, Claude Code client, the platform organisation's access, a group per role and machine client `admin-mcp`; then, for each `standalone` or `both` MCP of `OPS_MCPS`, which the Toolbox serves alone, its resource `<OPS_MCP_URL>/<name>/mcp` (`platform_shared`, the MCP's scopes and `offline_access`, 900-second tokens, key `mcp-<name>-resource-v1`), its Claude Code client `claude-code-<name>` (public, `authorization_code` and `refresh_token`, the callback on `OPS_CLAUDE_CALLBACK_PORT`, `openid offline_access` and the MCP's scopes, key `claude-code-<name>-v1`) and their link. The Toolbox's staff client (`toolbox-staff`) is the operator's and is left out.
- **Compare, then change.** Each resource and client is read first. One ID lacks is created with its key. One that differs is changed with `If-Match` on the ETag just read, under `<key>-r<revision>`, in the fields that differ: a resource's name, token lifetime and scopes; a client's name, redirect URIs and scopes. Scopes and redirect URIs only widen: the union of what ID holds and what is declared, so what the Toolbox's enable call added to its resource stays. An MCP's own resource follows its manifest: a scope the manifest dropped stops being allowed, and the log says so. A link the client's read lacks is made under `<key>-r<revision>` of the client. Capabilities, entitlements and groups are created when missing; a conflict means someone made them. An MCP removed from the list keeps its rows, and `register` no longer reads them. `src/registrar.ts` does this reading, making and changing; `bun mcp setup` and `bun mcp dev` register the local ID with the same module, so the two never differ.
- **Secrets.** `ops-register`'s secret goes to `ops-id-client` (`OPS_ID_CLIENT_SECRET`), `toolbox-hub`'s to `toolbox-id-client` (`TOOLBOX_ID_CLIENT_SECRET`), `admin-mcp`'s to `admin-id-client` (`ADMIN_ID_CLIENT_SECRET`), the moment ID answers each. A client that exists while its Secret is empty gets a new secret (`rotate-secret`).
- **The servers.** The chart runs the Toolbox and the admin MCP at zero replicas until their client Secret exists; `register` scales them up (`OPS_START_DEPLOYMENTS`).
- **The staff directory.** With `OPS_STAFF_DOMAIN` and `OPS_ENTRA_TENANT`, the calls and keys of `apps/web/content/docs/id/onboard.mdx` § First run, step 3: the domain on the platform organisation (`platform-domain-setup`), the tenant as its SSO provider through Answerable's Microsoft application (`platform-sso-setup`, `If-None-Match: *`), and the connectivity test, logged. An equal domain or provider is left as it is. When ID has no Microsoft client it says so and goes on; a different provider is left as it is, with a warning, since replacing it signs everyone out.
- **Next.** It logs one line per row it made or changed and a summary, `Registered in <seconds> s: <n> created, <n> changed, <n> as declared already; <n> standalone MCPs`, then the `claude mcp add` commands, one per standalone MCP among them, and the first owner's step: sign in once, then `make-admin`.

Against the fake ID (`src/testing.ts`), a run at 200 standalone MCPs makes 1,041 calls the first time and 426 when nothing changed: five per MCP, then two reads.

| Error | Meaning | What to do |
| --- | --- | --- |
| `register has no machine client of its own yet (the Secret ops-id-client is empty), and ID refuses the root secret (root_locked)` | A person is a platform administrator, and `ops-register` was never minted, or its secret was emptied | Once: put a staff token in the `ops-staff-token` Secret (key `OPS_ID_TOKEN`) and run again; delete the Secret afterwards |
| `register has no machine client of its own yet …, and no root secret or staff token to mint one` | Neither `OPS_ID_TOKEN` nor `OPS_ID_ROOT_SECRET` is set | The same |
| `ID refused ops-register's client credentials …` | `ops-id-client` holds a secret ID does not hold | Empty its key, then the same |
| `PATCH … (Idempotency-Key …-r<n>) answered 412 revision_mismatch` | Someone changed the row between `register`'s read and its change | Run again |
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
