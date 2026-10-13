# The kind stack

`bun run infra:test` builds the four images, runs them in a local kind cluster with `charts/platform` and `charts/answerable` as a cloud runs them, and proves that the deployment behaves as production must. It deletes the cluster at the end, on failure and on Ctrl-C. CI runs it in the `containers` job of `ci.yml`.

## What it needs

- Docker, kind, kubectl, Helm 4 and kubeconform (the versions CI pins: `.github/workflows/ci.yml`).
- Playwright's Chromium: `cd packages/acceptance && bun x playwright install chromium` (`--with-deps` on Linux).
- Public DNS for `*.127-0-0-1.sslip.io`, which answers `127.0.0.1`.
- Free ports on this host: `127.0.0.1:48443` (Traefik), `[::1]:48443` (the browser's edge), `47710` (the company directory) and `47700` (the OAuth callback).
- No cluster named `answerable-local`. One stack per machine at a time.

## What it does, in order

1. **Build** the `id`, `toolbox`, `admin-mcp` and `ops` images, while the cluster comes up.
2. **Create** the cluster (`kind.yaml`) and the namespaces `platform`, `database` and `answerable` (restricted Pod Security Standard), as Terraform does in a cloud.
3. **Start the company directory** on this host (`apps/id/scripts/stack-directories.ts`, port 47710), the platform organisation's stand-in for Entra or Google. The browser reaches it at `127.0.0.1`; ID's pods reach it at `host.docker.internal` (Docker Desktop) or at kind's network gateway (Linux).
4. **Install `charts/platform`**: Traefik, cert-manager and the stack's own certificate authority.
5. **Start the database and the edge.** PostgreSQL 17, TLS only, holding one administrative login (`dbadmin`, `CREATEDB CREATEROLE`, not a superuser) as a managed database starts (`database.yaml`). The edge is an nginx beside Traefik that plays Cloudflare: it presents the origin-pull certificate (`edge.yaml`, `platform-edge.yaml`).
6. **Install `charts/answerable` with `ops.bootstrap=true`.** The test applies what the deploy applies from the sops file in a cloud: `id-env`, `postgres-admin`, the origin-pull CA and the database CA. The `ops-bootstrap` Job creates the three databases and six logins and writes their URL Secrets; the migrations run; ID starts. The Toolbox and the admin MCP wait at zero replicas: their client Secrets do not exist yet.
7. **Upgrade with `ops.register=true`**, as `deploy.ts run-job register` does. The `ops-register` Job registers both servers in ID with the root secret, writes their client Secrets and scales them up.

## What it proves

| Area | Proofs |
| --- | --- |
| Images | Run as `bun` (uid 1000), `NODE_ENV=production`, no test, environment, coverage or Markdown file |
| Through Traefik | ID's health, readiness, discovery and keys; the Toolbox's challenge and metadata |
| The edge | No client certificate, or one Cloudflare's CA did not sign, is refused; strict SNI; a forged `X-Forwarded-For` is dropped; a pod's own address survives the trusted edge |
| Inside the cluster | ID refuses `/auth` that bypasses Traefik; NetworkPolicies; Postgres TLS only, verified with `sslrootcert` (Bun and `pg`); the platform organisation provisioned then verified; every migration and ops Job succeeded |
| The ops Jobs | Each database owned by its owner login; the runtime logins restricted, with `CONNECT` and without `TEMP`; nothing for `PUBLIC`; six URLs with 32-byte passwords; the client secrets stored; the two servers started; no log prints a generated value |
| Machine tokens | The admin MCP's client gets a `toolbox:admin` token from ID and lists the Toolbox's providers |
| Staff sign-in | The platform organisation gets its domain and SSO provider through the admin API; a staff member signs in with Chromium through Traefik and the directory; the official MCP client calls `admin_whoami` with no role, root makes them owner, and the next call shows `owner` |
| Running again | `bootstrap` and `register` once more change no Secret, rotate nothing and keep every password |
| Fails closed | Each of the two TLS options alone still demands Cloudflare's certificate |

The run prints each step's wall-clock time at the end.

**The browser's edge.** Traefik demands Cloudflare's client certificate of every visitor, a browser included. Playwright's `clientCertificates` hang under Bun (the same script under Node works), so the sign-in sends Chromium to a small proxy in the test process instead (`startBrowserEdge` in `stack.ts`): Chromium maps the three names to `[::1]` (`--host-resolver-rules`), and the proxy forwards each request to Traefik with the origin-pull certificate, as Cloudflare does. The MCP client in the test process calls Traefik directly with the certificate.

## Keep the cluster for a look

```bash
INFRA_STACK_KEEP=1 bun run infra:test
kind export kubeconfig --name answerable-local --kubeconfig /tmp/answerable-local
KUBECONFIG=/tmp/answerable-local kubectl -n answerable get pods
kind delete cluster --name answerable-local   # when done
```

The company directory stops with the test, so a kept cluster cannot sign anyone in again. Traefik demands Cloudflare's client certificate, so Claude Code cannot connect to the stack either: try Claude Code against the admin lane (`apps/web/content/docs/admin/setup.mdx`).
