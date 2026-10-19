// The ops commands behind cli.ts, configured from OPS_* variables (infra/ops/README.md).
import { connect } from "@answerable/mcp-postgres"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { bootstrap, type Sql } from "./bootstrap"
import { databaseAuthority, type FetchChain } from "./database-ca"
import type { Kubernetes } from "./kubernetes"
import { makeAdmin } from "./make-admin"
import { register } from "./register"
import { createKubernetesSecretStore } from "./secret-store"

type Deps = {
  database: (url: string) => { sql: Sql; close: () => Promise<void> }
  kubernetes: (env: Record<string, string | undefined>) => Kubernetes
  fetchChain: FetchChain
  fetch: typeof globalThis.fetch
  log: (line: string) => void
  error: (line: string) => void
}

/** The administrative connection: Bun.SQL through `connect`, so the URL's `sslrootcert` is verified (D5), one connection, statements outside a transaction. */
export function bunSql(url: string) {
  const db = connect(url, { max: 1 })
  // A Bun.SQL query starts when awaited: awaiting it here hands callers an ordinary promise.
  const sql: Sql = async (text, params = []) => await db.unsafe(text, params)
  return { sql, close: () => db.close() }
}

const COMMANDS = ["bootstrap", "register", "make-admin"] as const
const nonEmpty = z.string().min(1)
const bootstrapEnv = z.object({
  OPS_DATABASE_ADMIN_URL: z.url().refine(url => new URL(url).searchParams.get("sslmode") === "verify-full", "Must ask for sslmode=verify-full"),
  OPS_DATABASE_SSLROOTCERT: nonEmpty.default("/etc/ssl/db/ca.pem"),
})
const origin = z.url().transform(url => url.replace(/\/+$/, ""))
const registerEnv = z.object({
  OPS_ID_URL: origin,
  // A staff token when one is given (the chart reads it from the ops-staff-token Secret), else ID's root secret.
  OPS_ID_TOKEN: nonEmpty.optional(),
  OPS_ID_ROOT_SECRET: nonEmpty.optional(),
  OPS_TOOLBOX_URL: origin,
  OPS_ADMIN_MCP_URL: origin,
  OPS_PLATFORM_SLUG: nonEmpty.default("answerable"),
  OPS_CLAUDE_CALLBACK_PORT: z.coerce.number().int().min(1).max(65535).default(47700),
  // name=replicas, comma-separated: Deployments to start from zero once their client secrets exist.
  OPS_START_DEPLOYMENTS: z.string().regex(/^(\s*[a-z0-9-]+=\d+\s*)(,\s*[a-z0-9-]+=\d+\s*)*$/, "Expected name=replicas, comma-separated").optional(),
  OPS_STAFF_DOMAIN: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "Expected a domain such as answerable.org").optional(),
  OPS_ENTRA_TENANT: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Expected the tenant's ID, a GUID (Entra admin centre, Overview)").optional(),
})
  .refine(env => env.OPS_ID_TOKEN ?? env.OPS_ID_ROOT_SECRET, { path: ["OPS_ID_TOKEN"], message: "Required: a staff token, or ID's root secret as OPS_ID_ROOT_SECRET" })
  .refine(env => !env.OPS_STAFF_DOMAIN === !env.OPS_ENTRA_TENANT, { path: ["OPS_ENTRA_TENANT"], message: "OPS_STAFF_DOMAIN and OPS_ENTRA_TENANT go together: set both or neither" })
const makeAdminEnv = z.object({
  OPS_ID_URL: origin,
  OPS_ID_ROOT_SECRET: nonEmpty,
  OPS_PLATFORM_SLUG: nonEmpty.default("answerable"),
  OPS_ADMIN_EMAIL: z.email(),
})

/** Parse `env` with `schema`, or throw naming each variable that is missing or invalid, never its value. */
function read<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>): z.output<T> {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""))
  const result = schema.safeParse(present)
  if (!result.success) throw new Error(result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  return result.data
}

