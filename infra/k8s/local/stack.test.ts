import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Admin, setSsoProvider } from "@answerable/acceptance"
import { X509Certificate } from "node:crypto"
import type { SignInInput } from "./sign-in"
import { databaseAdmin, exec, hosts, image, images, origin, type Stack, startStack, step, timings } from "./stack"

// bun run infra:test: the four images, a kind cluster with charts/platform and charts/answerable as a cloud runs them,
// a TLS-only PostgreSQL 17 holding only an administrative login, the ops Jobs that bootstrap the databases and register
// the servers in ID, a staff member's sign-in through the cluster, and the proofs that the stack behaves as production
// must. Needs Docker, kind, kubectl and helm, Playwright's Chromium (cd packages/acceptance && bun x playwright install
// chromium), ports 47700, 47710 and [::1]:48443 on this host, and public DNS for *.127-0-0-1.sslip.io. Deletes its cluster at the end,
// on failure and on Ctrl-C; set INFRA_STACK_KEEP=1 to keep it for a look (then delete it with kind delete cluster --name
// answerable-local).

let stack: Stack | undefined
const started = performance.now()

// The acceptance kit stops what it opened on Ctrl-C and exits at once, before the cluster is deleted: this file's handler
// replaces it, and the process's exit ends the servers the kit started.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.removeAllListeners(signal)
  process.on(signal, () => void (stack?.stop() ?? Promise.resolve()).finally(() => process.exit(code)))
}

// The hooks and tests take bun test's --timeout, which the workspace's test script sets to 30 minutes.
beforeAll(async () => {
  stack = await startStack()
  // The Deployments are rolled out by now, but Traefik routes to a pod only once its provider has seen the new endpoints,
  // a moment after the pod turns Ready: on GitHub's runner the Toolbox's first health call through the edge got Traefik's
  // own answer instead. Wait until each server answers through the edge, as a visitor will reach it, before any test.
  for (const url of [`${origin(hosts.id)}/readyz`, `${origin(hosts.toolbox)}/health`, `${origin(hosts.adminMcp)}/health`]) await untilServed(url)
})

/** Wait up to `ms` for `url`, through the edge, to answer 200 with `{ status: "ok" }`; otherwise diagnose the cluster and fail, naming the last answer. */
async function untilServed(url: string, ms = 90_000) {
  let last = "no answer"
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(1000)) {
    try {
      const response = await viaIngress(url)
      const body = await response.text()
      if (response.status === 200 && body.includes('"ok"')) return
      last = `${response.status} ${body.slice(0, 120)}`
    } catch (error) {
      last = (error as Error).message
    }
  }
  await stack!.diagnose(`${url} did not answer through the edge within ${ms / 1000} s`)
  throw new Error(`${url} did not answer { status: "ok" } through the edge within ${ms / 1000} s; last: ${last}`)
}

/**
 * Wait until `url` answers 200 through the edge `times` times in a row, each within 2 s. After a rollout Traefik sends
 * requests to the old pod's address for a moment (measured: 2.5 s in kind after `rollout status`), and the old pod, which
 * stops within a second of SIGTERM, is gone, so such a request hangs until Traefik's 30-second dial timeout.
 */
async function untilSettled(url: string, times = 8, ms = 60_000) {
  let streak = 0
  for (const deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(250)) {
    const answered = await viaIngress(url, { signal: AbortSignal.timeout(2000) }).then(response => response.status === 200, () => false)
    streak = answered ? streak + 1 : 0
    if (streak >= times) return
  }
  throw new Error(`${url} did not answer ${times} times in a row through the edge within ${ms / 1000} s`)
}

afterAll(async () => {
  await stack?.stop()
  const total = Math.round((performance.now() - started) / 1000)
  console.log(`\nThe stack, step by step (seconds): ${timings.map(([name, seconds]) => `${name} ${seconds}`).join("; ")}; everything ${total}`)
})

/** A request through Traefik, as Cloudflare makes it: the origin-pull client certificate, the stack's CA trusted. One that hangs fails after 30 seconds. */
function viaIngress(url: string, init: RequestInit = {}, certificate: { cert: string; key: string } | null = stack!.originPullCert) {
  return fetch(url, { signal: AbortSignal.timeout(30_000), ...init, tls: { ca: stack!.stackCa, ...(certificate ?? {}) }, redirect: "manual" })
}

/**
 * A long test's body, watched: still running after `ms`, shortly before bun test's own timeout ends it without a word, it
 * prints the cluster's diagnosis, so that a hang explains itself in the log.
 */
