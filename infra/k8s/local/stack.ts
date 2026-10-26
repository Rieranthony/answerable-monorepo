import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DeclaredMcp } from "@answerable/mcp-postgres"
import { generatedFiles } from "../../../scripts/mcp/generate"
import pipelineImages from "../../pipeline/images.json"
import { buildDependencies, charts, helmEnv, repo } from "../helm"

/** The kind cluster's name: one stack per machine at a time. */
const cluster = "answerable-local"
const here = join(repo, "infra/k8s/local")

/** The public names: 127.0.0.1 on the laptop through public DNS, the edge inside the cluster through /etc/hosts. */
export const hosts = { id: "id.127-0-0-1.sslip.io", toolbox: "toolbox.127-0-0-1.sslip.io", adminMcp: "admin-mcp.127-0-0-1.sslip.io", mcp: "mcp.127-0-0-1.sslip.io" }
export const origin = (host: string) => `https://${host}:48443`

/** The images the pipeline builds (infra/pipeline/images.json), built from the repository root and loaded into the cluster under the local tag. */
export const images = pipelineImages
export const image = (name: string) => `ghcr.io/rieranthony/answerable/${name}:local`

/** The MCPs the chart renders from charts/answerable/mcps.json, which every proof below reads rather than naming one. */
export const declared = (JSON.parse(readFileSync(join(charts, "answerable/mcps.json"), "utf8")) as { mcps: DeclaredMcp[] }).mcps
/** The MCPs the Toolbox serves alone, each at its path on the mcp host. */
export const servedAlone = declared.filter(mcp => mcp.serve !== "toolbox")
/** The servers the register Job starts. */
export const registered = ["toolbox", "admin-mcp"]

/** The company directories' ports on the host (apps/id/scripts/stack-directories.ts): the platform organisation's, then a client organisation's. */
const directoryPort = 47_710
const directoryPorts = [directoryPort, directoryPort + 1]

/** The Entra tenant register is given: ID has no Microsoft client in the stack, so it never reaches Entra. */
const entraTenant = "00000000-0000-4000-8000-0000000000e1"

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

/** A certificate and its key, PEM. */
export type KeyPair = { cert: string; key: string }

/**
 * The stack's certificates, made with the system openssl (OpenSSL 3 on the runners, LibreSSL 3.3 on a Mac) in `directory`:
 * three authorities, the stack's own, the stand-in for Cloudflare's origin-pull CA and the database's, and the
 * certificates they sign, each ECDSA P-256 and valid for two days. Each has a config file of its own, so the system's
 * openssl.cnf plays no part. On Civo, Terraform makes the origin certificate and the origin-pull CA, and the database
 * comes with its own.
 */
async function makeCertificates(directory: string) {
  const path = (name: string) => join(directory, name)
  const read = (name: string) => readFileSync(path(name), "utf8")
  const openssl = (...args: string[]) => exec(["openssl", ...args])
  async function prepare(name: string, commonName: string, extensions: string[]) {
    await Bun.write(path(`${name}.cnf`), `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${commonName}\n[extensions]\n${extensions.join("\n")}\n`)
    await openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", path(`${name}.key`))
  }
  async function authority(name: string, commonName: string) {
    await prepare(name, commonName, ["basicConstraints = critical,CA:TRUE", "keyUsage = critical,keyCertSign,cRLSign", "subjectKeyIdentifier = hash"])
    await openssl("req", "-new", "-x509", "-key", path(`${name}.key`), "-config", path(`${name}.cnf`), "-extensions", "extensions", "-days", "2", "-out", path(`${name}.pem`))
    return { name, cert: read(`${name}.pem`) }
  }
  async function issue(name: string, commonName: string, by: { name: string }, extensions: string[]): Promise<KeyPair> {
    await prepare(name, commonName, ["basicConstraints = critical,CA:FALSE", "keyUsage = critical,digitalSignature", ...extensions])
    await openssl("req", "-new", "-key", path(`${name}.key`), "-config", path(`${name}.cnf`), "-out", path(`${name}.csr`))
    await openssl("x509", "-req", "-in", path(`${name}.csr`), "-CA", path(`${by.name}.pem`), "-CAkey", path(`${by.name}.key`), "-set_serial", `0x${secret()}`,
      "-days", "2", "-extfile", path(`${name}.cnf`), "-extensions", "extensions", "-out", path(`${name}.pem`))
    return { cert: read(`${name}.pem`), key: read(`${name}.key`) }
  }
  const stack = await authority("stack-ca", "Answerable local stack CA")
  const originPull = await authority("origin-pull-ca", "Answerable local origin-pull CA")
  const database = await authority("database-ca", "Answerable local database CA")
  return {
    stackCa: stack.cert,
    originPullCa: originPull.cert,
    databaseCa: database.cert,
    /** The public names: origin-tls, which Traefik serves, and the edge's own (edge-tls). */
    publicNames: await issue("public-names", hosts.id, stack, ["extendedKeyUsage = serverAuth", `subjectAltName = ${Object.values(hosts).map(host => `DNS:${host}`).join(",")}`]),
    /** What the edge presents to Traefik, as Cloudflare does. */
    originPullClient: await issue("origin-pull-client", "origin-pull.local", originPull, ["extendedKeyUsage = clientAuth"]),
    postgres: await issue("postgres", "postgres.database.svc.cluster.local", database, ["extendedKeyUsage = serverAuth", "subjectAltName = DNS:postgres.database.svc.cluster.local,DNS:postgres.database.svc,DNS:postgres.database"]),
  }
}