/**
 * bootstrap: the database's certificate authority (the ConfigMap's, or fetched and written on first use), then the
 * databases and logins over a connection that verifies the database against it. The authority reaches that one
 * connection as a file only its owner reads, deleted afterwards; the services' URLs name `sslRootCert`, where the chart
 * mounts the ConfigMap.
 */
async function runBootstrap(config: z.output<typeof bootstrapEnv>, env: Record<string, string | undefined>, deps: Deps) {
  const kube = deps.kubernetes(env)
  const admin = new URL(config.OPS_DATABASE_ADMIN_URL)
  const host = admin.hostname.replace(/^\[|\]$/g, "")
  const port = Number(admin.port || 5432)
  const pem = await databaseAuthority({ kube, fetchChain: deps.fetchChain, host, port, log: deps.log })
  const directory = mkdtempSync(join(tmpdir(), "ops-database-ca-"))
  try {
    const file = join(directory, "ca.pem")
    writeFileSync(file, pem, { mode: 0o600 })
    admin.searchParams.set("sslrootcert", file)
    const database = deps.database(admin.toString())
    try {
      await bootstrap({ sql: database.sql, store: createKubernetesSecretStore(kube), host, port, sslRootCert: config.OPS_DATABASE_SSLROOTCERT, log: deps.log })
    } finally {
      await database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function runRegister(config: z.output<typeof registerEnv>, env: Record<string, string | undefined>, deps: Deps) {
  const kube = deps.kubernetes(env)
  const staff = config.OPS_STAFF_DOMAIN && config.OPS_ENTRA_TENANT ? { domain: config.OPS_STAFF_DOMAIN.toLowerCase(), entraTenant: config.OPS_ENTRA_TENANT.toLowerCase() } : undefined
  await register({ id: config.OPS_ID_URL, token: (config.OPS_ID_TOKEN ?? config.OPS_ID_ROOT_SECRET)!, toolbox: config.OPS_TOOLBOX_URL, adminMcp: config.OPS_ADMIN_MCP_URL, platformSlug: config.OPS_PLATFORM_SLUG, callbackPort: config.OPS_CLAUDE_CALLBACK_PORT, staff, store: createKubernetesSecretStore(kube), fetch: deps.fetch, log: deps.log })
  // The servers wait at zero replicas until their client secrets exist (charts/answerable); start them now that they do.
  for (const entry of config.OPS_START_DEPLOYMENTS?.split(",") ?? []) {
    const [name, count] = entry.trim().split("=") as [string, string]
    const replicas = await kube.replicas(name)
    if (replicas === undefined) deps.log(`${name}: no such Deployment`)
    else if (replicas > 0) deps.log(`${name}: already running`)
    else {
      await kube.setReplicas(name, Number(count))
      deps.log(`${name}: scaled from 0 to ${count}`)
    }
  }
}

/** Run one command; returns the exit code: 0 done, 1 failed, 2 wrong usage or configuration. */
export async function main(argv: string[], env: Record<string, string | undefined>, deps: Deps) {
  const [command] = argv
  let run: () => Promise<unknown>
  try {
    if (!COMMANDS.some(known => known === command)) throw new Error(`Usage: cli.ts ${COMMANDS.join(", ")}`)
    if (command === "bootstrap") {
      const config = read(bootstrapEnv, env)
      run = () => runBootstrap(config, env, deps)
    } else if (command === "register") {
      const config = read(registerEnv, env)
      run = () => runRegister(config, env, deps)
    } else {
      const config = read(makeAdminEnv, env)
      run = () => makeAdmin({ id: config.OPS_ID_URL, rootSecret: config.OPS_ID_ROOT_SECRET, email: config.OPS_ADMIN_EMAIL, platformSlug: config.OPS_PLATFORM_SLUG, fetch: deps.fetch, log: deps.log })
    }
  } catch (error) {
    deps.error(`${(error as Error).message}`)
    return 2
  }
  try {
    await run()
    return 0
  } catch (error) {
    deps.error(`${command} failed: ${(error as Error).message}`)
    return 1
  }
}