async function watched<T>(name: string, ms: number, body: () => Promise<T>) {
  const timer = setTimeout(() => void stack!.diagnose(`"${name}" is still running after ${ms / 1000} s`), ms)
  try {
    return await body()
  } finally {
    clearTimeout(timer)
  }
}

/** Run a script with Bun in a running pod of a Deployment and return its last line of output, parsed. */
async function inPod(deployment: string, directory: string, script: string) {
  const { stdout } = await stack!.kubectl(["exec", "-n", "answerable", `deploy/${deployment}`, "-c", deployment, "--", "bun", "--cwd", directory, "-e", script])
  return JSON.parse(stdout.trim().split("\n").at(-1)!)
}

/** A script in ID's pod. ID's image carries its bundles and no node_modules, so the script is bundled here, from apps/id
 * (its imports resolve to the versions ID bundles), and read from standard input. */
async function inIdPod(script: string) {
  const entry = new URL(`../../../apps/id/.stack-probe-${crypto.randomUUID()}.ts`, import.meta.url).pathname
  await Bun.write(entry, script)
  try {
    const build = await Bun.build({ entrypoints: [entry], target: "bun" })
    if (!build.success) throw new AggregateError(build.logs, "Bundling the probe for ID's pod failed")
    const program = await build.outputs[0]!.text()
    const { stdout } = await stack!.kubectl(["exec", "-i", "-n", "answerable", "deploy/id", "-c", "id", "--", "bun", "--no-install", "run", "-"], { stdin: program })
    return JSON.parse(stdout.trim().split("\n").at(-1)!)
  } finally {
    await Bun.file(entry).delete()
  }
}

describe("the images", () => {
  test("run as bun, not root, and carry no test, environment, coverage or documentation file", async () => {
    for (const { name } of images) {
      const config = JSON.parse((await exec(["docker", "image", "inspect", image(name), "--format", "{{json .Config}}"])).stdout)
      expect(config.User, name).toBe("bun")
      expect(config.Env, name).toContain("NODE_ENV=production")
      const { stdout } = await exec(["docker", "run", "--rm", "--entrypoint", "find", image(name), "/app", "-path", "*/node_modules", "-prune", "-o",
        "(", "-name", "*.test.ts", "-o", "-name", ".env*", "-o", "-name", "coverage", "-o", "-name", "*.md", "-o", "-name", ".git", ")", "-print"])
      expect(stdout.trim(), name).toBe("")
      const { stdout: user } = await exec(["docker", "run", "--rm", "--entrypoint", "id", image(name), "-u"])
      expect(user.trim(), name).toBe("1000")
    }
  })
})

describe("through Traefik, with Cloudflare's origin-pull certificate", () => {
  test("ID answers health, readiness, discovery naming its issuer and its signing keys, and serves /auth to a visitor", async () => {
    const issuer = origin(hosts.id)
    expect(await (await viaIngress(`${issuer}/healthz`)).json()).toEqual({ status: "ok" })
    expect(await (await viaIngress(`${issuer}/readyz`)).json()).toEqual({ status: "ok" })
    const discovery = await (await viaIngress(`${issuer}/.well-known/openid-configuration`)).json() as { issuer: string; jwks_uri: string }
    expect(discovery.issuer).toBe(issuer)
    const jwks = await (await viaIngress(discovery.jwks_uri)).json() as { keys: unknown[] }
    expect(jwks.keys.length).toBeGreaterThan(0)
    const session = await viaIngress(`${issuer}/auth/get-session`)
    expect(session.status).toBe(200)
  })

  test("the Toolbox answers health, and challenges a call without a token with metadata naming ID", async () => {
    const toolbox = origin(hosts.toolbox)
    expect(await (await viaIngress(`${toolbox}/health`)).json()).toEqual({ status: "ok" })
    const challenge = await viaIngress(`${toolbox}/mcp`)
    expect(challenge.status).toBe(401)
    const metadataUrl = `${toolbox}/.well-known/oauth-protected-resource/mcp`
    expect(challenge.headers.get("www-authenticate")).toContain(metadataUrl)
    const metadata = await (await viaIngress(metadataUrl)).json() as { resource: string; authorization_servers: string[] }
    expect(metadata).toMatchObject({ resource: `${toolbox}/mcp`, authorization_servers: [origin(hosts.id)] })
  })

})

