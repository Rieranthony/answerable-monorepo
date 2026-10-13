import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDependencies, charts, helmEnv, repo } from "../helm"

/** The kind cluster's name: one stack per machine at a time. */
const cluster = "answerable-local"
const here = join(repo, "infra/k8s/local")

/** The public names: 127.0.0.1 on the laptop through public DNS, the edge inside the cluster through /etc/hosts. */
export const hosts = { id: "id.127-0-0-1.sslip.io", toolbox: "toolbox.127-0-0-1.sslip.io", adminMcp: "admin-mcp.127-0-0-1.sslip.io" }
export const origin = (host: string) => `https://${host}:48443`

/** The four images, built from the repository root and loaded into the cluster under the local tag. */
export const images = [
  { name: "id", dockerfile: "apps/id/Dockerfile" },
  { name: "toolbox", dockerfile: "mcps/toolbox/Dockerfile" },
  { name: "admin-mcp", dockerfile: "mcps/admin/Dockerfile" },
  { name: "ops", dockerfile: "infra/ops/Dockerfile" },
] as const
export const image = (name: string) => `ghcr.io/rieranthony/answerable/${name}:local`

/** The company directory's port on the host (apps/id/scripts/stack-directories.ts). */
export const directoryPort = 47_710

/** The database's administrative login, as a managed database hands one out: it may create databases and roles, and is not a superuser. */
export const databaseAdmin = "dbadmin"

type Result = { exitCode: number; stdout: string; stderr: string }

/** Run a command without a shell; throw with its output when it fails, unless `allowFailure`. */
export async function exec(command: string[], options: { env?: Record<string, string | undefined>; stdin?: string; allowFailure?: boolean } = {}): Promise<Result> {
  const child = Bun.spawn(command, { cwd: repo, env: options.env ?? process.env, stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin), stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0 && !options.allowFailure) throw new Error(`${command.slice(0, 6).join(" ")} exited with ${exitCode}:\n${stderr || stdout}`)
  return { exitCode, stdout, stderr }
}

/** A random password: 32 hex digits. */
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")

/** Wall-clock time of each step, printed at the end of the run. */
export const timings: [string, number][] = []
export async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    timings.push([name, Math.round((performance.now() - started) / 100) / 10])
  }
}

/** Every value the stack generates for itself; nothing here outlives the cluster. The ops bootstrap generates the logins' passwords. */
function generateSecrets() {
  return {
    superuser: secret(),
    admin: secret(),
    rootAdminSecret: `${secret()}${secret()}`,
    betterAuthSecret: `${secret()}${secret()}`,
    upstreamKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  }
}

/**
 * What the database runs once, when its data directory is created: the administrative login alone, as a managed database
 * starts. The ops bootstrap Job creates the databases and their logins with it. The password is hex, so it needs no quoting.
 */
const adminSql = ({ admin }: ReturnType<typeof generateSecrets>) => `CREATE ROLE ${databaseAdmin} LOGIN PASSWORD '${admin}' CREATEDB CREATEROLE;\n`

const database = "postgres.database.svc.cluster.local:5432"

/** One company directory a person signs in with, as `setSsoProvider` in packages/acceptance takes it. */
export type Directory = { slug: string; domain: string; email: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksEndpoint: string; clientId: string; clientSecret: string }

/**
 * Where ID's pods reach this host: host.docker.internal as the kind node resolves it (Docker Desktop), else the gateway of
 * kind's Docker network (Docker on Linux, where the host owns that address).
 */
async function hostFromPods(gateway: string | undefined) {
  const lookup = await exec(["docker", "exec", `${cluster}-control-plane`, "getent", "ahostsv4", "host.docker.internal"], { allowFailure: true })
  const address = lookup.stdout.trim().split(/\s+/)[0]
  if (lookup.exitCode === 0 && address && /^\d+\.\d+\.\d+\.\d+$/.test(address)) return address
  if (!gateway) throw new Error("The kind node resolves no host.docker.internal and kind's Docker network has no IPv4 gateway: the pods cannot reach the company directory on this host")
  return gateway
}

