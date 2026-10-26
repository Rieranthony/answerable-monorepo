# The kind stack

`bun run infra:test` builds the images of `infra/pipeline/images.json`, runs them in a local kind cluster with `charts/platform` and `charts/answerable` as a cloud runs them, and proves that the deployment behaves as production must. It deletes the cluster at the end, on failure and on Ctrl-C. CI runs it in the `containers` job of `ci.yml`.

## What it needs

- Docker, kind, kubectl, Helm 4, kubeconform (the versions CI pins: `.github/workflows/ci.yml`) and the system `openssl` (OpenSSL 3, or LibreSSL 3.3 on a Mac).
- Playwright's Chromium: `cd packages/acceptance && bun x playwright install chromium` (`--with-deps` on Linux).
- Public DNS for `*.127-0-0-1.sslip.io`, which answers `127.0.0.1`.
- Free ports on this host: `127.0.0.1:48443` (Traefik), `[::1]:48443` (the browser's edge), `47710` and `47711` (the company directories) and `47700` (the OAuth callback).
- No cluster named `answerable-local`. One stack per machine at a time.

## What it does, in order

1. **Build** the `id`, `mcps` and `ops` images (`infra/pipeline/images.json`), while the cluster comes up.
2. **Create** the cluster (`kind.yaml`) and the namespaces `platform`, `database` and `answerable` (restricted Pod Security Standard), as Terraform does in a cloud.
3. **Start the company directories** on this host (`apps/id/scripts/stack-directories.ts`): the platform organisation's stand-in for Entra or Google on port 47710, whose staff member signs in up to three times, and a client organisation's on 47711, whose person signs in once. The browser reaches them at `127.0.0.1`; ID's pods reach them at `host.docker.internal` (Docker Desktop) or at kind's network gateway (Linux).
4. **Make the certificates** with `openssl`, in the run's temporary directory, each ECDSA P-256: three authorities (the stack's own, the stand-in for Cloudflare's origin-pull CA, the database's) and the certificates they sign (the four public names, the origin-pull client certificate, the database server's).
5. **Start the database and the edge, and install `charts/platform`.** PostgreSQL 17, TLS only, presenting its certificate and its authority's, holding one administrative login (`dbadmin`, `CREATEDB CREATEROLE`, not a superuser) as a managed database starts (`database.yaml`). The edge is an nginx beside Traefik that plays Cloudflare: it presents the origin-pull certificate (`edge.yaml`, `platform-edge.yaml`). The platform release gets the stand-in's origin-pull CA as `originPull.caPem`, as Terraform passes Cloudflare's, so the chart renders `answerable/cloudflare-origin-pull-ca` as it does on Civo.
6. **Install `charts/answerable` with `ops.bootstrap=true`.** The test first writes what Terraform writes on Civo, the ConfigMap `trusted-proxies` (`127.0.0.1/32`), the Secrets `postgres-admin` and `origin-tls` (the stack CA's certificate for the four names), and what the deploy writes, `id-env`. The `ops-bootstrap` Job fetches the database's certificate into the ConfigMap `postgres-ca` (trust on first use), creates the databases and their logins, provisions the MCPs of `charts/answerable/mcps.json` and writes the URL Secrets; the migrations run, `toolbox-migrate` migrating every MCP after the Toolbox's database; ID starts. The Toolbox and the admin MCP wait at zero replicas: their client Secrets do not exist yet.
7. **Upgrade with `ops.register=true`**, as the first deploy does. The `ops-register` Job mints its own machine client, `ops-register`, with the root secret and goes on as it: it registers the Toolbox, the admin MCP and each standalone MCP in ID, writes the three client Secrets and scales the servers up, and adds the staff domain (`id.staffDomain`); ID has no Microsoft client here, so it skips the Entra provider (`id.entraTenant`) with a line.
8. **Give the client organisation its domain and directory** with the root secret, as an operator does before the lock.

## What it proves

| Area | Proofs |
| --- | --- |
| Images | Run as `bun` (uid 1000), `NODE_ENV=production`, no test, environment, coverage or Markdown file |
| Through Traefik | ID's health, readiness, discovery and keys; the Toolbox's challenge and metadata |
| The edge | No client certificate, or one Cloudflare's CA did not sign, is refused; strict SNI; a forged `X-Forwarded-For` is dropped; a pod's own address survives the trusted edge |
| Inside the cluster | ID refuses `/auth` that bypasses Traefik; NetworkPolicies; Postgres TLS only, verified with `sslrootcert` (Bun and `pg`); the platform organisation provisioned then verified; the origin-pull CA rendered by the platform chart from `originPull.caPem`; the database's CA in `postgres-ca` written by the bootstrap, equal to the one the stack made, its fingerprint in the Job's log; every migration and ops Job succeeded |
| The ops Jobs | Each database owned by its owner login; the serving logins restricted, with `CONNECT` and without `TEMP`; nothing for `PUBLIC`; every URL with a 32-byte password; the client secrets stored; the servers started; no log prints a generated value |
| The MCPs of `mcps.json` | The bootstrap made each shared MCP's schema, owned by the migrator, with `USAGE` for the Toolbox's serving login, which is a member of no role, and no role named after an MCP; `toolbox-migrate` migrated each as the migrator, which owns its tables, and logged its time; the Toolbox's `/health` lists every MCP; through Traefik on `mcp`, each `standalone` and `both` MCP answers 401 at `/<name>/mcp` naming its metadata, which names its resource and ID, and nothing else on that host is routed; inside the cluster, under another host, the SDK's Host check refuses each MCP's path and the hub; the deploy's smoke test, generated from the list, passes |
| Machine tokens | The admin MCP's client gets a `toolbox:admin` token from ID and lists the Toolbox's providers |
| Staff sign-in | `register` put the staff domain on the platform organisation; the test connects the company directory through the admin API; a staff member signs in with Chromium through Traefik and the directory; the official MCP client calls `admin_whoami` with no role, root makes them owner, and the next call shows `owner` |
| Running again | `bootstrap` and `register` once more change no Secret, rotate nothing and keep every password |
| Fails closed | The `default` TLS option, the only one, keeps every host closed: no Ingress names an option or an issuer, each serves `origin-tls`, and without the option the host opens |
| First administrator | `make-admin` puts the signed-in member in `platform-admins` (the owner group already), and ID refuses the root secret afterwards |
| After the lock, a new standalone MCP | A next release in which `example` is served `both`: a copy of the chart whose list `bun mcp`'s generator writes, and the stack's `mcps` image with the Toolbox's new list (`ghcr.io/rieranthony/answerable/mcps-next:local`, removed by that name at the end). Deployed with bootstrap and register on, `ops-register` registers `example`'s resource, its Claude Code client and their link as itself, which ID's audit log confirms, and the root secret stays refused; the smoke test of the new list passes. Then, in a process of its own (`standalone-sign-in.ts`), the staff member signs in to the admin MCP and commits `standalone_enable` for the client organisation with `everyone: true`; the client organisation's person signs in to `example` through `claude-code-example` with the official MCP client and calls `example_status`; the staff member, whose organisation nobody enabled, is refused at ID's organisation chooser |

The run prints each step's wall-clock time at the end, and register's own duration, from its log, after the first run and after the lock.

**The browser's edge.** Traefik demands Cloudflare's client certificate of every visitor, a browser included. Playwright's `clientCertificates` hang under Bun (the same script under Node works), so the sign-in sends Chromium to a small proxy instead (`startBrowserEdge` in `stack.ts`): Chromium maps the four names to `[::1]` (`--host-resolver-rules`), and the proxy forwards each request to Traefik with the origin-pull certificate, as Cloudflare does. The MCP client calls Traefik directly with the certificate. The sign-in runs in a process of its own (`sign-in.ts`): Chromium launched and closed inside the test's Bun process broke later children's pipes (a `kubectl` killed by SIGPIPE), and the test runs `kubectl` and Helm after it.

## When it fails

- **Each step** prints a line when it starts and when it ends (`[stack] run the ops register: done in 16.1 s`), so a log that stops shows where.
- **Each Helm install or upgrade** runs with `--debug` and `--timeout 5m`, inside the slowest test's 10 minutes. When it fails, the stack prints the last 60 lines of Helm's log, which name the hook or resource it waited for and its status, and then the diagnosis.
- **The diagnosis** (`diagnose` in `stack.ts`) contains:
  - every pod, and the `answerable` namespace's events in order;
  - a `describe` of each pod that is not ready and each Job that is not complete;
  - the ops and migration Jobs' logs;
  - the database's sessions, with what blocks them (passwords masked);
  - both releases' history;
  - `kubectl describe node`, with the allocated requests.
- **A long test still running** shortly before its timeout prints the same diagnosis.

## A node the size of a CI runner

`INFRA_STACK_CPUS=4 bun run infra:test` gives the node 4 allocatable CPUs, as on a 4-CPU CI runner. The kubelet reserves the rest of Docker's CPUs, and the node's container is held to 4 CPUs of time.

## Keep the cluster for a look

```bash
INFRA_STACK_KEEP=1 bun run infra:test
kind export kubeconfig --name answerable-local --kubeconfig /tmp/answerable-local
KUBECONFIG=/tmp/answerable-local kubectl -n answerable get pods
kind delete cluster --name answerable-local   # when done
```

The company directory stops with the test, so a kept cluster cannot sign anyone in again. Traefik demands Cloudflare's client certificate, so Claude Code cannot connect to the stack either: try Claude Code against the admin lane (`apps/web/content/docs/admin/setup.mdx`).