/** A request from a fresh process, which has no TLS session of this one's to resume. */
async function freshRequest(url: string, certificate: { cert: string; key: string } | null) {
  const script = `try { const r = await fetch(process.env.URL, { tls: JSON.parse(process.env.TLS) }); console.log(JSON.stringify({ status: r.status })) } catch (error) { console.log(JSON.stringify({ error: error.code ?? error.message })) }`
  const tls = JSON.stringify({ ca: stack!.stackCa, ...(certificate ?? {}) })
  const { stdout } = await exec([process.execPath, "-e", script], { env: { ...process.env, URL: url, TLS: tls } })
  return JSON.parse(stdout.trim()) as { status?: number; error?: string }
}

describe("the edge's checks", () => {
  test("Traefik refuses the TLS handshake without a client certificate, or with one Cloudflare's CA did not sign", async () => {
    // Each from a fresh process: this one's fetch would resume the TLS sessions its earlier requests opened with the
    // origin-pull certificate, which a server accepts as verified.
    expect(await freshRequest(`${origin(hosts.id)}/healthz`, stack!.originPullCert)).toEqual({ status: 200 })
    // The edge's own certificate is one Cloudflare's CA did not sign.
    for (const certificate of [null, stack!.edgeCert]) {
      const outcome = await freshRequest(`${origin(hosts.id)}/healthz`, certificate)
      expect(outcome.status).toBeUndefined()
      expect(outcome.error).toEqual(expect.any(String))
    }
  })

  test("a server name with no certificate is refused even with the client certificate (strict SNI)", async () => {
    const outcome = await freshRequest(`https://unknown.127-0-0-1.sslip.io:48443/healthz`, stack!.originPullCert)
    expect(outcome.status).toBeUndefined()
    expect(outcome.error).toEqual(expect.any(String))
  })

  test("a forged X-Forwarded-For through Traefik does not change the address ID records: Traefik drops it and appends its peer", async () => {
    const issuer = origin(hosts.id)
    const created: Record<string, string> = {}
    for (const [label, forged] of [["plain", undefined], ["forged", "203.0.113.66"]] as const) {
      const requestId = `infra-stack-${label}-${Date.now()}`
      const response = await viaIngress(`${issuer}/api/admin/v1/organizations`, {
        method: "POST",
        headers: { authorization: `Bearer ${stack!.secrets.rootAdminSecret}`, "content-type": "application/json", "idempotency-key": requestId, "x-request-id": requestId, ...(forged ? { "x-forwarded-for": forged } : {}) },
        body: JSON.stringify({ slug: `stack-${label}`, name: `Stack ${label}` }),
      })
      expect(response.status, await response.clone().text()).toBeLessThan(300)
      created[label] = requestId
    }
    const events = await (await viaIngress(`${issuer}/api/admin/v1/audit-events?limit=200`, { headers: { authorization: `Bearer ${stack!.secrets.rootAdminSecret}` } })).json() as { items: { requestId: string | null; ip: string | null }[] }
    const ipOf = (requestId: string) => events.items.find(event => event.requestId === requestId)?.ip
    // The laptop reaches Traefik from the Docker network's gateway, the peer Traefik appends.
    expect(ipOf(created.plain!)).toBe(stack!.dockerGateway)
    expect(ipOf(created.forged!)).toBe(stack!.dockerGateway)
  })

  test("through the edge, a trusted hop, Traefik keeps X-Forwarded-For and ID records the calling pod's own address", async () => {
    const requestId = `infra-stack-pod-${Date.now()}`
    const result = await inPod("toolbox", "/app/mcps/toolbox", `
      const response = await fetch(process.env.TOOLBOX_ID_ISSUER + "/api/admin/v1/organizations", {
        method: "POST",
        headers: { authorization: "Bearer " + ${JSON.stringify(stack!.secrets.rootAdminSecret)}, "content-type": "application/json", "idempotency-key": ${JSON.stringify(requestId)}, "x-request-id": ${JSON.stringify(requestId)} },
        body: JSON.stringify({ slug: "stack-from-pod", name: "Stack from a pod" }),
      })
      console.log(JSON.stringify({ status: response.status }))`)
    expect(result.status).toBeLessThan(300)
    const { stdout } = await stack!.kubectl(["get", "pods", "-n", "answerable", "-l", "app.kubernetes.io/component=toolbox", "-o", "jsonpath={.items[0].status.podIP}"])
    const events = await (await viaIngress(`${origin(hosts.id)}/api/admin/v1/audit-events?limit=200`, { headers: { authorization: `Bearer ${stack!.secrets.rootAdminSecret}` } })).json() as { items: { requestId: string | null; ip: string | null }[] }
    expect(events.items.find(event => event.requestId === requestId)?.ip).toBe(stdout.trim())
  })
})