/** Wall-clock time of each step, printed at the end of the run. Each step also says when it starts and ends, so a log that stops shows where. */
export const timings: [string, number][] = []
export async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  let outcome = "failed"
  console.log(`[stack] ${name}…`)
  try {
    const result = await work()
    outcome = "done"
    return result
  } finally {
    const seconds = Math.round((performance.now() - started) / 100) / 10
    timings.push([name, seconds])
    console.log(`[stack] ${name}: ${outcome} in ${seconds} s`)
  }
}

/** Every value the stack generates for itself; nothing here outlives the cluster. The ops bootstrap generates the logins' passwords. */
function generateSecrets() {
  return {
    superuser: secret(),
    admin: secret(),
    rootAdminSecret: `${secret()}${secret()}`,
    betterAuthSecret: `${secret()}${secret()}`,
  }
}

/**
 * What the database runs once, when its data directory is created: the administrative login alone, as a managed database
 * starts. The ops bootstrap Job creates the databases and their logins with it. The password is hex, so it needs no quoting.
 */
const adminSql = ({ admin }: ReturnType<typeof generateSecrets>) => `CREATE ROLE ${databaseAdmin} LOGIN PASSWORD '${admin}' CREATEDB CREATEROLE;\n`

const database = "postgres.database.svc.cluster.local:5432"

/** One company directory a person signs in with, as `setSsoProvider` in packages/acceptance takes it. */
type Directory = { slug: string; domain: string; email: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksEndpoint: string; clientId: string; clientSecret: string }

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
 * The company directories, on this host (apps/id/scripts/stack-directories.ts): the browser reaches their authorisation
 * endpoints at 127.0.0.1, ID's pods their token endpoints and keys at `podHost`. The platform organisation's one person, the
 * staff member, signs in up to three times; a client organisation's, `tenant`, once. Returns both and how to stop them.
 */
