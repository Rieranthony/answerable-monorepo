// The ops commands behind cli.ts, configured from OPS_* variables (infra/ops/README.md).
import { connect } from "@answerable/mcp-postgres"
import { z } from "zod"
import { bootstrap, type Sql } from "./bootstrap"
import type { Kubernetes } from "./kubernetes"
import { register } from "./register"
import { createFileSecretStore, createKubernetesSecretStore } from "./secret-store"

type Deps = {
  database: (url: string) => { sql: Sql; close: () => Promise<void> }
  kubernetes: (env: Record<string, string | undefined>) => Kubernetes
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

const nonEmpty = z.string().min(1)
const store = z.object({
  OPS_STORE: z.enum(["kubernetes", "file"]).default("kubernetes"),
  OPS_SECRETS_FILE: nonEmpty.optional(),
}).refine(env => env.OPS_STORE !== "file" || env.OPS_SECRETS_FILE, { path: ["OPS_SECRETS_FILE"], message: "Required with OPS_STORE=file" })
const bootstrapEnv = z.object({
  OPS_DATABASE_ADMIN_URL: z.url(),
  OPS_DATABASE_HOST: nonEmpty.optional(),
  OPS_DATABASE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  OPS_DATABASE_SSLROOTCERT: nonEmpty.default("/etc/ssl/db/ca.pem"),
})
const origin = z.url().transform(url => url.replace(/\/+$/, ""))
const registerEnv = z.object({
  OPS_ID_URL: origin,
  OPS_ID_TOKEN: nonEmpty,
  OPS_TOOLBOX_URL: origin,
  OPS_ADMIN_MCP_URL: origin,
  OPS_PLATFORM_SLUG: nonEmpty.default("answerable"),
  OPS_CLAUDE_CALLBACK_PORT: z.coerce.number().int().min(1).max(65535).default(47700),
  // name=replicas, comma-separated: Deployments to start from zero once their client secrets exist.
  OPS_START_DEPLOYMENTS: z.string().regex(/^(\s*[a-z0-9-]+=\d+\s*)(,\s*[a-z0-9-]+=\d+\s*)*$/, "Expected name=replicas, comma-separated").optional(),
})

/** Parse `env` with `schema`, or throw naming each variable that is missing or invalid, never its value. */
function read<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>): z.output<T> {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""))
  const result = schema.safeParse(present)
  if (!result.success) throw new Error(result.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  return result.data
}

/** Run one command; returns the exit code: 0 done, 1 failed, 2 wrong usage or configuration. */
export async function main(argv: string[], env: Record<string, string | undefined>, deps: Deps) {
  const [command] = argv
  try {
    if (command !== "bootstrap" && command !== "register") throw new Error("Usage: cli.ts bootstrap or register")
    const storeEnv = read(store, env)
    const settings = read(command === "bootstrap" ? bootstrapEnv : registerEnv, env)
    const kube = storeEnv.OPS_STORE === "kubernetes" ? deps.kubernetes(env) : undefined
    const secrets = kube ? createKubernetesSecretStore(kube) : createFileSecretStore(storeEnv.OPS_SECRETS_FILE!)
    try {
      if (command === "bootstrap") {
        const config = settings as z.output<typeof bootstrapEnv>
        const admin = new URL(config.OPS_DATABASE_ADMIN_URL)
        const database = deps.database(config.OPS_DATABASE_ADMIN_URL)
        try {
          await bootstrap({
            sql: database.sql,
            store: secrets,
            host: config.OPS_DATABASE_HOST ?? admin.hostname.replace(/^\[|\]$/g, ""),
            port: config.OPS_DATABASE_PORT ?? Number(admin.port || 5432),
            sslRootCert: config.OPS_DATABASE_SSLROOTCERT,
            log: deps.log,
          })
        } finally {
          await database.close()
        }
      } else {
        const config = settings as z.output<typeof registerEnv>
        await register({ id: config.OPS_ID_URL, token: config.OPS_ID_TOKEN, toolbox: config.OPS_TOOLBOX_URL, adminMcp: config.OPS_ADMIN_MCP_URL, platformSlug: config.OPS_PLATFORM_SLUG, callbackPort: config.OPS_CLAUDE_CALLBACK_PORT, store: secrets, fetch: deps.fetch, log: deps.log })
        // The servers wait at zero replicas until their client secrets exist (charts/answerable); start them now that they do.
        for (const entry of config.OPS_START_DEPLOYMENTS?.split(",") ?? []) {
          const [name, count] = entry.trim().split("=") as [string, string]
          const replicas = await kube!.replicas(name)
          if (replicas === undefined) deps.log(`${name}: no such Deployment`)
          else if (replicas > 0) deps.log(`${name}: already running`)
          else {
            await kube!.setReplicas(name, Number(count))
            deps.log(`${name}: started with ${count} replicas`)
          }
        }
      }
    } catch (error) {
      deps.error(`${command} failed: ${(error as Error).message}`)
      return 1
    }
    return 0
  } catch (error) {
    deps.error(`${(error as Error).message}`)
    return 2
  }
}