describe("inside the cluster", () => {
  test("ID refuses /auth to a caller that bypasses Traefik, and still answers health", async () => {
    const forward = Bun.spawn(["kubectl", "port-forward", "-n", "answerable", "svc/id", "47399:47300"], { env: { ...process.env, KUBECONFIG: stackKubeconfig() }, stdout: "pipe", stderr: "pipe" })
    try {
      const reader = forward.stdout.getReader()
      await reader.read()
      const refused = await fetch("http://127.0.0.1:47399/auth/get-session")
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ error: "untrusted_ingress" })
      expect(await (await fetch("http://127.0.0.1:47399/healthz")).json()).toEqual({ status: "ok" })
    } finally {
      forward.kill()
      await forward.exited
    }
  })

  test("the Toolbox reaches ID at its public issuer through the edge, and ID resolves its address rather than refusing it", async () => {
    const result = await inPod("toolbox", "/app/mcps/toolbox", `
      const issuer = process.env.TOOLBOX_ID_ISSUER
      const discovery = await (await fetch(issuer + "/.well-known/openid-configuration")).json()
      const token = await fetch(discovery.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa("nobody:wrong") }, body: "grant_type=client_credentials" })
      console.log(JSON.stringify({ issuer: discovery.issuer, tokenStatus: token.status }))`)
    expect(result.issuer).toBe(origin(hosts.id))
    // An unknown client is refused as a client (401), not as an untrusted ingress (403).
    expect(result.tokenStatus).toBe(401)
  })

  test("NetworkPolicies admit only Traefik to ID: the Toolbox cannot call ID's pods directly", async () => {
    const result = await inPod("toolbox", "/app/mcps/toolbox", `
      const outcome = await fetch("http://id.answerable.svc.cluster.local:47300/healthz", { signal: AbortSignal.timeout(4000) }).then(r => "answered " + r.status, e => "blocked: " + e.name)
      console.log(JSON.stringify({ outcome }))`)
    expect(result.outcome).toStartWith("blocked")
  })

  test("Postgres takes TLS only: Bun.SQL through connect verifies the server against the URL's sslrootcert; plain, a wrong authority and Bun alone fail", async () => {
    const result = await inPod("toolbox", "/app/mcps/toolbox", `
      import { connect } from "@answerable/mcp-postgres"
      import { SQL } from "bun"
      const url = process.env.TOOLBOX_DATABASE_URL
      const probe = async db => {
        try { const [row] = await db\`select ssl, current_user as login from pg_stat_ssl where pid = pg_backend_pid()\`; return "ssl=" + row.ssl + " as " + row.login }
        catch (error) { return "refused: " + error.message.split("\\n")[0] }
        finally { await Promise.race([db.close({ timeout: 0 }).catch(() => {}), Bun.sleep(500)]) }
      }
      const variant = change => { const parsed = new URL(url); change(parsed.searchParams); return parsed.toString() }
      console.log(JSON.stringify({
        verified: await probe(connect(url, { max: 1 })),
        plaintext: await probe(new SQL({ url: variant(params => { params.set("sslmode", "disable"); params.delete("sslrootcert") }), max: 1 })),
        wrongAuthority: await probe(connect(variant(params => params.set("sslrootcert", "/etc/ssl/extra/ca.pem")), { max: 1 })),
        bunAlone: await probe(new SQL({ url, max: 1 })),
      }))
      process.exit(0)`)
    // The Toolbox serves as its restricted runtime login, which its migration provisioned.
    expect(result.verified).toBe("ssl=true as answerable_toolbox_runtime")
    expect(result.plaintext).toContain("no encryption")
    // The database presents its root with its certificate, so a wrong authority meets a self-signed root it does not trust.
    expect(result.wrongAuthority).toMatch(/^refused: (self[- ]signed certificate in certificate chain|unable to verify)/)
    expect(result.bunAlone).toStartWith("refused")
  })

  test("Postgres takes TLS only: pg in ID verifies the server with verify-full and the URL's sslrootcert; plain and a wrong authority fail", async () => {
    const result = await inIdPod(`
      import pg from "pg"
      const url = process.env.DATABASE_URL
      const probe = async connectionString => {
        const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 })
        try { await client.connect(); const { rows } = await client.query("select ssl, current_user as login from pg_stat_ssl where pid = pg_backend_pid()"); return "ssl=" + rows[0].ssl + " as " + rows[0].login }
        catch (error) { return "refused: " + error.message.split("\\n")[0] }
        finally { await client.end().catch(() => {}) }
      }
      const variant = change => { const parsed = new URL(url); change(parsed.searchParams); return parsed.toString() }
      console.log(JSON.stringify({
        verified: await probe(url),
        plaintext: await probe(variant(params => { params.set("sslmode", "disable"); params.delete("sslrootcert") })),
        wrongAuthority: await probe(variant(params => params.set("sslrootcert", "/etc/ssl/extra/ca.pem"))),
      }))`)
    expect(result.verified).toBe("ssl=true as answerable_id_runtime")
    expect(result.plaintext).toContain("no encryption")
    expect(result.wrongAuthority).toMatch(/^refused: .*(self[- ]signed|unable to (verify|get))/)
  })

  test("ID provisions the platform organisation on its first start and verifies it on the next", async () => {
    const first = await stack!.kubectl(["logs", "-n", "answerable", "deploy/id", "-c", "id"])
    expect(first.stdout).toContain("platform organisation answerable: provisioned")
    await stack!.kubectl(["rollout", "restart", "-n", "answerable", "deploy/id"])
    await stack!.kubectl(["rollout", "status", "-n", "answerable", "deploy/id", "--timeout=180s"])
    // Every ID pod's log: the one the restart replaced may still be exiting.
    const next = await stack!.kubectl(["logs", "-n", "answerable", "-l", "app.kubernetes.io/component=id", "-c", "id", "--prefix", "--tail=-1"])
    expect(next.stdout).toContain("platform organisation answerable: verified")
    // The proofs after this one reach ID through Traefik, which follows the rollout a moment later.
    await untilSettled(`${origin(hosts.id)}/healthz`)
  }, 240_000)

  test("the origin-pull CA comes from the platform chart's originPull.caPem, as on Civo; the database's from the bootstrap's fetch, its fingerprint logged", async () => {
    const pull = JSON.parse((await stack!.kubectl(["get", "secret", "-n", "answerable", "cloudflare-origin-pull-ca", "-o", "json"])).stdout)
    expect(pull.metadata.annotations?.["meta.helm.sh/release-name"]).toBe("platform")
    expect(Buffer.from(pull.data["ca.crt"], "base64").toString()).toBe(stack!.certificates.originPullCa)
    // Written by the Job, trust on first use, not by Helm: it stays across upgrades.
    const database = JSON.parse((await stack!.kubectl(["get", "configmap", "-n", "answerable", "postgres-ca", "-o", "json"])).stdout)
    expect(database.metadata.labels?.["app.kubernetes.io/managed-by"]).toBe("answerable-ops")
    expect(database.metadata.annotations?.["meta.helm.sh/release-name"]).toBeUndefined()
    const fingerprint = new X509Certificate(stack!.certificates.databaseCa).fingerprint256
    expect(new X509Certificate(database.data["ca.pem"]).fingerprint256).toBe(fingerprint)
    const log = await jobLog("ops-bootstrap")
    expect(log).toContain("The database at postgres.database.svc.cluster.local:5432 presented 2 certificates:")
    expect(log).toContain("Wrote the ConfigMap postgres-ca (ca.pem): the self-signed root.")
    expect(log).toContain(`SHA-256:  ${fingerprint}`)
    expect(log).toContain("They cover postgres.database.svc.cluster.local, the host of OPS_DATABASE_ADMIN_URL.")
    expect(log).not.toContain("Warning")
  })

  test("the migrations and the two ops Jobs ran to completion as the release's hooks", async () => {
    const { stdout } = await stack!.kubectl(["get", "jobs", "-n", "answerable", "-o", "json"])
    const jobs = (JSON.parse(stdout) as { items: { metadata: { name: string }; status: { succeeded?: number } }[] }).items
    for (const name of ["id-migrate", "toolbox-migrate", "admin-migrate", "ops-bootstrap", "ops-register"]) expect(jobs.find(job => job.metadata.name === name)?.status.succeeded, name).toBe(1)
  })
})

