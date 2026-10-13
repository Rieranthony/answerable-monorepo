import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { exec, hosts, image, images, origin, type Stack, startStack, timings } from "./stack"

// bun run infra:test: the three images, a kind cluster with charts/platform and charts/answerable as a cloud runs them,
// a TLS-only PostgreSQL 17, and the proofs that the stack behaves as production must. Needs Docker, kind, kubectl and
// helm, and public DNS for *.127-0-0-1.sslip.io. Deletes its cluster at the end, on failure and on Ctrl-C; set
// INFRA_STACK_KEEP=1 to keep it for a look (then delete it with kind delete cluster --name answerable-local).

let stack: Stack | undefined
const started = performance.now()

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => void (stack?.stop() ?? Promise.resolve()).finally(() => process.exit(code)))
}

// The hooks and tests take bun test's --timeout, which the workspace's test script sets to 30 minutes.
beforeAll(async () => {
  stack = await startStack()
})

afterAll(async () => {
  await stack?.stop()
  const total = Math.round((performance.now() - started) / 1000)
  console.log(`\nThe stack, step by step (seconds): ${timings.map(([name, seconds]) => `${name} ${seconds}`).join("; ")}; everything ${total}`)
})

/** A request through Traefik, as Cloudflare makes it: the origin-pull client certificate, the stack's CA trusted. */
function viaIngress(url: string, init: RequestInit = {}, certificate: { cert: string; key: string } | null = stack!.originPullCert) {
  return fetch(url, { ...init, tls: { ca: stack!.stackCa, ...(certificate ?? {}) }, redirect: "manual" })
}

/** Run a script with Bun in a running pod of a Deployment and return its last line of output, parsed. */
async function inPod(deployment: string, directory: string, script: string) {
  const { stdout } = await stack!.kubectl(["exec", "-n", "answerable", `deploy/${deployment}`, "-c", deployment, "--", "bun", "--cwd", directory, "-e", script])
  return JSON.parse(stdout.trim().split("\n").at(-1)!)
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
    for (const certificate of [null, stack!.otherCert]) {
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
    expect(result.wrongAuthority).toContain("unable to verify")
    expect(result.bunAlone).toStartWith("refused")
  })

  test("Postgres takes TLS only: pg in ID verifies the server with verify-full and the URL's sslrootcert; plain and a wrong authority fail", async () => {
    const result = await inPod("id", "/app/apps/id", `
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
    expect(result.wrongAuthority).toMatch(/self-signed|unable to (verify|get)/)
  })

  test("ID provisions the platform organisation on its first start and verifies it on the next", async () => {
    const first = await stack!.kubectl(["logs", "-n", "answerable", "deploy/id", "-c", "id"])
    expect(first.stdout).toContain("platform organisation answerable: provisioned")
    await stack!.kubectl(["rollout", "restart", "-n", "answerable", "deploy/id"])
    await stack!.kubectl(["rollout", "status", "-n", "answerable", "deploy/id", "--timeout=180s"])
    // Every ID pod's log: the one the restart replaced may still be exiting.
    const next = await stack!.kubectl(["logs", "-n", "answerable", "-l", "app.kubernetes.io/component=id", "-c", "id", "--prefix", "--tail=-1"])
    expect(next.stdout).toContain("platform organisation answerable: verified")
  }, 240_000)

  test("the three migrations ran to completion as the release's hooks, the admin MCP's while its server waits for registration", async () => {
    const { stdout } = await stack!.kubectl(["get", "jobs", "-n", "answerable", "-o", "json"])
    const jobs = (JSON.parse(stdout) as { items: { metadata: { name: string }; status: { succeeded?: number } }[] }).items
    for (const name of ["id-migrate", "toolbox-migrate", "admin-migrate"]) expect(jobs.find(job => job.metadata.name === name)?.status.succeeded, name).toBe(1)
  })
})

// Last, because it changes the cluster and restores it: each of the two TLS options alone demands Cloudflare's
// certificate, so a lost reference or a lost default never opens a host. Traefik takes a few seconds to reload, so each
// step waits until a certificate-less request gives the outcome it must, and a step that opens the host first proves the
// reload happened.
describe("the edge fails closed", () => {
  const issuer = () => `${origin(hosts.id)}/healthz`
  const withoutCertificate = async () => (await freshRequest(issuer(), null)).status === 200 ? "open" : "refused"
  async function until(state: "open" | "refused") {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(1000)) if (await withoutCertificate() === state) return state
    return withoutCertificate()
  }
  const kubectl = (args: string[]) => stack!.kubectl(args)
  const defaultOption = () => kubectl(["get", "tlsoption", "-n", "answerable", "default", "-o", "json"])
  const reference = "traefik.ingress.kubernetes.io/router.tls.options"

  test("the default option alone refuses a host whose Ingress lost its reference, and the reference alone refuses without the default", async () => {
    const saved = JSON.parse((await defaultOption()).stdout)
    // Helm's ownership annotations come back with it, so the platform release still owns the option.
    const restore = { apiVersion: saved.apiVersion, kind: saved.kind, metadata: { name: saved.metadata.name, namespace: saved.metadata.namespace, labels: saved.metadata.labels, annotations: saved.metadata.annotations }, spec: saved.spec }
    try {
      // Neither: the host is open, which shows the changes reached Traefik.
      await kubectl(["delete", "tlsoption", "-n", "answerable", "default"])
      await kubectl(["annotate", "ingress", "-n", "answerable", "id", `${reference}-`])
      expect(await until("open")).toBe("open")
      // The default alone.
      await stack!.kubectl(["apply", "-f", "-"], { stdin: JSON.stringify(restore) })
      expect(await until("refused")).toBe("refused")
      expect(await freshRequest(issuer(), stack!.originPullCert)).toEqual({ status: 200 })
      // Neither again, then the reference alone.
      await kubectl(["delete", "tlsoption", "-n", "answerable", "default"])
      expect(await until("open")).toBe("open")
      await kubectl(["annotate", "ingress", "-n", "answerable", "id", `${reference}=answerable-origin-pull@kubernetescrd`])
      expect(await until("refused")).toBe("refused")
      expect(await freshRequest(issuer(), stack!.originPullCert)).toEqual({ status: 200 })
    } finally {
      await stack!.kubectl(["apply", "-f", "-"], { stdin: JSON.stringify(restore) })
      await kubectl(["annotate", "--overwrite", "ingress", "-n", "answerable", "id", `${reference}=answerable-origin-pull@kubernetescrd`])
    }
    expect(await until("refused")).toBe("refused")
  }, 300_000)
})

function stackKubeconfig() {
  return stack!.kubeconfig
}
