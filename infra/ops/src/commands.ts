// The ops commands behind cli.ts, configured from OPS_* variables (infra/ops/README.md).
import { defineConfig, type Field } from "@answerable/config"
import { connect, declaredMcps, type Sql } from "@answerable/mcp-postgres"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { bootstrap } from "./bootstrap"
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

/**
 * The administrative connection: a `pg` pool through `connect`, so the URL's `sslrootcert` is verified (D5), and one connection of it, held
 * from the first statement to `close`, so that a transaction's statements all reach it.
 */
export function pgSql(url: string) {
  const { $client: pool } = connect(url, { max: 1 })
  const acquire = () => pool.connect()
  let client: ReturnType<typeof acquire> | undefined
  const sql: Sql = async (text, params = []) => (await (await (client ??= acquire())).query(text, params)).rows
  return {
    sql,
    async close() {
      ;(await client?.catch(() => undefined))?.release()
      await pool.end()
    },
  }
}

const COMMANDS = ["bootstrap", "register", "make-admin"] as const
const nonEmpty = z.string().min(1)
const origin = z.url().transform(url => url.replace(/\/+$/, ""))
// register's reading of the chart's list: each MCP's manifest scopes too, which its resource allows. bootstrap's reading (declaredMcps) checks the names.
const registeredMcps = z.string()
  .transform((text, context) => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      context.addIssue({ code: "custom", message: "Expected the chart's list of MCPs as JSON" })
      return z.NEVER
    }
  })
  .pipe(z.array(z.object({ name: nonEmpty, serve: z.enum(["toolbox", "standalone", "both"]), scopes: z.array(nonEmpty) })))
const opsFields = {
  OPS_NAMESPACE: { schema: nonEmpty.optional(), doc: "bootstrap and register: the namespace of the Secrets they write, read by src/kubernetes.ts; unset, the service account's", source: "chart" },
  OPS_DATABASE_ADMIN_URL: {
    schema: z.url().refine(url => new URL(url).searchParams.get("sslmode") === "verify-full", "Must ask for sslmode=verify-full"),
    secret: true,
    doc: "bootstrap: the managed database's administrative login (CREATEDB and CREATEROLE), a URL with sslmode=verify-full",
    source: "cluster",
  },
  OPS_DATABASE_SSLROOTCERT: { schema: nonEmpty, fallback: "/etc/ssl/db/ca.pem", doc: "bootstrap: where the chart mounts the database's certificate authority, for the services' URLs" },
  OPS_MCPS: {
    schema: declaredMcps,
    doc: "bootstrap and register: the MCPs charts/answerable/mcps.json declares, as JSON [{ name, serve, database, scopes }]: bootstrap provisions their schemas, roles and own databases, register each standalone or both one in ID",
    source: "chart",
  },
  OPS_ID_URL: { schema: origin, doc: "register and make-admin: ID's origin", source: "chart" },
  // A staff token when one is given (the chart reads it from the ops-staff-token Secret), else ID's root secret: what mints register's own client.
  OPS_ID_TOKEN: { schema: nonEmpty.optional(), secret: true, doc: "register: a staff token, used over OPS_ID_ROOT_SECRET, once, to mint register's own client when ID's root secret is locked and ops-id-client is empty", source: "operator" },
  OPS_ID_ROOT_SECRET: { schema: nonEmpty.optional(), secret: true, doc: "register and make-admin: ID's root secret, ROOT_ADMIN_SECRET; make-admin requires it, and register mints its own client with it when ops-id-client is empty and OPS_ID_TOKEN is unset", source: "deploy" },
  OPS_TOOLBOX_URL: { schema: origin, doc: "register: the Toolbox's origin", source: "chart" },
  OPS_ADMIN_MCP_URL: { schema: origin, doc: "register: the admin MCP's origin", source: "chart" },
  OPS_MCP_URL: { schema: origin, doc: "register: the standalone server's origin; <origin>/<name>/mcp is each standalone or both MCP's resource", source: "chart" },
  OPS_PLATFORM_SLUG: { schema: nonEmpty, fallback: "answerable", doc: "register and make-admin: the platform organisation's slug" },
  OPS_CLAUDE_CALLBACK_PORT: { schema: z.coerce.number().int().min(1).max(65535), fallback: "47700", doc: "register: the port of Claude Code's OAuth callback that the clients allow", source: "chart" },
  OPS_START_DEPLOYMENTS: {
    schema: z.string().regex(/^(\s*[a-z0-9-]+=\d+\s*)(,\s*[a-z0-9-]+=\d+\s*)*$/, "Expected name=replicas, comma-separated").optional(),
    doc: "register: the Deployments to start once their client secrets exist, name=replicas separated by commas",
    source: "chart",
  },
  OPS_STAFF_DOMAIN: {
    schema: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, "Expected a domain such as answerable.org").optional(),
    doc: "register: the staff email domain to connect to the platform organisation, with OPS_ENTRA_TENANT",
    source: "chart",
  },
  OPS_ENTRA_TENANT: {
    schema: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Expected the tenant's ID, a GUID (Entra admin centre, Overview)").optional(),
    doc: "register: the staff directory's Entra tenant ID, a GUID, with OPS_STAFF_DOMAIN",
    source: "chart",
  },
  OPS_ADMIN_EMAIL: { schema: z.email(), doc: "make-admin: the email of the staff member, signed in once, to make the first administrator", source: "chart" },
} satisfies Record<string, Field>
const pick = <Name extends keyof typeof opsFields>(...names: Name[]) => Object.fromEntries(names.map(name => [name, opsFields[name]])) as Pick<typeof opsFields, Name>