async function startDirectory(workdir: string, podHost: string) {
  const plan = join(workdir, "directories-plan.json")
  const manifest = join(workdir, "directories.json")
  await Bun.write(plan, JSON.stringify({
    hostname: "0.0.0.0", port: directoryPort, browserHost: "http://127.0.0.1", podHost: `http://${podHost}`,
    directories: [{ slug: "answerable", person: "staff", signIns: 3 }, { slug: "tenant", person: "ada", signIns: 1 }],
  }))
  const child = Bun.spawn([process.execPath, "apps/id/scripts/stack-directories.ts", plan, manifest], { cwd: repo, stdout: "ignore", stderr: "inherit" })
  const stop = async () => {
    child.kill()
    await child.exited
  }
  for (const deadline = Date.now() + 30_000; !(await Bun.file(manifest).exists()); await Bun.sleep(200)) {
    if (child.exitCode !== null) throw new Error(`The company directories stopped with ${child.exitCode}; are ports ${directoryPorts.join(" and ")} free?`)
    if (Date.now() > deadline) {
      await stop()
      throw new Error("Timed out after 30 seconds waiting for the company directory")
    }
  }
  const { directories } = (await Bun.file(manifest).json()) as { directories: Directory[] }
  return { directory: directories[0]!, tenant: directories[1]!, stop }
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

/** The second release's image of the MCPs: a throwaway name, removed by this name when the stack stops. */
const nextImage = "ghcr.io/rieranthony/answerable/mcps-next:local"

/**
 * A next release, as a commit that has the Toolbox serve an MCP alone ships it: `change` applied to the MCPs' declarations, then bun mcp's
 * generator (scripts/mcp/generate.ts) writes the chart's list and the Toolbox's, as `bun mcp` does in the tree. Returns a copy of
 * charts/answerable with that list, the list, and a Dockerfile directory for the mcps image with the Toolbox's new list.
 */
async function nextRelease(workdir: string, change: (declaration: { name: string; serve: string }) => void) {
  const root = join(workdir, "next")
  for (const file of ["mcps/retired.json", "mcps/toolbox/package.json"]) {
    mkdirSync(join(root, file, ".."), { recursive: true })
    cpSync(join(repo, file), join(root, file))
  }
  for await (const file of new Bun.Glob("mcps/*/{mcp,manifest}.json").scan(repo)) {
    mkdirSync(join(root, file, ".."), { recursive: true })
    const text = await Bun.file(join(repo, file)).json()
    if (file.endsWith("mcp.json")) change(text)
    await Bun.write(join(root, file), JSON.stringify(text))
  }
  const files = await generatedFiles(root)
  const chart = join(workdir, "next-chart", "answerable")
  cpSync(join(charts, "answerable"), chart, { recursive: true })
  await Bun.write(join(chart, "mcps.json"), files["charts/answerable/mcps.json"]!)
  const dockerfile = join(workdir, "next-image")
  await Bun.write(join(dockerfile, "mounted.generated.ts"), files["mcps/toolbox/src/mounted.generated.ts"]!)
  await Bun.write(join(dockerfile, "Dockerfile"), `FROM ${image("mcps")}\nCOPY mounted.generated.ts /app/mcps/toolbox/src/mounted.generated.ts\n`)
  return { chart, image: dockerfile, declared: (JSON.parse(files["charts/answerable/mcps.json"]!) as { mcps: DeclaredMcp[] }).mcps }
}

/** How long any Helm call may wait: well inside the 10 minutes of the slowest test, so that a hang fails with its diagnosis. */
const helmTimeout = "5m"

type Kubectl = (args: string[], options?: { stdin?: string; allowFailure?: boolean }) => Promise<Result>

/**
 * What explains a failure, printed to standard error: every pod, the answerable namespace's events in order, a description
 * of each pod that is not ready and each Job that is not complete, the ops and migration Jobs' logs, the database's
 * sessions and what blocks them, the releases' history, and the node's allocated resources. Never a value of a Secret:
 * `describe` names Secrets without reading them, the Jobs never print a value, and passwords in SQL are masked.
 */
async function diagnose(kubectl: Kubectl, helm: (args: string[]) => Promise<Result>, why: string) {
  const section = (title: string, text: string) => console.error(`\n===== ${title} =====\n${text.trim() || "(nothing)"}`)
  const show = async (title: string, args: string[]) => {
    const result = await kubectl(args, { allowFailure: true })
    section(title, result.stdout + (result.exitCode ? `\n${result.stderr}` : ""))
  }
  console.error(`\n##### Diagnosis: ${why} #####`)
  await show("pods", ["get", "pods", "-A", "-o", "wide"])
  await show("events in answerable", ["get", "events", "-n", "answerable", "--sort-by=.lastTimestamp"])
  type Item = { metadata: { name: string }; status: { phase?: string; succeeded?: number; conditions?: { type: string; status: string }[] } }
  const items = async (kind: string) => (JSON.parse((await kubectl(["get", kind, "-n", "answerable", "-o", "json"], { allowFailure: true })).stdout || "{\"items\":[]}") as { items: Item[] }).items
  for (const pod of await items("pods")) {
    const ready = pod.status.phase === "Succeeded" || pod.status.conditions?.some(condition => condition.type === "Ready" && condition.status === "True")
    if (!ready) await show(`pod ${pod.metadata.name}, not ready`, ["describe", "pod", "-n", "answerable", pod.metadata.name])
  }
  for (const job of await items("jobs")) if (!job.status.succeeded) await show(`job ${job.metadata.name}, not complete`, ["describe", "job", "-n", "answerable", job.metadata.name])
  await show("ops and migration logs", ["logs", "-n", "answerable", "-l", "app.kubernetes.io/component in (ops,migrate)", "--prefix", "--tail=80", "--all-containers"])
  await show("database sessions", ["exec", "-n", "database", "statefulset/postgres", "-c", "postgres", "--", "psql", "-U", "postgres", "-d", "postgres", "-c",
    "select pid, usename, datname, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocked_by, now() - xact_start as in_transaction, " +
    "left(regexp_replace(query, $$password\\s+'[^']*'$$, 'password ***', 'gi'), 160) as query from pg_stat_activity where backend_type = 'client backend' order by xact_start nulls last"])
  for (const release of ["answerable", "platform"]) {
    const history = await helm(["history", release, "-n", release, "--max", "5"]).catch((error: Error) => ({ stdout: error.message }))
    section(`helm history ${release}`, history.stdout)
  }
  await show("node", ["describe", "node"])
}

/**
 * The kind config, and with INFRA_STACK_CPUS=<n> a node the size of an n-CPU CI runner: the kubelet reserves the rest of
 * Docker's CPUs, so the scheduler sees n allocatable, and after creation the node's container is held to n CPUs of time.
 */
async function kindConfig(workdir: string) {
  const cpus = Number(process.env.INFRA_STACK_CPUS || 0)
  if (!cpus) return { path: join(here, "kind.yaml"), cpus }
  const total = Number((await exec(["docker", "info", "--format", "{{.NCPU}}"])).stdout.trim())
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > total) throw new Error(`INFRA_STACK_CPUS must be a whole number from 1 to ${total}, the CPUs Docker has`)
  const config = Bun.YAML.parse(readFileSync(join(here, "kind.yaml"), "utf8")) as { nodes: { kubeadmConfigPatches?: string[] }[] }
  const node = config.nodes[0]!
  node.kubeadmConfigPatches = [...(node.kubeadmConfigPatches ?? []), `kind: KubeletConfiguration\nsystemReserved:\n  cpu: "${total - cpus}"\n`]
  const path = join(workdir, "kind.json")
  await Bun.write(path, JSON.stringify(config))
  return { path, cpus }
}