/** ID's admin API as root, through Traefik, as `@answerable/acceptance`'s `Admin`: a fresh Idempotency-Key per call, a status outside 2xx throws. */
const rootAdmin: Admin = async (method, path, body, headers) => {
  const response = await viaIngress(`${origin(hosts.id)}/api/admin/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${stack!.secrets.rootAdminSecret}`, "idempotency-key": crypto.randomUUID(), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`)
  return text ? JSON.parse(text) : {}
}

/** Run SQL as the database's superuser over its local socket; the rows, one per line, columns joined by |. */
async function psql(sql: string) {
  const { stdout } = await stack!.kubectl(["exec", "-n", "database", "statefulset/postgres", "-c", "postgres", "--", "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql])
  return stdout.trim().split("\n")
}

/** The six URL Secrets the ops bootstrap writes, with their login and database. */
const urlSecrets = [
  ["id-database-owner", "DATABASE_MIGRATION_URL", "answerable_id_owner", "answerable_id"],
  ["id-database", "DATABASE_URL", "answerable_id_runtime", "answerable_id"],
  ["toolbox-database-owner", "TOOLBOX_DATABASE_MIGRATION_URL", "answerable_toolbox_owner", "answerable_toolbox"],
  ["toolbox-database", "TOOLBOX_DATABASE_URL", "answerable_toolbox_runtime", "answerable_toolbox"],
  ["admin-database-owner", "ADMIN_DATABASE_MIGRATION_URL", "answerable_admin_owner", "answerable_admin"],
  ["admin-database", "ADMIN_DATABASE_URL", "answerable_admin_runtime", "answerable_admin"],
] as const
const clientSecrets = [["toolbox-id-client", "TOOLBOX_ID_CLIENT_SECRET"], ["admin-id-client", "ADMIN_ID_CLIENT_SECRET"]] as const

/** Every value the ops Jobs generated, for checking that no log prints one. */
async function generatedValues() {
  const values: string[] = []
  for (const [name, key] of urlSecrets) values.push(decodeURIComponent(new URL((await stack!.readSecret("answerable", name))[key]!).password))
  for (const [name, key] of clientSecrets) values.push((await stack!.readSecret("answerable", name))[key]!)
  return values
}

const jobLog = async (job: string) => (await stack!.kubectl(["logs", "-n", "answerable", `job/${job}`])).stdout

describe("the ops Jobs", () => {
  test("bootstrap, with an administrative login that is not a superuser, made each database its owner's, with a restricted runtime login and nothing for PUBLIC", async () => {
    expect(await psql(`select rolsuper || '|' || rolcreatedb || '|' || rolcreaterole from pg_roles where rolname = '${databaseAdmin}'`)).toEqual(["false|true|true"])
    expect(await psql("select datname || ' ' || pg_get_userbyid(datdba) from pg_database where datname like 'answerable_%' order by datname")).toEqual([
      "answerable_admin answerable_admin_owner", "answerable_id answerable_id_owner", "answerable_toolbox answerable_toolbox_owner",
    ])
    // super, createdb, createrole, inherit, replication, bypassrls: none.
    expect(await psql("select rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls from pg_roles where rolname like 'answerable\\_%\\_runtime' order by rolname")).toEqual([
      "answerable_admin_runtime|f|f|f|f|f|f", "answerable_id_runtime|f|f|f|f|f|f", "answerable_toolbox_runtime|f|f|f|f|f|f",
    ])
    expect(await psql("select count(*) from pg_database d, aclexplode(d.datacl) acl where d.datname like 'answerable_%' and acl.grantee = 0")).toEqual(["0"])
    for (const database of ["answerable_id", "answerable_toolbox", "answerable_admin"]) {
      const runtime = `${database}_runtime`
      expect(await psql(`select has_database_privilege('${runtime}', '${database}', 'CONNECT') || ' ' || has_database_privilege('${runtime}', '${database}', 'TEMP')`), database).toEqual(["true false"])
    }
  })

  test("bootstrap wrote six URLs, each its login's, verifying the database with the mounted certificate authority, with a 32-byte password", async () => {
    for (const [name, key, login, database] of urlSecrets) {
      const url = new URL((await stack!.readSecret("answerable", name))[key]!)
      expect(`${url.protocol}//${decodeURIComponent(url.username)}@${url.host}${url.pathname}${url.search}`, name).toBe(`postgres://${login}@postgres.database.svc.cluster.local:5432/${database}?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`)
      expect(Buffer.from(decodeURIComponent(url.password), "base64url").length, name).toBe(32)
    }
    const log = await jobLog("ops-bootstrap")
    expect(log).toContain("answerable_id: created, owned by answerable_id_owner")
    for (const value of await generatedValues()) expect(log.includes(value)).toBe(false)
  })

  test("register stored both machine clients' secrets, started the Toolbox and the admin MCP, and printed Claude Code's commands without a secret", async () => {
    for (const [name, key] of clientSecrets) expect((await stack!.readSecret("answerable", name))[key]?.length, name).toBeGreaterThan(20)
    for (const deployment of ["toolbox", "admin-mcp"]) {
      const { stdout } = await stack!.kubectl(["get", "deployment", "-n", "answerable", deployment, "-o", "jsonpath={.status.readyReplicas}"])
      expect(stdout, deployment).toBe("1")
    }
    expect(await (await viaIngress(`${origin(hosts.adminMcp)}/health`)).json()).toEqual({ status: "ok" })
    const log = await jobLog("ops-register")
    expect(log).toContain(`claude mcp add --transport http answerable-admin ${origin(hosts.adminMcp)}/mcp --client-id claude-code-admin --callback-port 47700`)
    expect(log).toContain("toolbox: scaled from 0 to 1")
    expect(log).toContain("admin-mcp: scaled from 0 to 1")
    for (const value of [...await generatedValues(), stack!.secrets.rootAdminSecret]) expect(log.includes(value)).toBe(false)
  })

  test("a machine-token round trip: the admin MCP's client gets a toolbox:admin token from ID and lists the Toolbox's providers", async () => {
    const clientSecret = (await stack!.readSecret("answerable", "admin-id-client")).ADMIN_ID_CLIENT_SECRET!
    const toolboxAdmin = `${origin(hosts.toolbox)}/admin`
    const issued = await viaIngress(`${origin(hosts.id)}/auth/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`admin-mcp:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: toolboxAdmin, scope: "toolbox:admin" }),
    })
    expect(issued.status).toBe(200)
    const { access_token: token } = await issued.json() as { access_token: string }
    const providers = await viaIngress(`${toolboxAdmin}/v1/providers`, { headers: { authorization: `Bearer ${token}` } })
    expect(providers.status).toBe(200)
    expect(((await providers.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0)
    // The same request without the token is refused.
    expect((await viaIngress(`${toolboxAdmin}/v1/providers`)).status).toBe(401)
  })
})