/**
 * The platform organisation's company directory, on this host (apps/id/scripts/stack-directories.ts): the browser reaches
 * its authorisation endpoint at 127.0.0.1, ID's pods its token endpoint and keys at `podHost`. Its one person signs in up to
 * three times. Returns the directory and how to stop it.
 */
async function startDirectory(workdir: string, podHost: string) {
  const plan = join(workdir, "directories-plan.json")
  const manifest = join(workdir, "directories.json")
  await Bun.write(plan, JSON.stringify({ hostname: "0.0.0.0", port: directoryPort, browserHost: "http://127.0.0.1", podHost: `http://${podHost}`, directories: [{ slug: "answerable", person: "staff", signIns: 3 }] }))
  const child = Bun.spawn([process.execPath, "apps/id/scripts/stack-directories.ts", plan, manifest], { cwd: repo, stdout: "ignore", stderr: "inherit" })
  const stop = async () => {
    child.kill()
    await child.exited
  }
  for (const deadline = Date.now() + 30_000; !(await Bun.file(manifest).exists()); await Bun.sleep(200)) {
    if (child.exitCode !== null) throw new Error(`The company directory stopped with ${child.exitCode}; is port ${directoryPort} free?`)
    if (Date.now() > deadline) {
      await stop()
      throw new Error("Timed out after 30 seconds waiting for the company directory")
    }
  }
  const { directories } = (await Bun.file(manifest).json()) as { directories: Directory[] }
  return { directory: directories[0]!, stop }
}

/**
 * Cloudflare's stand-in for a browser on this host. Traefik demands the origin-pull client certificate, and Playwright's
 * `clientCertificates` hang under Bun (measured: a navigation never loads, while the same script under Node loads in under a
 * second), so Chromium is sent here instead: `hostResolverRules` maps the public names to [::1], where this proxy listens
 * on 48443 (Traefik's host port is 127.0.0.1 only), presents `serverCert` (the browser ignores certificate errors), and
 * forwards each request to Traefik with the origin-pull certificate, as Cloudflare does. Traefik sees the Docker network's
 * gateway, an untrusted address, as for any visitor.
 */