/** The kind stack: build, create, install, bootstrap, register, and the handles the proofs use. `stop` deletes the cluster. */
export async function startStack() {
  const workdir = mkdtempSync(join(tmpdir(), "answerable-stack-"))
  const kubeconfig = join(workdir, "kubeconfig")
  const env = { ...helmEnv, KUBECONFIG: kubeconfig }
  const kubectl: Kubectl = (args, options = {}) => exec(["kubectl", ...args], { env, ...options })
  const helmOnly = (args: string[]) => exec(["helm", ...args], { env })
  const diagnosed = new WeakSet<object>()
  /**
   * A Helm call. An install or upgrade runs with --debug, which logs each hook and each resource it waits for (names and
   * statuses, no values); when the call fails, the log's last lines and the cluster's diagnosis are printed before the error.
   */
  const helm = async (args: string[]) => {
    const command = ["helm", ...args, ...(args[0] === "upgrade" ? ["--debug"] : [])]
    const result = await exec(command, { env, allowFailure: true })
    if (result.exitCode === 0) return result
    const what = `helm ${args.slice(0, 2).join(" ")}`
    console.error(`\n===== ${what}: the last lines of its log =====\n${result.stderr.trim().split("\n").slice(-60).join("\n")}`)
    await diagnose(kubectl, helmOnly, `${what} exited with ${result.exitCode}`)
    const error = new Error(`${what} exited with ${result.exitCode}: ${result.stderr.trim().split("\n").at(-1)}`)
    diagnosed.add(error)
    throw error
  }
  const apply = (namespace: string, objects: object[]) => kubectl(["apply", "-n", namespace, "-f", "-"], { stdin: JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }) })
  const tls = (name: string, pair: KeyPair, extra: Record<string, string> = {}) => ({ apiVersion: "v1", kind: "Secret", metadata: { name }, type: "kubernetes.io/tls", stringData: { "tls.crt": pair.cert, "tls.key": pair.key, ...extra } })
  const opaque = (name: string, data: Record<string, string>) => ({ apiVersion: "v1", kind: "Secret", metadata: { name }, type: "Opaque", stringData: data })
  const configMap = (name: string, data: Record<string, string>) => ({ apiVersion: "v1", kind: "ConfigMap", metadata: { name }, data })
  const readSecret = async (namespace: string, name: string) => {
    const { data } = JSON.parse((await kubectl(["get", "secret", "-n", namespace, name, "-o", "json"])).stdout) as { data: Record<string, string> }
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, "base64").toString()]))
  }
  const secrets = generateSecrets()
  let created = false
  let nextBuilt = false
  let directory: Awaited<ReturnType<typeof startDirectory>> | undefined
  const stop = async () => {
    await directory?.stop()
    if (created && !process.env.INFRA_STACK_KEEP) await exec(["kind", "delete", "cluster", "--name", cluster, "--kubeconfig", kubeconfig], { allowFailure: true })
    if (nextBuilt) await exec(["docker", "image", "rm", nextImage], { allowFailure: true })
    rmSync(workdir, { recursive: true, force: true })
  }

  const existing = await exec(["kind", "get", "clusters"])
  if (existing.stdout.split("\n").includes(cluster)) throw new Error(`The kind cluster ${cluster} exists: another stack is running, or a run left it behind. Delete it with: kind delete cluster --name ${cluster}`)

  try {
    const revision = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim()
    // The images build while the cluster and its platform come up.
    const built = step("build the images", () => Promise.all(images.map(({ name, dockerfile }) =>
      exec(["docker", "build", "-f", dockerfile, "-t", image(name), "--build-arg", `REVISION=${revision}`, "."]))))
    built.catch(() => {})
    await step("create the kind cluster", async () => {
      const config = await kindConfig(workdir)
      created = true
      await exec(["kind", "create", "cluster", "--config", config.path, "--kubeconfig", kubeconfig, "--wait", "180s"])
      if (config.cpus) await exec(["docker", "update", "--cpus", String(config.cpus), `${cluster}-control-plane`])
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
    const certificates = await step("make the certificates with openssl", () => makeCertificates(workdir))
    await step("start the database and the edge, and install charts/platform", async () => {
      await apply("database", [
        // The server's certificate, then its authority's: the chain the ops bootstrap fetches and keeps the root of.
        tls("postgres-tls", { cert: certificates.postgres.cert + certificates.databaseCa, key: certificates.postgres.key }),
        opaque("postgres-bootstrap", { SUPERUSER_PASSWORD: secrets.superuser, "admin.sql": adminSql(secrets) }),
      ])
      await apply("platform", [tls("edge-tls", certificates.publicNames, { "ca.crt": certificates.stackCa }), tls("edge-origin-pull", certificates.originPullClient)])
      await kubectl(["apply", "-f", join(here, "database.yaml"), "-f", join(here, "edge.yaml")])
      // The stand-in's origin-pull CA reaches the chart as Terraform passes Cloudflare's: originPull.caPem, from a file.
      const originPullCaFile = join(workdir, "origin-pull-ca.pem")
      await Bun.write(originPullCaFile, certificates.originPullCa)
      buildDependencies("platform")
      await helm(["upgrade", "--install", "platform", join(charts, "platform"), "--namespace", "platform", "--values", join(charts, "platform/values-local.yaml"), "--values", join(here, "platform-edge.yaml"), "--set-file", `originPull.caPem=${originPullCaFile}`, "--wait", "--timeout", helmTimeout])
      await kubectl(["rollout", "status", "-n", "database", "statefulset/postgres", "--timeout=300s"])
    })
    await step("load the images into the cluster", async () => {
      await built
      for (const { name } of images) await exec(["kind", "load", "docker-image", image(name), "--name", cluster])
    })

    // ID trusts the directory's two origins and may reach it on this host: what an operator configures for a company directory on a private network.
    const localValues = Bun.YAML.parse(readFileSync(join(charts, "answerable/values-local.yaml"), "utf8")) as { id: { trustedOrigins: string[] } }
    const trustedOrigins = [...localValues.id.trustedOrigins, ...[directory.directory, directory.tenant].flatMap(({ issuer, tokenEndpoint }) => [issuer, new URL(tokenEndpoint).origin])]
    const extraEgress = [{ to: [{ ipBlock: { cidr: `${podHost}/32` } }], ports: directoryPorts.map(port => ({ port, protocol: "TCP" })) }]
    const staffDomain = directory.directory.domain
    /**
     * `helm upgrade --install` of charts/answerable, or of `chart`, as the pipeline runs it, with the local values, the
     * directories' settings, the staff domain and an Entra tenant for register (ID has no Microsoft client here, so register
     * adds the domain and skips the provider), and `sets`.
     */
    const release = (sets: string[], { timeout = helmTimeout, chart = join(charts, "answerable") } = {}) => helm([
      "upgrade", "--install", "answerable", chart, "--namespace", "answerable", "--values", join(charts, "answerable/values-local.yaml"),
      "--set-json", `id.trustedOrigins=${JSON.stringify(trustedOrigins)}`, "--set-json", `id.extraEgress=${JSON.stringify(extraEgress)}`,
      "--set", `id.staffDomain=${staffDomain}`, "--set", `id.entraTenant=${entraTenant}`,
      ...sets.flatMap(set => ["--set", set]), "--wait", "--wait-for-jobs", "--timeout", timeout,
    ])
    await step("install charts/answerable with the ops bootstrap", async () => {
      // What Terraform writes on Civo (trusted-proxies, postgres-admin, origin-tls) and what the deploy writes (id-env);
      // here, throwaway values. The ops Jobs write the rest, the database's certificate authority included: the bootstrap
      // fetches it. local-ca is the stack's alone.
      await apply("answerable", [
        configMap("trusted-proxies", { cidrs: "127.0.0.1/32" }),
        opaque("postgres-admin", { OPS_DATABASE_ADMIN_URL: `postgres://${databaseAdmin}:${secrets.admin}@${database}/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem` }),
        tls("origin-tls", certificates.publicNames),
        opaque("id-env", { BETTER_AUTH_SECRET: secrets.betterAuthSecret, ROOT_ADMIN_SECRET: secrets.rootAdminSecret }),
        configMap("local-ca", { "ca.pem": certificates.stackCa }),
      ])
      await release(["ops.bootstrap=true"])
    })
    // As deploy.ts run-job register does: one upgrade with the Job switched on. The Job starts the servers it registered.
    await step("run the ops register", async () => {
      await release(["ops.register=true"])
      for (const deployment of registered) await kubectl(["rollout", "status", "-n", "answerable", `deploy/${deployment}`, "--timeout=300s"])
    })
    /**
     * Build and load the next release (`nextRelease`): its chart, its list, and the sets that deploy its image, which `release` takes. The image
     * is the stack's mcps image with the Toolbox's new list, under {@link nextImage}.
     */
    async function next(change: Parameters<typeof nextRelease>[1]) {
      const prepared = await nextRelease(workdir, change)
      nextBuilt = true
      await exec(["docker", "build", "-t", nextImage, prepared.image])
      await exec(["kind", "load", "docker-image", nextImage, "--name", cluster])
      return { ...prepared, sets: [`images.mcps.repository=${nextImage.split(":")[0]}`] }
    }
    return {
      kubectl, helm, release, next, diagnose: (why: string) => diagnose(kubectl, helmOnly, why), kubeconfig, readSecret, secrets, stop, dockerGateway, podHost,
      directory: directory.directory, tenant: directory.tenant, certificates, stackCa: certificates.stackCa, originPullCert: certificates.originPullClient, edgeCert: certificates.publicNames,
    }
  } catch (error) {
    // Show what the cluster says before it goes.
    if (created && !diagnosed.has(error as object)) await diagnose(kubectl, helmOnly, `the stack failed to start: ${(error as Error).message.split("\n")[0]}`)
    await stop()
    throw error
  }
}

export type Stack = Awaited<ReturnType<typeof startStack>>