/** Every variable the ops Jobs read, for the inventory; each command reads its own below. */
export const opsConfig = defineConfig("ops", opsFields)
const bootstrapConfig = defineConfig("ops", pick("OPS_DATABASE_ADMIN_URL", "OPS_DATABASE_SSLROOTCERT", "OPS_MCPS"))
const registerConfig = defineConfig(
  "ops",
  {
    ...pick("OPS_ID_URL", "OPS_ID_TOKEN", "OPS_ID_ROOT_SECRET", "OPS_TOOLBOX_URL", "OPS_ADMIN_MCP_URL", "OPS_MCP_URL", "OPS_PLATFORM_SLUG", "OPS_CLAUDE_CALLBACK_PORT", "OPS_START_DEPLOYMENTS", "OPS_STAFF_DOMAIN", "OPS_ENTRA_TENANT"),
    OPS_MCPS: { ...opsFields.OPS_MCPS, schema: registeredMcps },
  },
  {
    refine(env, issue) {
      if (!env.OPS_STAFF_DOMAIN !== !env.OPS_ENTRA_TENANT) issue("OPS_ENTRA_TENANT", "OPS_STAFF_DOMAIN and OPS_ENTRA_TENANT go together: set both or neither")
    },
  },
)
const makeAdminConfig = defineConfig("ops", { ...pick("OPS_ID_URL", "OPS_PLATFORM_SLUG", "OPS_ADMIN_EMAIL"), OPS_ID_ROOT_SECRET: { ...opsFields.OPS_ID_ROOT_SECRET, schema: nonEmpty } })

/** `env` without its empty values, which every command treats as unset. */
const present = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""))

/**
 * bootstrap: the database's certificate authority (the ConfigMap's, or fetched and written on first use), then the
 * databases, logins and MCPs over connections that verify the database against it, the administrative URL's and one to
 * each database it provisions MCPs in. The authority reaches them as a file only its owner reads, deleted afterwards; the
 * services' URLs name `sslRootCert`, where the chart mounts the ConfigMap.
 */
async function runBootstrap(config: ReturnType<typeof bootstrapConfig.read>, env: Record<string, string | undefined>, deps: Deps) {
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
    const to = (name: string) => deps.database(Object.assign(new URL(admin), { pathname: `/${name}` }).toString())
    try {
      await bootstrap({ sql: database.sql, database: to, mcps: config.OPS_MCPS, store: createKubernetesSecretStore(kube), host, port, sslRootCert: config.OPS_DATABASE_SSLROOTCERT, log: deps.log })
    } finally {
      await database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function runRegister(config: ReturnType<typeof registerConfig.read>, env: Record<string, string | undefined>, deps: Deps) {
  const kube = deps.kubernetes(env)
  const staff = config.OPS_STAFF_DOMAIN && config.OPS_ENTRA_TENANT ? { domain: config.OPS_STAFF_DOMAIN.toLowerCase(), entraTenant: config.OPS_ENTRA_TENANT.toLowerCase() } : undefined
  await register({
    id: config.OPS_ID_URL, token: config.OPS_ID_TOKEN ?? config.OPS_ID_ROOT_SECRET, toolbox: config.OPS_TOOLBOX_URL, adminMcp: config.OPS_ADMIN_MCP_URL, mcpOrigin: config.OPS_MCP_URL,
    mcps: config.OPS_MCPS, platformSlug: config.OPS_PLATFORM_SLUG, callbackPort: config.OPS_CLAUDE_CALLBACK_PORT, staff, store: createKubernetesSecretStore(kube), fetch: deps.fetch, log: deps.log,
  })
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
      const config = bootstrapConfig.read(present(env))
      run = () => runBootstrap(config, env, deps)
    } else if (command === "register") {
      const config = registerConfig.read(present(env))
      run = () => runRegister(config, env, deps)
    } else {
      const config = makeAdminConfig.read(present(env))
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