describe("a staff member signs in through the cluster", () => {
  test("with the platform's company directory on this host, in Chromium through Traefik, and the official MCP client calls admin_whoami: no role, then owner", () => watched("the staff sign-in", 150_000, async () => {
    const { directory } = stack!
    const platform = ((await rootAdmin("GET", "/organizations?q=answerable&limit=100")).items as { id: string; slug: string }[]).find(item => item.slug === "answerable")!.id
    // register added the staff domain (id.staffDomain), and, ID having no Microsoft client here, left the Entra provider
    // out with a line. The test connects the company directory with its own credentials instead.
    expect(((await rootAdmin("GET", `/organizations/${platform}/domains?limit=200`)).items as { domain: string }[]).map(item => item.domain)).toContain(directory.domain)
    const register = await jobLog("ops-register")
    expect(register).toContain(`Staff domain ${directory.domain}: added`)
    expect(register).toContain("Staff directory not connected: ID has no Microsoft client")
    await setSsoProvider(rootAdmin, platform, directory)
    const ownerGroup = ((await rootAdmin("GET", `/organizations/${platform}/groups?q=answerable-owner&limit=100`)).items as { id: string; slug: string }[]).find(item => item.slug === "answerable-owner")!.id
    // Chromium runs in a process of its own, which signs in, calls admin_whoami, has root make the member an owner and calls
    // it again (sign-in.ts says why it is not this process).
    const input: SignInInput = { email: directory.email, platform, ownerGroup, rootAdminSecret: stack!.secrets.rootAdminSecret, stackCa: stack!.stackCa, originPullCert: stack!.originPullCert, edgeCert: stack!.edgeCert }
    const { stdout } = await step("sign a staff member in through the browser", () => exec([process.execPath, "infra/k8s/local/sign-in.ts"], { stdin: JSON.stringify(input) }))
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as { claims: { organization_id: string; client_id: string; membership_id: string }; before: unknown; after: unknown }
    expect(result.claims).toMatchObject({ organization_id: platform, client_id: "claude-code-admin" })
    expect(result.before).toMatchObject({ organizationId: platform, membershipId: result.claims.membership_id, role: null, nextStep: expect.stringContaining("Ask an owner") })
    // The admin MCP reads the role on each request: the same token is an owner's on the next call.
    expect(result.after).toMatchObject({ role: "owner", nextStep: null })
  }), 180_000)
})

