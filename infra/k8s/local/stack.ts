import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDependencies, charts, helmEnv, repo } from "../helm"

/** The kind cluster's name: one stack per machine at a time. */
const cluster = "answerable-local"
const here = join(repo, "infra/k8s/local")

/** The public names: 127.0.0.1 on the laptop through public DNS, the edge inside the cluster through /etc/hosts. */
export const hosts = { id: "id.127-0-0-1.sslip.io", toolbox: "toolbox.127-0-0-1.sslip.io", adminMcp: "admin-mcp.127-0-0-1.sslip.io" }
export const origin = (host: string) => `https://${host}:48443`

/** The three images, built from the repository root and loaded into the cluster under the local tag. */
export const images = [
  { name: "id", dockerfile: "apps/id/Dockerfile" },
  { name: "toolbox", dockerfile: "mcps/toolbox/Dockerfile" },
  { name: "admin-mcp", dockerfile: "mcps/admin/Dockerfile" },
] as const
export const image = (name: string) => `ghcr.io/rieranthony/answerable/${name}:local`

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
async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    timings.push([name, Math.round((performance.now() - started) / 100) / 10])
  }
}

/** Every value the stack generates for itself; nothing here outlives the cluster. */
function generateSecrets() {
  return {
    superuser: secret(),
    passwords: { idOwner: secret(), idRuntime: secret(), toolboxOwner: secret(), toolboxRuntime: secret(), adminOwner: secret(), adminRuntime: secret() },
    rootAdminSecret: `${secret()}${secret()}`,
    betterAuthSecret: `${secret()}${secret()}`,
    upstreamKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  }
}

const databaseUrl = (login: string, password: string, database: string) =>
  `postgres://${login}:${password}@postgres.database.svc.cluster.local:5432/${database}?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`