export function startBrowserEdge({ stackCa, originPullCert, serverCert }: { stackCa: string; originPullCert: { cert: string; key: string }; serverCert: { cert: string; key: string } }) {
  const names = new Set(Object.values(hosts))
  const server = Bun.serve({
    hostname: "::1",
    port: 48_443,
    tls: serverCert,
    async fetch(request) {
      const url = new URL(request.url)
      if (!names.has(url.hostname)) return new Response("Not a stack hostname", { status: 421 })
      const headers = new Headers(request.headers)
      // Bun's fetch fails to connect when given a Host header with a port (measured: ConnectionRefused); the URL names the host.
      headers.delete("host")
      // Traefik answers uncompressed, so the body passes through as it came.
      headers.delete("accept-encoding")
      const upstream = await fetch(`${origin(url.hostname)}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: "manual",
        tls: { ca: stackCa, ...originPullCert },
      })
      const answer = new Headers(upstream.headers)
      answer.delete("content-encoding")
      answer.delete("content-length")
      return new Response(upstream.body, { status: upstream.status, headers: answer })
    },
  })
  return { hostResolverRules: [...names].map(name => `MAP ${name} [::1]`).join(","), stop: () => server.stop(true) }
}

/** The kind stack: build, create, install, bootstrap, register, and the handles the proofs use. `stop` deletes the cluster. */
export async function startStack() {
  const workdir = mkdtempSync(join(tmpdir(), "answerable-stack-"))
  const kubeconfig = join(workdir, "kubeconfig")
  const env = { ...helmEnv, KUBECONFIG: kubeconfig }
  const kubectl = (args: string[], options: { stdin?: string; allowFailure?: boolean } = {}) => exec(["kubectl", ...args], { env, ...options })
  const helm = (args: string[]) => exec(["helm", ...args], { env })
  const apply = (namespace: string, objects: object[]) => kubectl(["apply", "-n", namespace, "-f", "-"], { stdin: JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }) })
  const readSecret = async (namespace: string, name: string) => {
    const { data } = JSON.parse((await kubectl(["get", "secret", "-n", namespace, name, "-o", "json"])).stdout) as { data: Record<string, string> }
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, "base64").toString()]))
  }
  const secrets = generateSecrets()
  let created = false
  let directory: Awaited<ReturnType<typeof startDirectory>> | undefined
  const stop = async () => {
    await directory?.stop()
    if (created && !process.env.INFRA_STACK_KEEP) await exec(["kind", "delete", "cluster", "--name", cluster, "--kubeconfig", kubeconfig], { allowFailure: true })
    rmSync(workdir, { recursive: true, force: true })
  }

  const existing = await exec(["kind", "get", "clusters"])
  if (existing.stdout.split("\n").includes(cluster)) throw new Error(`The kind cluster ${cluster} exists: another stack is running, or a run left it behind. Delete it with: kind delete cluster --name ${cluster}`)

  try {
    const revision = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim()
    // The images build while the cluster and its platform come up.
    const built = step("build the four images", () => Promise.all(images.map(({ name, dockerfile }) =>
      exec(["docker", "build", "-f", dockerfile, "-t", image(name), "--build-arg", `REVISION=${revision}`, "."]))))
    built.catch(() => {})
    await step("create the kind cluster", async () => {
      created = true
      await exec(["kind", "create", "cluster", "--config", join(here, "kind.yaml"), "--kubeconfig", kubeconfig, "--wait", "180s"])
    })
    // The address the laptop's requests reach Traefik from: the IPv4 gateway of kind's Docker network.
    const gateways = (await exec(["docker", "network", "inspect", "kind", "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"])).stdout.trim().split(/\s+/)
    const dockerGateway = gateways.find(address => /^\d+\.\d+\.\d+\.\d+$/.test(address))
    const podHost = await hostFromPods(dockerGateway)
    directory = await step("start the company directory on the host", () => startDirectory(workdir, podHost))
    // Terraform creates the namespaces in a cloud, with the restricted Pod Security Standard enforced on answerable.
    await kubectl(["create", "namespace", "platform"])
    await kubectl(["create", "namespace", "database"])
    await apply("default", [{ apiVersion: "v1", kind: "Namespace", metadata: { name: "answerable", labels: { "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/warn": "restricted", "pod-security.kubernetes.io/audit": "restricted" } } }])
    await step("install charts/platform", async () => {
      buildDependencies("platform")
      await helm(["upgrade", "--install", "platform", join(charts, "platform"), "--namespace", "platform", "--values", join(charts, "platform/values-local.yaml"), "--wait", "--timeout", "10m"])
    })
    await step("start the database and the edge", async () => {
      await apply("database", [{ apiVersion: "v1", kind: "Secret", metadata: { name: "postgres-bootstrap" }, stringData: { SUPERUSER_PASSWORD: secrets.superuser, "admin.sql": adminSql(secrets) } }])
      await kubectl(["apply", "-f", join(here, "database.yaml"), "-f", join(here, "edge.yaml")])
      await kubectl(["wait", "-n", "platform", "certificate/edge-tls", "certificate/edge-origin-pull", "--for=condition=Ready", "--timeout=180s"])
      await kubectl(["wait", "-n", "database", "certificate/postgres-tls", "--for=condition=Ready", "--timeout=180s"])
      await helm(["upgrade", "platform", join(charts, "platform"), "--namespace", "platform", "--values", join(charts, "platform/values-local.yaml"), "--values", join(here, "platform-edge.yaml"), "--wait", "--timeout", "10m"])
      await kubectl(["rollout", "status", "-n", "database", "statefulset/postgres", "--timeout=300s"])
    })
    await step("load the images into the cluster", async () => {
      await built
      for (const { name } of images) await exec(["kind", "load", "docker-image", image(name), "--name", cluster])
    })
    const stackCa = (await readSecret("platform", "local-ca"))["ca.crt"]
    const databaseCa = (await readSecret("database", "database-ca"))["ca.crt"]
    const originPullCa = (await readSecret("platform", "origin-pull-ca"))["ca.crt"]

    // ID trusts the directory's two origins and may reach it on this host: what an operator configures for a company directory on a private network.
    const localValues = Bun.YAML.parse(readFileSync(join(charts, "answerable/values-local.yaml"), "utf8")) as { id: { trustedOrigins: string[] } }
    const trustedOrigins = [...localValues.id.trustedOrigins, directory.directory.issuer, new URL(directory.directory.tokenEndpoint).origin]
    const extraEgress = [{ to: [{ ipBlock: { cidr: `${podHost}/32` } }], ports: [{ port: directoryPort, protocol: "TCP" }] }]
    /** `helm upgrade --install` of charts/answerable as the pipeline runs it, with the local values, the directory's settings and `sets`. */
    const release = (sets: string[]) => helm([
      "upgrade", "--install", "answerable", join(charts, "answerable"), "--namespace", "answerable", "--values", join(charts, "answerable/values-local.yaml"),
      "--set-json", `id.trustedOrigins=${JSON.stringify(trustedOrigins)}`, "--set-json", `id.extraEgress=${JSON.stringify(extraEgress)}`,
      ...sets.flatMap(set => ["--set", set]), "--wait", "--wait-for-jobs", "--timeout", "10m",
    ])
    await step("install charts/answerable with the ops bootstrap", async () => {
      const opaque = (name: string, data: Record<string, string>) => ({ apiVersion: "v1", kind: "Secret", metadata: { name }, type: "Opaque", stringData: data })
      // What the deploy applies from the sops file in a cloud; here, throwaway values. The ops Jobs write the rest.
      await apply("answerable", [
        opaque("id-env", { BETTER_AUTH_SECRET: secrets.betterAuthSecret, ROOT_ADMIN_SECRET: secrets.rootAdminSecret, UPSTREAM_TOKEN_SECRETS: JSON.stringify([{ version: 1, value: secrets.upstreamKey }]) }),
        opaque("postgres-admin", { OPS_DATABASE_ADMIN_URL: `postgres://${databaseAdmin}:${secrets.admin}@${database}/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem` }),
        opaque("cloudflare-origin-pull-ca", { "ca.crt": originPullCa }),
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "postgres-ca" }, data: { "ca.pem": databaseCa } },
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "local-ca" }, data: { "ca.pem": stackCa } },
      ])
      await release(["ops.bootstrap=true"])
    })
    // As deploy.ts run-job register does: one upgrade with the Job switched on. The Job starts the two servers it registered.
    await step("run the ops register", async () => {
      await release(["ops.register=true"])
      for (const deployment of ["toolbox", "admin-mcp"]) await kubectl(["rollout", "status", "-n", "answerable", `deploy/${deployment}`, "--timeout=300s"])
    })
    const client = await readSecret("platform", "edge-origin-pull")
    const edgeServer = await readSecret("platform", "edge-tls")
    return { kubectl, helm, release, kubeconfig, readSecret, secrets, stop, stackCa, dockerGateway, podHost, directory: directory.directory, databaseCa, originPullCert: { cert: client["tls.crt"]!, key: client["tls.key"]! }, edgeCert: { cert: edgeServer["tls.crt"]!, key: edgeServer["tls.key"]! } }
  } catch (error) {
    if (created) {
      // Show what the cluster says before it goes: the pods, the last events, and the Jobs' logs.
      const pods = await kubectl(["get", "pods", "-A", "-o", "wide"], { allowFailure: true })
      const events = await kubectl(["get", "events", "-A", "--sort-by=.lastTimestamp"], { allowFailure: true })
      const jobs = await kubectl(["logs", "-n", "answerable", "-l", "app.kubernetes.io/component in (ops,migrate)", "--prefix", "--tail=40"], { allowFailure: true })
      console.error(pods.stdout, events.stdout.split("\n").slice(-40).join("\n"), jobs.stdout)
    }
    await stop()
    throw error
  }
}

export type Stack = Awaited<ReturnType<typeof startStack>>