describe("running the ops Jobs again", () => {
  test("bootstrap and register once more, as deploy.ts run-job does: every login keeps its password, every Secret is untouched, nothing is rotated", () => watched("running the ops Jobs again", 420_000, async () => {
    const versions = async () => Object.fromEntries(await Promise.all([...urlSecrets, ...clientSecrets].map(async ([name]) => [name, (await stack!.kubectl(["get", "secret", "-n", "answerable", name, "-o", "jsonpath={.metadata.resourceVersion}"])).stdout])))
    const before = await versions()
    await step("run bootstrap and register again", () => stack!.release(["ops.bootstrap=true", "ops.register=true"]))
    expect(await versions()).toEqual(before)
    const bootstrap = await jobLog("ops-bootstrap")
    expect(bootstrap).not.toContain("URL written")
    expect(bootstrap).toContain("answerable_toolbox_runtime: password set to the one its Secret holds")
    const register = await jobLog("ops-register")
    expect(register).not.toContain("rotated")
    expect(register).not.toContain("secret stored")
    expect(register).toContain("toolbox: already running")
    // The services still connect with the passwords they hold.
    expect(await (await viaIngress(`${origin(hosts.id)}/readyz`)).json()).toEqual({ status: "ok" })
    expect(await (await viaIngress(`${origin(hosts.adminMcp)}/health`)).json()).toEqual({ status: "ok" })
  }), 600_000)
})