/** The kind stack: build, create, install, and the handles the proofs use. `stop` deletes the cluster. */
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
  const stop = async () => {
    if (created && !process.env.INFRA_STACK_KEEP) await exec(["kind", "delete", "cluster", "--name", cluster, "--kubeconfig", kubeconfig], { allowFailure: true })
    rmSync(workdir, { recursive: true, force: true })
  }

  const existing = await exec(["kind", "get", "clusters"])
  if (existing.stdout.split("\n").includes(cluster)) throw new Error(`The kind cluster ${cluster} exists: another stack is running, or a run left it behind. Delete it with: kind delete cluster --name ${cluster}`)

  try {
    const revision = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim()
    // The images build while the cluster and its platform come up.
    const built = step("build the three images", () => Promise.all(images.map(({ name, dockerfile }) =>
      exec(["docker", "build", "-f", dockerfile, "-t", image(name), "--build-arg", `REVISION=${revision}`, "."]))))
    built.catch(() => {})
    await step("create the kind cluster", async () => {
      created = true
      await exec(["kind", "create", "cluster", "--config", join(here, "kind.yaml"), "--kubeconfig", kubeconfig, "--wait", "180s"])
    })
    // Terraform creates the namespaces in a cloud, with the restricted Pod Security Standard enforced on answerable.
    await kubectl(["create", "namespace", "platform"])
    await kubectl(["create", "namespace", "database"])
    await apply("default", [{ apiVersion: "v1", kind: "Namespace", metadata: { name: "answerable", labels: { "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/warn": "restricted", "pod-security.kubernetes.io/audit": "restricted" } } }])
    await step("install charts/platform", async () => {
      buildDependencies("platform")
      await helm(["upgrade", "--install", "platform", join(charts, "platform"), "--namespace", "platform", "--values", join(charts, "platform/values-local.yaml"), "--wait", "--timeout", "10m"])
    })
    await step("start the database and the edge", async () => {
      const { passwords } = secrets
      await apply("database", [{ apiVersion: "v1", kind: "Secret", metadata: { name: "postgres-bootstrap" }, stringData: {
        SUPERUSER_PASSWORD: secrets.superuser, ID_OWNER_PASSWORD: passwords.idOwner, ID_RUNTIME_PASSWORD: passwords.idRuntime, TOOLBOX_OWNER_PASSWORD: passwords.toolboxOwner,
        TOOLBOX_RUNTIME_PASSWORD: passwords.toolboxRuntime, ADMIN_OWNER_PASSWORD: passwords.adminOwner, ADMIN_RUNTIME_PASSWORD: passwords.adminRuntime,
      } }])
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
    await step("install charts/answerable", async () => {
      const { passwords } = secrets
      const opaque = (name: string, data: Record<string, string>) => ({ apiVersion: "v1", kind: "Secret", metadata: { name }, type: "Opaque", stringData: data })
      // What the deploy applies from the sops file and the ops Jobs write in a cloud; here, throwaway values.
      await apply("answerable", [
        opaque("id-env", { BETTER_AUTH_SECRET: secrets.betterAuthSecret, ROOT_ADMIN_SECRET: secrets.rootAdminSecret, UPSTREAM_TOKEN_SECRETS: JSON.stringify([{ version: 1, value: secrets.upstreamKey }]) }),
        opaque("id-database", { DATABASE_URL: databaseUrl("answerable_id_runtime", passwords.idRuntime, "answerable_id") }),
        opaque("id-database-owner", { DATABASE_MIGRATION_URL: databaseUrl("answerable_id_owner", passwords.idOwner, "answerable_id") }),
        opaque("toolbox-database", { TOOLBOX_DATABASE_URL: databaseUrl("answerable_toolbox_runtime", passwords.toolboxRuntime, "answerable_toolbox") }),
        opaque("toolbox-database-owner", { TOOLBOX_DATABASE_MIGRATION_URL: databaseUrl("answerable_toolbox_owner", passwords.toolboxOwner, "answerable_toolbox") }),
        opaque("admin-database", { ADMIN_DATABASE_URL: databaseUrl("answerable_admin_runtime", passwords.adminRuntime, "answerable_admin") }),
        opaque("admin-database-owner", { ADMIN_DATABASE_MIGRATION_URL: databaseUrl("answerable_admin_owner", passwords.adminOwner, "answerable_admin") }),
        // ID does not know these clients until the ops register Job exists (brief B3): the Toolbox's grants poller fails and says so.
        opaque("toolbox-id-client", { TOOLBOX_ID_CLIENT_SECRET: secret() }),
        opaque("admin-id-client", { ADMIN_ID_CLIENT_SECRET: secret() }),
        opaque("cloudflare-origin-pull-ca", { "ca.crt": originPullCa }),
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "postgres-ca" }, data: { "ca.pem": databaseCa } },
        { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "local-ca" }, data: { "ca.pem": stackCa } },
      ])
      await helm(["upgrade", "--install", "answerable", join(charts, "answerable"), "--namespace", "answerable", "--values", join(charts, "answerable/values-local.yaml"), "--wait", "--timeout", "10m"])
    })
    const client = await readSecret("platform", "edge-origin-pull")
    const edgeServer = await readSecret("platform", "edge-tls")
    return { kubectl, helm, kubeconfig, readSecret, secrets, stop, stackCa, databaseCa, originPullCert: { cert: client["tls.crt"], key: client["tls.key"] }, otherCert: { cert: edgeServer["tls.crt"], key: edgeServer["tls.key"] } }
  } catch (error) {
    if (created) {
      // Show what the cluster says before it goes.
      const pods = await kubectl(["get", "pods", "-A", "-o", "wide"], { allowFailure: true })
      const events = await kubectl(["get", "events", "-A", "--sort-by=.lastTimestamp"], { allowFailure: true })
      console.error(pods.stdout, events.stdout.split("\n").slice(-40).join("\n"))
    }
    await stop()
    throw error
  }
}

export type Stack = Awaited<ReturnType<typeof startStack>>