// Then, because it changes the cluster and restores it: the default TLS option, the only one, demands Cloudflare's
// certificate of every host, and no Ingress names another. Traefik takes a few seconds to reload, so each step waits until
// a certificate-less request gives the outcome it must, and the step that opens the host first proves the reload happened.
describe("the edge fails closed", () => {
  const issuer = () => `${origin(hosts.id)}/healthz`
  const withoutCertificate = async () => (await freshRequest(issuer(), null)).status === 200 ? "open" : "refused"
  async function until(state: "open" | "refused") {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(1000)) if (await withoutCertificate() === state) return state
    return withoutCertificate()
  }
  const kubectl = (args: string[]) => stack!.kubectl(args)

  test("the default option alone keeps every host closed: no Ingress names an option, and without the default the host opens", async () => {
    expect((await kubectl(["get", "tlsoptions.traefik.io", "-A", "-o", "name"])).stdout.trim().split("\n")).toEqual(["tlsoption.traefik.io/default"])
    const ingresses = JSON.parse((await kubectl(["get", "ingress", "-n", "answerable", "-o", "json"])).stdout) as { items: { metadata: { annotations?: Record<string, string> }; spec: { tls: { secretName: string }[] } }[] }
    expect(ingresses.items).toHaveLength(3)
    for (const ingress of ingresses.items) {
      expect(Object.keys(ingress.metadata.annotations ?? {}).filter(key => key.includes("tls.options") || key.startsWith("cert-manager.io/"))).toEqual([])
      expect(ingress.spec.tls.map(entry => entry.secretName)).toEqual(["origin-tls"])
    }
    const saved = JSON.parse((await kubectl(["get", "tlsoption", "-n", "answerable", "default", "-o", "json"])).stdout)
    // Helm's ownership annotations come back with it, so the platform release still owns the option.
    const restore = { apiVersion: saved.apiVersion, kind: saved.kind, metadata: { name: saved.metadata.name, namespace: saved.metadata.namespace, labels: saved.metadata.labels, annotations: saved.metadata.annotations }, spec: saved.spec }
    try {
      // Without it, the host is open: nothing else demands the certificate, and the change reached Traefik.
      await kubectl(["delete", "tlsoption", "-n", "answerable", "default"])
      expect(await until("open")).toBe("open")
      // With it alone, a request without the certificate is refused, and one with it is served.
      await stack!.kubectl(["apply", "-f", "-"], { stdin: JSON.stringify(restore) })
      expect(await until("refused")).toBe("refused")
      expect(await freshRequest(issuer(), stack!.originPullCert)).toEqual({ status: 200 })
    } finally {
      await stack!.kubectl(["apply", "-f", "-"], { stdin: JSON.stringify(restore) })
    }
    expect(await until("refused")).toBe("refused")
  }, 300_000)
})

// Last, because it locks ID's root secret, which the proofs above use: the first run's last step, as ops.yml runs it.
describe("the first administrator", () => {
  test("make-admin puts the staff member who signed in in the owner group and platform-admins, and ID's root secret locks", () => watched("make-admin", 240_000, async () => {
    const email = stack!.directory.email
    await step("run make-admin", () => stack!.release(["ops.makeAdmin=true", `ops.adminEmail=${email}`]))
    const log = await jobLog("ops-make-admin")
    // The sign-in made them an owner already; make-admin leaves that as it is.
    expect(log).toContain("already in answerable-owner")
    expect(log).toContain("added to platform-admins")
    expect(log).toContain("Root is locked now")
    expect(log).not.toContain(stack!.secrets.rootAdminSecret)
    const refused = await viaIngress(`${origin(hosts.id)}/api/admin/v1/organizations?limit=1`, { headers: { authorization: `Bearer ${stack!.secrets.rootAdminSecret}` } })
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { code: string }).code).toBe("root_locked")
  }), 300_000)
})

function stackKubeconfig() {
  return stack!.kubeconfig
}
